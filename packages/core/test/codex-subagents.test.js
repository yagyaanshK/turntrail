import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeSessions, initStore, listSessionIndex } from '../src/index.js';
import { codexParentThread } from '../src/adapters/codex.js';

// Codex 2026 builds run each subagent in a thread of its own, written to its
// own rollout beside the parent's. A long task spawns dozens, each titled by
// the parent's instructions, and listed as chats they crowd out the ones the
// user actually had. Discovery marks them so the panel can fold them away.

const userItem = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

function rollout(root, id, meta, request) {
  return [
    { timestamp: '2026-11-06T18:14:59.172Z', type: 'session_meta', payload: { id, cwd: root, originator: 'codex_vscode', cli_version: '0.162.0', ...meta } },
    { timestamp: '2026-11-06T18:15:00.000Z', type: 'response_item', payload: userItem(request) },
    { timestamp: '2026-11-06T18:15:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }
  ].map((line) => JSON.stringify(line)).join('\n');
}

test('a Codex thread spawned for a subagent is discovered as one, with its parent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-subagents-'));
  const sessionsDir = path.join(root, 'sessions', '2026', '11', '06');
  await fs.mkdir(sessionsDir, { recursive: true });
  const parent = '01a0761d-289a-7ab1-8694-99ce64a029b2';
  const child = '01a1b212-2dd5-7c33-9b61-247354f917f8';
  await fs.writeFile(
    path.join(sessionsDir, `rollout-2026-11-06T18-00-00-${parent}.jsonl`),
    rollout(root, parent, {}, 'Check the shortlisted supervisors')
  );
  await fs.writeFile(
    path.join(sessionsDir, `rollout-2026-11-06T18-14-59-${child}.jsonl`),
    rollout(root, child, {
      session_id: parent,
      parent_thread_id: parent,
      thread_source: 'subagent',
      agent_nickname: 'Turing',
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: 'Turing' } } }
    }, 'Task: public-source faculty due-diligence for shortlisted US PhD supervisors.')
  );

  const sessions = await discoverNativeSessions('codex', { root, sessionsDir: path.join(root, 'sessions'), all: true });
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  assert.equal(byId.get(parent).subagent, undefined);
  assert.equal(byId.get(parent).parentSessionId, undefined);
  assert.equal(byId.get(child).subagent, true);
  assert.equal(byId.get(child).parentSessionId, parent);
  assert.equal(byId.get(child).surface, 'subagent · thread_spawn');

  // The panel's rows carry the flag; nothing else about the row changes, so a
  // subagent thread can still be viewed, imported and handed off.
  await initStore(root);
  const index = await listSessionIndex(root, { all: true, discoveryOptions: { codex: { sessionsDir: path.join(root, 'sessions') } } });
  const rows = new Map(index.sessions.filter((row) => row.provider === 'codex').map((row) => [row.sessionId, row]));
  assert.equal(rows.get(parent).subagent, undefined);
  assert.equal(rows.get(child).subagent, true);
  assert.match(rows.get(child).title, /^Task: public-source faculty/);
});

test('the parent thread is read from whichever field a Codex build wrote it in', () => {
  assert.equal(codexParentThread({ parent_thread_id: 'p1' }), 'p1');
  assert.equal(codexParentThread({ source: { subagent: { thread_spawn: { parent_thread_id: 'p2' } } } }), 'p2');
  assert.equal(codexParentThread({ source: { subagent: { other: 'review' } } }), 'unknown');
  assert.equal(codexParentThread({ thread_source: 'subagent' }), 'unknown');
  assert.equal(codexParentThread({ source: 'cli' }), undefined);
  assert.equal(codexParentThread({ source: { vscode: {} }, forked_from_id: 'f' }), undefined);
  assert.equal(codexParentThread(undefined), undefined);
});
