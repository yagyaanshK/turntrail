import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportHandoff, initStore, readAllTurns, readManifest } from '../src/index.js';
import { importCodexSession } from '../src/adapters/codex.js';
import { importClaudeSession } from '../src/adapters/claude-code.js';
import { findLastCompaction, importSignature } from '../src/adapters/common.js';

// An agent that has compacted a thread holds a summary of what came before
// plus what came after; the native file still holds everything. Importing
// from the last compaction gives the receiver the agent's own view and keeps
// a long thread's import to its live part. Shapes are from real transcripts:
// a Codex 0.162 rollout whose compaction summary is encrypted, and a Claude
// Code 2.x session whose summary is a flagged user message.

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-compaction-'));
}

const stamp = (n) => `2026-11-07T10:${String(n).padStart(2, '0')}:00.000Z`;
const userItem = (text, createTime) => ({
  type: 'message',
  id: `msg_${text.length}`,
  role: 'user',
  content: [{ type: 'input_text', text }],
  ...(createTime ? { internal_chat_message_metadata_passthrough: { create_time: createTime } } : {})
});
const assistantItem = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const wrap = (n, type, payload) => JSON.stringify({ timestamp: stamp(n), ordinal: n, type, payload });

function codexRollout(root, { encrypted = true, padding = 0 } = {}) {
  const retained = [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>sandboxed</permissions instructions>' }] },
    userItem('Shortlist the supervisors', 1794000000),
    encrypted
      ? { type: 'compaction', encrypted_content: 'gAAAA'.repeat(8) }
      : { type: 'compaction', summary: 'The user wants a shortlist; three names were found.' },
    userItem('Add their recent papers', 1794000600)
  ];
  const compacted = (n, window) => wrap(n, 'compacted', {
    message: '',
    replacement_history: retained,
    window_number: window,
    retained_context: { user_messages: [] },
    padding: 'x'.repeat(padding)
  });
  return [
    wrap(0, 'session_meta', { id: 'codex-thread', cwd: root, originator: 'codex_vscode', cli_version: '0.162.0' }),
    wrap(1, 'response_item', userItem('Shortlist the supervisors')),
    wrap(2, 'response_item', assistantItem('Found three.')),
    compacted(3, 1),
    wrap(4, 'response_item', userItem('Add their recent papers')),
    wrap(5, 'response_item', assistantItem('Added the papers.')),
    compacted(6, 2),
    wrap(7, 'response_item', userItem('Now draft the outreach mail')),
    wrap(8, 'response_item', assistantItem('Drafted the mail.'))
  ].join('\n');
}

async function codexSession(root, content) {
  const file = path.join(root, 'rollout-2026-11-07T10-00-00-codex-thread.jsonl');
  await fs.writeFile(file, content);
  const stat = await fs.stat(file);
  return { path: file, sessionId: 'codex-thread', cwd: root, surface: 'vscode', size: stat.size, mtimeMs: stat.mtimeMs, title: 'cv - US PhD apply', named: true };
}

test('a compacted Codex thread imports from its last compaction: retained requests, a note, and everything since', async () => {
  const root = await tempRoot();
  await initStore(root);
  // The last compaction record is longer than the reader buffers, as real ones
  // are past 8 MiB; it is still read whole, and the earlier one never parsed.
  const session = await codexSession(root, codexRollout(root, { padding: 2000 }));
  const result = await importCodexSession(root, session, { maxLineChars: 1500 });

  const turns = await readAllTurns(root);
  assert.deepEqual(
    turns.map((turn) => `${turn.role}: ${turn.content.slice(0, 40)}`),
    [
      'user: Shortlist the supervisors',
      'user: Add their recent papers',
      'system: Codex compacted this thread at this poin',
      'user: Now draft the outreach mail',
      'assistant: Drafted the mail.'
    ]
  );
  // Retained requests keep the time Codex recorded for them, so they sort
  // before the compaction, and all of this points at the compaction's line.
  assert.equal(turns[0].timestamp, new Date(1794000000 * 1000).toISOString());
  assert.equal(turns[0].metadata.retainedAtCompaction, true);
  assert.equal(turns[0].metadata.lineNumber, 7);
  assert.match(turns[2].content, /\(context window 2\), having been compacted 1 time before\. Its summary of everything before is encrypted and only Codex can read it; the 2 user requests it retained verbatim are included above/);
  assert.deepEqual(turns[2].metadata.compaction, { windowNumber: 2, retained: 2, summary: 'encrypted' });
  assert.equal(turns[3].metadata.lineNumber, 8);
  assert.equal(result.turnCount, 5);

  const entry = (await readManifest(root)).sessions.find((item) => item.id === 'native-codex-codex-thread');
  assert.deepEqual(entry.importedFrom, { compactionLine: 7, compactions: 2 });
  assert.equal(entry.importSignature, 'from-compaction');

  const exported = await exportHandoff(root, { target: 'claude' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /native session `codex-thread`; imported from its last compaction point at line 7, so earlier turns are only in this file\)/);
});

