import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collapseCodexStreamDuplicates,
  dedupeAdjacentTurns,
  discoverNativeSessions,
  exportHandoff,
  importNativeSession,
  importTranscript,
  initStore,
  prepareTurns,
  pruneLedgerEntries,
  readAllTurns,
  readAttachment,
  readManifest,
  renderHandoff,
  sanitizeContentForHandoff,
  selectTurns,
  summarizeSession,
  truncateTurnContent,
  writeSession,
  writeSnapshot,
  DEFAULT_MAX_CHARS
} from '../src/index.js';

test('imports jsonl transcripts and exports deterministic handoff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-core-'));
  await initStore(root);
  await fs.writeFile(
    path.join(root, 'transcript.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'Please inspect auth.' }),
      JSON.stringify({ role: 'assistant', content: 'I found src/auth.js.' })
    ].join('\n'),
    'utf8'
  );

  const imported = await importTranscript(root, 'transcript.jsonl', { provider: 'claude', surface: 'cli' });
  assert.equal(imported.turnCount, 2);

  const turns = await readAllTurns(root);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].provider, 'anthropic');

  const exported = await exportHandoff(root, { target: 'codex' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /Turntrail Handoff: codex/);
  assert.match(handoff, /Distinguish established facts, explicit user decisions, unresolved questions/);
  assert.match(handoff, /Do not inherit the previous agent's confidence, session-specific permissions or approvals, or completion claims/);
  assert.match(handoff, /ask the user only when a consequential ambiguity remains/);
  assert.match(handoff, /Please inspect auth/);
});

test('budgeted turn selection keeps user turns first', () => {
  const turns = [
    { role: 'assistant', content: 'a'.repeat(1000), timestamp: '1' },
    { role: 'user', content: 'keep me', timestamp: '2' },
    { role: 'tool', content: 'b'.repeat(1000), timestamp: '3' }
  ];
  const selected = selectTurns(turns, 300);
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.turns[0].role, 'user');
  assert.equal(selected.omittedTurns, 2);
});

test('budgeted selection prefers recent turns and stops instead of skipping', () => {
  const turns = [
    { role: 'tool', content: 'old-small', timestamp: '1' },
    { role: 'tool', content: 'x'.repeat(4000), timestamp: '2' },
    { role: 'tool', content: 'recent-small', timestamp: '3' }
  ];
  const selected = selectTurns(turns, 400);
  // The oversized middle turn must act as a wall: the newest turn fits, and
  // filling stops there rather than reaching past the gap for `old-small`.
  // Skipping it would produce a transcript with an invisible hole.
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.turns[0].content, 'recent-small');
  assert.equal(selected.omittedTurns, 2);
});

test('budgeted selection returns turns in chronological order', () => {
  const turns = [
    { role: 'user', content: 'first', timestamp: '1' },
    { role: 'assistant', content: 'second', timestamp: '2' },
    { role: 'user', content: 'third', timestamp: '3' }
  ];
  const selected = selectTurns(turns, 100000);
  assert.deepEqual(selected.turns.map((turn) => turn.content), ['first', 'second', 'third']);
  assert.equal(selected.omittedTurns, 0);
});

test('budget measures truncated rendered size, not raw turn size', () => {
  // A 50 KB tool turn renders to well under 2 KB once the tool cap applies. The
  // old accounting sized the raw turn (plus never-rendered metadata) and so
  // rejected turns that comfortably fit.
  const turns = [{ role: 'tool', content: 'y'.repeat(50000), timestamp: '1', metadata: { padding: 'z'.repeat(5000) } }];
  const truncation = { tool: 2000 };
  const [prepared] = prepareTurns(turns, truncation);
  assert.ok(prepared.size < 2500, `rendered size was ${prepared.size}`);

  const selected = selectTurns(turns, 3000, truncation);
  assert.equal(selected.turns.length, 1);
  assert.equal(selected.omittedTurns, 0);
});

