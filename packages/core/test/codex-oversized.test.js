import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeSessions, importNativeSession, initStore, readAllTurns } from '../src/index.js';

// A Codex thread the way long ones look on disk: ordinary records, a built-in
// tool edit recorded as a custom tool call, and a `compacted` record whose
// replacement history has outgrown the per-line limit.
async function writeLongCodexThread(root, options = {}) {
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '07', '03'), { recursive: true });
  const transcript = path.join(sessionsDir, '2026', '07', '03', 'rollout-long.jsonl');
  const compacted = JSON.stringify({
    timestamp: '2026-07-03T09:59:38.888Z',
    type: 'compacted',
    payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: 'h'.repeat(options.compactedChars || 20000) }] }
  });
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-07-03T09:00:00.000Z', type: 'session_meta', payload: { id: 'long-thread', cwd: root, source: 'vscode' } }),
      JSON.stringify({ timestamp: '2026-07-03T09:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Update the profile map' } }),
      JSON.stringify({
        timestamp: '2026-07-03T09:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: MAP.md\n+# Map\n*** End Patch' }
      }),
      JSON.stringify({
        timestamp: '2026-07-03T09:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA MAP.md' }
      }),
      compacted,
      JSON.stringify({ timestamp: '2026-07-03T09:59:40.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Now tidy the summary section' } }),
      JSON.stringify({ timestamp: '2026-07-03T09:59:41.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Tidied the summary section.' } })
    ].join('\n') + '\n',
    'utf8'
  );
  return { sessionsDir, transcript, compactedChars: compacted.length };
}

test('an oversized Codex compaction record is skipped and reported instead of failing the import', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-oversized-'));
  await initStore(root);
  const { sessionsDir, compactedChars } = await writeLongCodexThread(root);

  const sessions = await discoverNativeSessions('codex', { root, sessionsDir, maxLineChars: 4096 });
  assert.equal(sessions.length, 1, 'discovery still lists the thread');

  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true, maxLineChars: 4096 });
  const turns = await readAllTurns(root);
  const contents = turns.map((turn) => turn.content);

  assert.equal(imported.turnCount, turns.length);
  assert.ok(contents.includes('Update the profile map'), 'turns before the oversized record survive');
  assert.ok(contents.includes('Tidied the summary section.'), 'turns after the oversized record survive');

  const skipped = turns.filter((turn) => turn.metadata?.nativeType === 'oversized_line');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].role, 'system');
  assert.equal(skipped[0].metadata.lineNumber, 5);
  assert.match(skipped[0].content, /Skipped oversized native record \(compacted\)/);
  assert.match(skipped[0].content, new RegExp(`${compactedChars} characters exceed the 4096-character limit`));
  assert.ok(!contents.some((content) => content.includes('hhhhhhhh')), 'the oversized payload never reaches the ledger');
});

test('Codex custom tool calls and their outputs are imported as tool turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-custom-tools-'));
  await initStore(root);
  const { sessionsDir } = await writeLongCodexThread(root, { compactedChars: 10 });

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const tools = (await readAllTurns(root)).filter((turn) => turn.role === 'tool');

  assert.equal(tools.length, 2);
  assert.equal(tools[0].metadata.nativePayloadType, 'custom_tool_call');
  assert.match(tools[0].content, /^Tool call: apply_patch\n\*\*\* Begin Patch/);
  assert.equal(tools[1].metadata.nativePayloadType, 'custom_tool_call_output');
  assert.match(tools[1].content, /Success\. Updated the following files:/);
});