test('a summary written in the clear, as older Codex builds did, is kept as a turn', async () => {
  const root = await tempRoot();
  await initStore(root);
  const session = await codexSession(root, codexRollout(root, { encrypted: false }));
  await importCodexSession(root, session, {});
  const turns = await readAllTurns(root);
  assert.equal(turns[2].role, 'system');
  assert.match(turns[2].content, /Its own summary of everything before follows as the next turn/);
  assert.equal(turns[3].role, 'assistant');
  assert.equal(turns[3].content, 'Summary of the thread up to its compaction, written by Codex:\n\nThe user wants a shortlist; three names were found.');
  assert.equal(turns[3].metadata.compactionSummary, true);
});

test('whole-thread import is still there, and is told apart from a compaction import', async () => {
  const root = await tempRoot();
  await initStore(root);
  const session = await codexSession(root, codexRollout(root));
  await importCodexSession(root, session, { fromLastCompaction: false });
  const turns = await readAllTurns(root);
  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(turns.some((turn) => turn.metadata.nativeType === 'compacted'), false);
  const entry = (await readManifest(root)).sessions[0];
  assert.equal(entry.importedFrom, undefined);
  assert.equal(entry.importSignature, undefined);

  assert.equal(importSignature({}), 'from-compaction');
  assert.equal(importSignature({ fromLastCompaction: false }), '');
  assert.equal(importSignature({ subagentTranscripts: true }), 'from-compaction+subagent-transcripts');
  assert.equal(importSignature({ fromLastCompaction: false, subagentTranscripts: true }), 'subagent-transcripts');
});

test('a thread never compacted imports from the top, with nothing recorded about compaction', async () => {
  const root = await tempRoot();
  await initStore(root);
  const session = await codexSession(root, [
    wrap(0, 'session_meta', { id: 'codex-thread', cwd: root }),
    wrap(1, 'response_item', userItem('Shortlist the supervisors')),
    wrap(2, 'response_item', assistantItem('Found three.'))
  ].join('\n'));
  assert.equal(await findLastCompaction(session.path, (line) => line.includes('"compacted"')), undefined);
  await importCodexSession(root, session, {});
  const entry = (await readManifest(root)).sessions[0];
  assert.equal(entry.importedFrom, undefined);
  assert.equal(entry.turnCount, 2);
});

test('a compacted Claude Code session imports from the summary Claude wrote and everything since', async () => {
  const root = await tempRoot();
  await initStore(root);
  const base = { cwd: root, sessionId: 'claude-session', version: '2.1.80', isSidechain: false };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', timestamp: stamp(1), message: { role: 'user', content: 'Shortlist the supervisors' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: stamp(2), message: { role: 'assistant', content: [{ type: 'text', text: 'Found three.' }] } },
    { ...base, type: 'system', subtype: 'compact_boundary', uuid: 's1', timestamp: stamp(3), content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 180000 } },
    { ...base, type: 'user', uuid: 'u2', timestamp: stamp(4), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n1. The user wants a shortlist; three names were found.' } },
    { ...base, type: 'user', uuid: 'u3', timestamp: stamp(5), message: { role: 'user', content: 'Now draft the outreach mail, mentioning "isCompactSummary":true as a literal' } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: stamp(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Drafted the mail.' }] } }
  ].map((line) => JSON.stringify(line)).join('\n');
  const file = path.join(root, 'claude-session.jsonl');
  await fs.writeFile(file, lines);
  const stat = await fs.stat(file);
  const session = { path: file, sessionId: 'claude-session', cwd: root, size: stat.size, mtimeMs: stat.mtimeMs, title: 'Shortlist', named: false };

  await importClaudeSession(root, session, {});
  const turns = await readAllTurns(root);
  assert.deepEqual(
    turns.map((turn) => `${turn.role}: ${turn.content.slice(0, 30)}`),
    ['user: This session is being continue', 'user: Now draft the outreach mail, m', 'assistant: Drafted the mail.']
  );
  assert.equal(turns[0].metadata.lineNumber, 4);
  const entry = (await readManifest(root)).sessions.find((item) => item.id === 'native-claude-claude-session');
  // The literal in the later message is escaped in the file, so the last
  // compaction is the real one.
  assert.deepEqual(entry.importedFrom, { compactionLine: 4, compactions: 1 });

  // The whole session: the boundary record itself carries no message and is no turn.
  await importClaudeSession(root, session, { fromLastCompaction: false });
  assert.deepEqual((await readAllTurns(root)).map((turn) => turn.role), ['user', 'assistant', 'user', 'user', 'assistant']);
});