test('prepareTurns sanitizes and truncates each turn exactly once', () => {
  const turns = [{ role: 'tool', content: 'HEAD' + 'm'.repeat(9000) + 'TAIL', timestamp: '1' }];
  const [prepared] = prepareTurns(turns, { tool: 500 });
  assert.ok(prepared.truncatedChars > 0);
  assert.equal(prepared.size, prepared.block.length + 1);
  assert.match(prepared.block, /Turntrail truncated \d+ chars/);
  // One truncation marker means one truncation pass.
  assert.equal(prepared.block.split('Turntrail truncated').length - 1, 1);
});

test('export applies a default character budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-budget-'));
  await initStore(root);
  // Uncapped roles, so only the total budget can hold this down.
  const turns = Array.from({ length: 400 }, (_, index) => ({
    role: 'assistant',
    content: `message ${index} ${'q'.repeat(1000)}`,
    provider: 'openai',
    surface: 'cli',
    timestamp: String(index).padStart(4, '0')
  }));
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'budget-test' });

  const exported = await exportHandoff(root, { target: 'claude' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.ok(handoff.length <= DEFAULT_MAX_CHARS + 4000, `handoff was ${handoff.length} chars`);
  assert.match(handoff, /Export max chars: 120000/);
  assert.match(handoff, /Omitted turns due to budget: \d+/);
  // Recency wins: the last message survives, the first does not.
  assert.match(handoff, /message 399/);
  assert.doesNotMatch(handoff, /message 0 /);
});

test('export honours an explicitly disabled budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-nobudget-'));
  await initStore(root);
  const turns = Array.from({ length: 200 }, (_, index) => ({
    role: 'assistant',
    content: `message ${index} ${'q'.repeat(1000)}`,
    provider: 'openai',
    surface: 'cli',
    timestamp: String(index).padStart(4, '0')
  }));
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'nobudget-test' });

  const exported = await exportHandoff(root, { target: 'claude', maxChars: 0 });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /message 0 /);
  assert.match(handoff, /message 199/);
  assert.doesNotMatch(handoff, /Omitted turns due to budget/);
});

test('sinceLastExport limits the transcript to turns after the previous export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-since-'));
  await initStore(root);
  await writeSession(
    root,
    [{ role: 'user', content: 'before the export', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' }],
    { provider: 'openai', surface: 'cli', sessionId: 'since-a' }
  );
  await exportHandoff(root, { target: 'claude' });

  await writeSession(
    root,
    [
      { role: 'user', content: 'before the export', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' },
      { role: 'user', content: 'after the export', provider: 'openai', surface: 'cli', timestamp: '2099-01-01T00:00:00.000Z' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'since-a' }
  );

  const scoped = await fs.readFile((await exportHandoff(root, { target: 'claude', sinceLastExport: true })).path, 'utf8');
  assert.match(scoped, /after the export/);
  assert.doesNotMatch(scoped, /```text\nbefore the export\n```/);
  assert.match(scoped, /Transcript limited to turns after:/);

  // Default stays off, so a fresh receiving session still gets the full ledger.
  const full = await fs.readFile((await exportHandoff(root, { target: 'claude' })).path, 'utf8');
  assert.match(full, /before the export/);
  assert.match(full, /after the export/);
});

test('sinceLastExport falls back to the full ledger when nothing is newer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-since-empty-'));
  await initStore(root);
  await writeSession(
    root,
    [{ role: 'user', content: 'only turn', provider: 'openai', surface: 'cli', timestamp: '2020-01-01T00:00:00.000Z' }],
    { provider: 'openai', surface: 'cli', sessionId: 'since-b' }
  );
  await exportHandoff(root, { target: 'claude' });

  const handoff = await fs.readFile((await exportHandoff(root, { target: 'claude', sinceLastExport: true })).path, 'utf8');
  assert.match(handoff, /only turn/);
  assert.doesNotMatch(handoff, /Transcript limited to turns after:/);
});

