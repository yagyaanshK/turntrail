import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJsonlObjects } from '../src/adapters/common.js';
import { codexLineWanted } from '../src/adapters/codex.js';

async function tempFile(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-reader-'));
  const file = path.join(dir, 'records.jsonl');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

test('a line spanning many stream chunks is reassembled intact', async () => {
  // Far larger than one 64 KiB read, and under the per-line limit, so every
  // chunk has to be kept and joined exactly once at the newline.
  const long = 'x'.repeat(400_000);
  const file = await tempFile(`${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2, long })}\r\n${JSON.stringify({ n: 3 })}\n`);
  const seen = [];
  await readJsonlObjects(file, (object, lineNumber) => seen.push([lineNumber, object.n, object.long?.length]));
  assert.deepEqual(seen, [[1, 1, undefined], [2, 2, 400_000], [3, 3, undefined]]);
});

test('a line the caller filters out is neither parsed nor reported, but still counted', async () => {
  const file = await tempFile([
    JSON.stringify({ type: 'keep', n: 1 }),
    '{"type":"skip","broken": this would not parse',
    JSON.stringify({ type: 'keep', n: 3 }),
    ''
  ].join('\n'));
  const seen = [];
  await readJsonlObjects(file, (object, lineNumber) => seen.push([lineNumber, object.type, object.n]), {
    lineFilter: (line) => !line.startsWith('{"type":"skip"')
  });
  assert.deepEqual(seen, [[1, 'keep', 1], [3, 'keep', 3]]);
});

test('an oversized line followed by ordinary ones keeps the line numbers right', async () => {
  const file = await tempFile([
    JSON.stringify({ n: 1 }),
    JSON.stringify({ n: 2, pad: 'p'.repeat(300_000) }),
    JSON.stringify({ n: 3 }),
    ''
  ].join('\n'));
  const seen = [];
  await readJsonlObjects(file, (object, lineNumber) => seen.push([lineNumber, object.type || 'record', object.n]), { maxLineChars: 1000 });
  assert.deepEqual(seen, [[1, 'record', 1], [2, 'oversized_line', undefined], [3, 'record', 3]]);
});

test('Codex records the adapter never uses are recognised from the line head', () => {
  const line = (record) => JSON.stringify({ timestamp: '2026-09-06T15:16:57.000Z', ordinal: 7, ...record });
  assert.equal(codexLineWanted(line({ type: 'compacted', payload: { replacement_history: [] } })), false);
  assert.equal(codexLineWanted(line({ type: 'event_msg', payload: { type: 'item_completed', item: {} } })), false);
  assert.equal(codexLineWanted(line({ type: 'event_msg', payload: { type: 'token_count', info: {} } })), false);
  assert.equal(codexLineWanted(line({ type: 'response_item', payload: { type: 'reasoning', summary: [] } })), false);
  assert.equal(codexLineWanted(line({ type: 'world_state', payload: {} })), false);

  assert.equal(codexLineWanted(line({ type: 'session_meta', payload: { id: 'x' } })), true);
  assert.equal(codexLineWanted(line({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })), true);
  assert.equal(codexLineWanted(line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } })), true);
  assert.equal(codexLineWanted(line({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x' } })), true);
  assert.equal(codexLineWanted(line({ type: 'turn_context', payload: { cwd: 'C:/x' } })), true);
  // An unfamiliar record is parsed and judged by the adapter, never dropped here.
  assert.equal(codexLineWanted(line({ type: 'event_msg', payload: { type: 'something_new' } })), true);
  // A message quoting one of the skipped names is a message.
  assert.equal(codexLineWanted(line({ type: 'response_item', payload: { type: 'message', role: 'user', content: '"type":"compacted"' } })), true);
});
