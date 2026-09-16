import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverNativeSessions,
  importTranscript,
  initStore,
  prepareTurns,
  readAllTurns,
  selectPreparedTurns,
  writeSession
} from '../src/index.js';
import { oversizedLineSummary, readJsonlObjects } from '../src/adapters/common.js';

async function tempRoot(prefix = 'context-bridge-scale-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('an oversized latest user request is truncated into the budget instead of dropped', () => {
  const prepared = prepareTurns([
    { role: 'assistant', provider: 'openai', surface: 'cli', timestamp: '1', content: 'older answer' },
    { role: 'user', provider: 'openai', surface: 'cli', timestamp: '2', content: `START-${'x'.repeat(10000)}-END` },
    { role: 'assistant', provider: 'openai', surface: 'cli', timestamp: '3', content: 'answering the large request' }
  ]);
  const selected = selectPreparedTurns(prepared, 700);
  assert.equal(selected.prepared.some((item) => item.role === 'user'), true);
  const user = selected.prepared.find((item) => item.role === 'user');
  assert.ok(user.size <= 700);
  assert.match(user.block, /START-/);
  assert.match(user.block, /-END/);
  assert.match(user.block, /Turntrail truncated/);

  const impossiblySmall = selectPreparedTurns(prepared, 10);
  assert.equal(impossiblySmall.prepared.some((item) => item.role === 'user'), true, 'intent wins even when header overhead exceeds the budget');
});

test('JSONL reading skips an oversized line and reports it instead of failing the file', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'huge.jsonl');
  const huge = `{"type":"compacted","payload":"${'x'.repeat(1000)}"}`;
  await fs.writeFile(source, `${JSON.stringify({ n: 1 })}\n${huge}\n${JSON.stringify({ n: 3 })}\n`, 'utf8');
  const seen = [];
  await readJsonlObjects(source, (object, lineNumber) => seen.push({ object, lineNumber }), { maxLineChars: 100 });

  assert.deepEqual(seen.map((item) => item.lineNumber), [1, 2, 3]);
  assert.deepEqual(seen[0].object, { n: 1 });
  assert.deepEqual(seen[2].object, { n: 3 });
  const skipped = seen[1].object;
  assert.equal(skipped.type, 'oversized_line');
  assert.equal(skipped.chars, huge.length);
  assert.equal(skipped.maxLineChars, 100);
  assert.ok(skipped.rawLine.length <= 512, 'only a short head of the line is retained');
  assert.match(skipped.rawLine, /"type":"compacted"/);
  assert.match(oversizedLineSummary(skipped), /Skipped oversized native record \(compacted\): \d+ characters exceed the 100-character limit/);
});

test('JSONL reading discards an oversized line that spans many stream chunks', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'huge-tail.jsonl');
  // Larger than one 64 KiB read chunk, and without a trailing newline so the
  // end-of-file path is exercised too.
  const huge = `{"type":"compacted","payload":"${'y'.repeat(300000)}"}`;
  await fs.writeFile(source, `${JSON.stringify({ n: 1 })}\n${huge}`, 'utf8');
  const seen = [];
  await readJsonlObjects(source, (object, lineNumber) => seen.push({ object, lineNumber }), { maxLineChars: 1000 });

  assert.deepEqual(seen.map((item) => item.lineNumber), [1, 2]);
  assert.equal(seen[1].object.type, 'oversized_line');
  assert.equal(seen[1].object.chars, huge.length);
  assert.match(seen[1].object.rawLine, /^\{"type":"compacted"/);
});

test('JSONL callback failures propagate once and are not retried as parse errors', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'one.jsonl');
  await fs.writeFile(source, `${JSON.stringify({ value: 1 })}\n`, 'utf8');
  let called = 0;
  await assert.rejects(
    () =>
      readJsonlObjects(source, () => {
        called++;
        throw new Error('consumer failed');
      }),
    /consumer failed/
  );
  assert.equal(called, 1);
});

test('non-JSONL imports reject files above their configured whole-file limit', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'large.txt');
  await fs.writeFile(source, 'x'.repeat(1000), 'utf8');
  await assert.rejects(() => importTranscript(root, source, { maxNonJsonlImportBytes: 100 }), /above the 100-byte safety limit/);
});

test('streamed JSONL imports and ledger reads enforce bounded turn counts', async () => {
  const root = await tempRoot();
  const source = path.join(root, 'turns.jsonl');
  await fs.writeFile(
    source,
    Array.from({ length: 4 }, (_, index) => JSON.stringify({ role: 'user', content: `turn ${index}` })).join('\n'),
    'utf8'
  );
  await assert.rejects(() => importTranscript(root, source, { maxImportedTurns: 2 }), /in-memory import safety limit/);

  await initStore(root);
  await writeSession(
    root,
    Array.from({ length: 4 }, (_, index) => ({ role: 'user', content: `stored ${index}`, timestamp: String(index) })),
    { sessionId: 'bounded-ledger' }
  );
  await assert.rejects(() => readAllTurns(root, { maxLedgerTurns: 2 }), /Ledger exceeds the export safety limit/);
});

test('native discovery observes cancellation before walking provider storage', async () => {
  const root = await tempRoot();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => discoverNativeSessions('codex', { root, sessionsDir: root, signal: controller.signal }),
    (error) => error?.name === 'AbortError'
  );
});