test('re-importing the same session upserts its manifest entry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-upsert-'));
  await initStore(root);
  const turns = [{ role: 'user', content: 'hello', provider: 'openai', surface: 'cli', timestamp: '1' }];
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'same-id' });

  const manifest = await readManifest(root);
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.sessions[0].id, 'same-id');
  // A different session id still creates a separate entry.
  await writeSession(root, turns, { provider: 'openai', surface: 'cli', sessionId: 'other-id' });
  const after = await readManifest(root);
  assert.equal(after.sessions.length, 2);
});

test('dedupeAdjacentTurns collapses only consecutive identical turns', () => {
  const turns = [
    { role: 'assistant', content: 'Working on it', timestamp: '1' },
    { role: 'assistant', content: 'Working on it', timestamp: '1' },
    { role: 'assistant', content: 'Working on it', timestamp: '2' },
    { role: 'tool', content: '', timestamp: '3' },
    { role: 'assistant', content: 'Different', timestamp: '4' },
    { role: 'tool', content: '', timestamp: '5' }
  ];
  const { turns: deduped, removed } = dedupeAdjacentTurns(turns);
  assert.equal(removed, 2);
  assert.equal(deduped.length, 4);
  // The two non-adjacent empty tool turns are distinct events and must survive.
  assert.equal(deduped.filter((t) => t.role === 'tool').length, 2);
});

test('truncateTurnContent keeps head and tail and reports removed chars', () => {
  const text = 'HEAD'.repeat(50) + 'MIDDLE'.repeat(200) + 'TAIL'.repeat(50);
  const result = truncateTurnContent(text, 400);
  assert.ok(result.removed > 0);
  assert.ok(result.content.length < text.length);
  assert.match(result.content, /^HEAD/);
  assert.match(result.content, /TAIL$/);
  assert.match(result.content, /Turntrail truncated \d+ chars/);
});

test('truncateTurnContent leaves short content and disabled caps untouched', () => {
  assert.equal(truncateTurnContent('short', 400).removed, 0);
  assert.equal(truncateTurnContent('x'.repeat(5000), 0).removed, 0);
});

test('export collapses duplicate turns and truncates tool output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-dedupe-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'user', content: 'do the thing', provider: 'openai', surface: 'cli', timestamp: '1' },
      { role: 'assistant', content: 'on it', provider: 'openai', surface: 'cli', timestamp: '2' },
      { role: 'assistant', content: 'on it', provider: 'openai', surface: 'cli', timestamp: '2' },
      { role: 'tool', content: 'OUT' + 'x'.repeat(5000), provider: 'openai', surface: 'cli', timestamp: '3' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'dedupe-test' }
  );

  const exported = await exportHandoff(root, { target: 'claude' });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /Collapsed duplicate turns: 1/);
  assert.match(handoff, /Truncated oversized turns: 1/);
  assert.match(handoff, /Turntrail truncated \d+ chars/);
  // Counted inside the transcript only: the summary section quotes the last
  // assistant message by design, which is a separate occurrence.
  const transcript = handoff.split('## Transcript Turns')[1];
  assert.equal(transcript.split('\non it\n').length - 1, 1);
  // The fixed safety header is not part of the transcript budget. Even with
  // that header, the truncated handoff must remain smaller than the raw turn.
  assert.ok(handoff.length < 5003);
});

test('export stores reversible sanitized attachments for truncated content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-attachments-'));
  await initStore(root);
  const secret = `sk-test-${'A'.repeat(30)}`;
  const fullOutput = `START\nAPI_KEY=${secret}\n${'middle-output\n'.repeat(600)}END`;
  await writeSession(root, [
    { role: 'tool', content: fullOutput, provider: 'openai', surface: 'cli', timestamp: '1' }
  ], { provider: 'openai', surface: 'cli', sessionId: 'attachment-test' });

  const exported = await exportHandoff(root, { target: 'claude', toolMaxChars: 500 });
  const handoff = await fs.readFile(exported.path, 'utf8');
  const match = handoff.match(/full sanitized content: ([^ ]+\/([a-f0-9]{64})\.txt) \(SHA-256 \2\)/);
  assert.ok(match, 'handoff should name and hash the reversible attachment');
  assert.equal(match[1].startsWith('.turntrail/attachments/'), true);

  const attachment = await readAttachment(root, match[2]);
  assert.match(attachment.content, /^START/);
  assert.match(attachment.content, /END$/);
  assert.match(attachment.content, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(attachment.content, new RegExp(secret));
  assert.ok(attachment.content.length > 500);

  const manifest = await readManifest(root);
  assert.deepEqual(manifest.exports.at(-1).attachments, [match[2]]);
});

test('export stores a reversible sanitized attachment for a truncated snapshot diff', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-diff-attachment-'));
  await initStore(root);
  const secret = `sk-test-${'B'.repeat(30)}`;
  await writeSnapshot(root, {
    createdAt: '2026-01-01T00:00:00.000Z',
    git: {
      available: true,
      branch: 'main',
      head: 'abc123',
      status: ' M app.js',
      diffStat: 'app.js | 100 +',
      diff: `diff --git a/app.js b/app.js\n+API_KEY=${secret}\n${'+line\n'.repeat(1000)}`
    }
  });

  const exported = await exportHandoff(root, { target: 'codex', snapshotDiffMaxChars: 400 });
  const handoff = await fs.readFile(exported.path, 'utf8');
  const match = handoff.match(/full sanitized content: [^ ]+\/([a-f0-9]{64})\.txt/);
  assert.ok(match);
  const attachment = await readAttachment(root, match[1]);
  assert.match(attachment.content, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(attachment.content, new RegExp(secret));
});

test('export with dedupe disabled keeps duplicate turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-nodedupe-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'assistant', content: 'twice', provider: 'openai', surface: 'cli', timestamp: '1' },
      { role: 'assistant', content: 'twice', provider: 'openai', surface: 'cli', timestamp: '1' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'nodedupe-test' }
  );
  const exported = await exportHandoff(root, { target: 'claude', dedupe: false });
  const handoff = await fs.readFile(exported.path, 'utf8');
  const transcript = handoff.split('## Transcript Turns')[1];
  assert.equal(transcript.split('\ntwice\n').length - 1, 2);
});

test('imports synthetic Claude Code native transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-claude-'));
  const projectsDir = path.join(root, 'native-claude');
  await fs.mkdir(path.join(projectsDir, 'project'), { recursive: true });
  const transcript = path.join(projectsDir, 'project', 'abc.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', cwd: root, message: { role: 'user', content: 'Start here' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } })
    ].join('\n'),
    'utf8'
  );

  const sessions = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(sessions.length, 1);
  const imported = await importNativeSession(root, 'claude', { root, projectsDir, last: true });
  assert.equal(imported.turnCount, 2);
});

test('imports synthetic Codex native transcript', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  const transcript = path.join(sessionsDir, '2026', '01', '01', 'rollout-test.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex1', cwd: root, source: 'cli' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Continue this task' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Working on it' } })
    ].join('\n'),
    'utf8'
  );

  const sessions = await discoverNativeSessions('codex', { root, sessionsDir });
  assert.equal(sessions.length, 1);
  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(imported.turnCount, 2);
});

test('Codex import collapses the same message written to both native streams', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-streams-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, '2026', '01', '01', 'rollout-streams.jsonl'),
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'streams', cwd: root, source: 'cli' } }),
      // One user message, recorded by both streams.
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'ship it' } }),
      // One assistant message, recorded by both streams and repeated by task_complete.
      JSON.stringify({ timestamp: '2026-01-01T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'shipping' }] } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'shipping' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'shipping' } })
    ].join('\n'),
    'utf8'
  );

  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(imported.turnCount, 2);

  const turns = await readAllTurns(root);
  assert.deepEqual(turns.map((turn) => turn.role), ['user', 'assistant']);
  assert.equal(turns[0].content, 'ship it');
  assert.equal(turns[1].content, 'shipping');
  assert.equal(turns[0].metadata.collapsedStreams, 'item+event');
});

test('Codex import keeps a message that genuinely repeats', () => {
  // Each real message produces its own event+item pair. Both pairs collapse to
  // one turn each; the two turns must not then collapse into a single "yes".
  const turns = [
    { role: 'user', content: 'yes', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'event' } },
    { role: 'tool', content: 'ran something', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'item' } },
    { role: 'user', content: 'yes', metadata: { stream: 'event' } }
  ];
  const { turns: collapsed, removed } = collapseCodexStreamDuplicates(turns);
  assert.equal(removed, 2);
  assert.equal(collapsed.filter((turn) => turn.role === 'user').length, 2);
  assert.equal(collapsed.length, 3);
});

test('Codex import leaves single-stream transcripts untouched', () => {
  const turns = [
    { role: 'assistant', content: 'one', metadata: { stream: 'event' } },
    { role: 'assistant', content: 'two', metadata: { stream: 'event' } },
    { role: 'system', content: 'ctx', metadata: { stream: 'meta' } },
    { role: 'system', content: 'ctx', metadata: { stream: 'meta' } }
  ];
  const { turns: collapsed, removed } = collapseCodexStreamDuplicates(turns);
  assert.equal(removed, 0);
  assert.equal(collapsed.length, 4);
});

test('Codex response_item user messages keep image payloads out of the ledger', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-item-media-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, '2026', '01', '01', 'rollout-item-media.jsonl'),
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'item-media', cwd: root, source: 'cli' } }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see the screenshot' },
            { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(4000)}` }
          ]
        }
      })
    ].join('\n'),
    'utf8'
  );

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const turns = await readAllTurns(root);
  assert.equal(turns.length, 1);
  assert.match(turns[0].content, /see the screenshot/);
  assert.match(turns[0].content, /Inline image payloads omitted from imported text: 1/);
  assert.doesNotMatch(turns[0].content, /AAAA/);
  assert.equal(turns[0].metadata.media.inlineImageCount, 1);
});

test('summarizeSession quotes the last real request, not injected context', () => {
  const summary = summarizeSession([
    { role: 'user', content: 'build the parser', timestamp: '1' },
    { role: 'assistant', content: 'building it', timestamp: '2' },
    { role: 'tool', content: 'Tool call: Edit\n{"file_path":"src/parser.js"}', timestamp: '3' },
    { role: 'tool', content: 'Tool call: shell_command\n{"command":"npm test"}', timestamp: '4' },
    { role: 'assistant', content: 'parser done', timestamp: '5' },
    // Harness-injected turns arrive with the user role but are not requests.
    { role: 'user', content: '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>', timestamp: '6' }
  ]);

  assert.equal(summary.lastUser.content, 'build the parser');
  assert.equal(summary.lastAssistant.content, 'parser done');
  assert.deepEqual(summary.filesWritten, ['src/parser.js']);
  assert.deepEqual(summary.commands, ['npm test']);
  assert.equal(summary.counts.user, 2);
  assert.equal(summary.counts.tool, 2);
});

test('summarizeSession falls back to an injected turn when there is nothing else', () => {
  const summary = summarizeSession([{ role: 'user', content: '<environment_context>x</environment_context>', timestamp: '1' }]);
  assert.match(summary.lastUser.content, /environment_context/);
});

test('summarizeSession ignores read-only tool calls and unparseable bodies', () => {
  const summary = summarizeSession([
    { role: 'tool', content: 'Tool call: Read\n{"file_path":"src/secret.js"}', timestamp: '1' },
    { role: 'tool', content: 'Tool call: Write\nnot json at all', timestamp: '2' },
    { role: 'tool', content: 'Tool call: Write\n{"file_path":"src/kept.js"}', timestamp: '3' }
  ]);
  assert.deepEqual(summary.filesWritten, ['src/kept.js']);
});

test('handoff leads with an extractive summary of where the session stopped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-summary-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'user', content: 'fix the exporter', provider: 'openai', surface: 'cli', timestamp: '1' },
      { role: 'tool', content: 'Tool call: apply_patch\n{"path":"src/exporter.js"}', provider: 'openai', surface: 'cli', timestamp: '2' },
      { role: 'assistant', content: 'exporter fixed and tests pass', provider: 'openai', surface: 'cli', timestamp: '3' }
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'summary-test' }
  );

  const handoff = await fs.readFile((await exportHandoff(root, { target: 'claude' })).path, 'utf8');
  assert.match(handoff, /## Where This Left Off/);
  assert.match(handoff, /Last request from the user/);
  assert.match(handoff, /fix the exporter/);
  assert.match(handoff, /exporter fixed and tests pass/);
  assert.match(handoff, /src\/exporter\.js/);
  // The summary must come before the bulk transcript so it is read first.
  assert.ok(handoff.indexOf('## Where This Left Off') < handoff.indexOf('## Transcript Turns'));
  // And it must be framed as a claim, not as verified fact.
  assert.match(handoff, /not verified fact/);
});

test('the summary survives a budget that drops the turns it quotes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-summary-budget-'));
  await initStore(root);
  await writeSession(
    root,
    [
      { role: 'user', content: 'the original goal', provider: 'openai', surface: 'cli', timestamp: '0001' },
      ...Array.from({ length: 200 }, (_, index) => ({
        role: 'assistant',
        content: `noise ${index} ${'n'.repeat(2000)}`,
        provider: 'openai',
        surface: 'cli',
        timestamp: String(index + 2).padStart(4, '0')
      }))
    ],
    { provider: 'openai', surface: 'cli', sessionId: 'summary-budget' }
  );

  const handoff = await fs.readFile((await exportHandoff(root, { target: 'claude', maxChars: 20000 })).path, 'utf8');
  assert.match(handoff, /Omitted turns due to budget/);
  assert.match(handoff, /the original goal/);
});

test('handoff can omit the summary section', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-nosummary-'));
  await initStore(root);
  await writeSession(root, [{ role: 'user', content: 'hello', provider: 'openai', surface: 'cli', timestamp: '1' }], {
    provider: 'openai',
    surface: 'cli',
    sessionId: 'nosummary'
  });
  const handoff = await fs.readFile((await exportHandoff(root, { target: 'claude', summary: false })).path, 'utf8');
  assert.doesNotMatch(handoff, /## Where This Left Off/);
});

test('snapshot section renders uncommitted work and a verification handle', () => {
  const handoff = renderHandoff({
    target: 'claude',
    manifest: { schemaVersion: 1, projectRoot: '/repo', sessions: [], snapshots: [], exports: [] },
    snapshot: {
      createdAt: '2026-01-01T00:00:00.000Z',
      topLevelFiles: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }],
      git: {
        available: true,
        branch: 'main',
        head: 'abc1234 Some commit',
        status: '## main...origin/main',
        remotes: 'origin\thttps://example.com/repo.git (fetch)\norigin\thttps://example.com/repo.git (push)',
        diffStat: ' src/a.js | 2 +-',
        diff: 'diff --git a/src/a.js b/src/a.js\n-old line\n+new line'
      }
    },
    prepared: []
  });

  assert.match(handoff, /Git remote: origin https:\/\/example\.com\/repo\.git/);
  assert.match(handoff, /Top-level entries: src, README\.md/);
  assert.match(handoff, /A HEAD other than `abc1234` means the workspace advanced/);
  assert.match(handoff, /Uncommitted changes \(staged and unstaged, vs HEAD\)/);
  assert.match(handoff, /\+new line/);
});

test('snapshot diff is truncated to the configured budget', () => {
  const handoff = renderHandoff({
    target: 'claude',
    manifest: { schemaVersion: 1, projectRoot: '/repo', sessions: [], snapshots: [], exports: [] },
    snapshot: {
      createdAt: '2026-01-01T00:00:00.000Z',
      git: { available: true, branch: 'main', head: 'abc1234', status: '', diffStat: 'stat', diff: 'd'.repeat(50000) }
    },
    prepared: [],
    snapshotDiffMaxChars: 500
  });
  assert.match(handoff, /Uncommitted diff \(truncated\)/);
  assert.match(handoff, /Turntrail truncated \d+ chars/);
  assert.ok(handoff.length < 5000);
});

test('exports are pruned to the most recent few', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-prune-'));
  await initStore(root);
  await writeSession(root, [{ role: 'user', content: 'hi', provider: 'openai', surface: 'cli', timestamp: '1' }], {
    provider: 'openai',
    surface: 'cli',
    sessionId: 'prune-test'
  });

  const paths = [];
  for (let i = 0; i < 5; i++) {
    paths.push((await exportHandoff(root, { target: 'claude', keepExports: 3 })).path);
  }

  const manifest = await readManifest(root);
  assert.equal(manifest.exports.length, 3);
  // The two oldest files are gone from disk, the three newest remain.
  assert.equal(await pathExists(paths[0]), false);
  assert.equal(await pathExists(paths[1]), false);
  assert.equal(await pathExists(paths[4]), true);
});

test('pruning keeps everything when disabled and never escapes the ledger', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-prune-off-'));
  await initStore(root);
  await writeSession(root, [{ role: 'user', content: 'hi', provider: 'openai', surface: 'cli', timestamp: '1' }], {
    provider: 'openai',
    surface: 'cli',
    sessionId: 'prune-off'
  });
  for (let i = 0; i < 3; i++) await exportHandoff(root, { target: 'claude', keepExports: 0 });
  assert.equal((await readManifest(root)).exports.length, 3);

  // A traversing path in a hand-edited manifest must not delete anything.
  const outside = path.join(root, 'do-not-delete.txt');
  await fs.writeFile(outside, 'keep me', 'utf8');
  const manifest = await readManifest(root);
  manifest.exports.unshift({ id: 'evil', path: '../../do-not-delete.txt', createdAt: '1970-01-01T00:00:00.000Z' });
  await fs.writeFile(path.join(root, '.turntrail', 'manifest.json'), JSON.stringify(manifest), 'utf8');

  await pruneLedgerEntries(root, 'exports', 3);
  assert.equal(await pathExists(outside), true);
});

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('sanitizes inline base64 media during handoff rendering', () => {
  const blob = `${'A'.repeat(1200)}+/${'B'.repeat(1200)}==`;
  const result = sanitizeContentForHandoff(`screenshot:\n${blob}`);
  assert.equal(result.omitted, 1);
  assert.match(result.content, /omitted base64 blob/);
  assert.ok(result.content.length < 200);
});

test('sanitizes large JSON base64 fields without regex stack overflow', () => {
  const value = `${'A'.repeat(200000)}+/==`;
  const result = sanitizeContentForHandoff(`{"image_url":"${value}"}`);
  assert.equal(result.omitted, 1);
  assert.match(result.content, /omitted base64 payload/);
  assert.ok(result.content.length < 200);
});

test('Codex native import preserves local image paths instead of inline media payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-codex-media-'));
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '01', '01'), { recursive: true });
  const transcript = path.join(sessionsDir, '2026', '01', '01', 'rollout-media.jsonl');
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex-media', cwd: root, source: 'ide' } }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Look at this screenshot.',
          local_images: [path.join(root, 'screenshots', 'one.png')],
          images: ['data:image/png;base64,AAAA']
        }
      })
    ].join('\n'),
    'utf8'
  );

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const turns = await readAllTurns(root);
  assert.match(turns[0].content, /Look at this screenshot/);
  assert.match(turns[0].content, /Attached local images/);
  assert.match(turns[0].content, /one\.png/);
  assert.equal(turns[0].metadata.media.inlineImageCount, 1);
});
