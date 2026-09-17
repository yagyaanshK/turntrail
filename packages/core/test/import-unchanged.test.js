import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeSessions, importNativeSession, initStore, readManifest } from '../src/index.js';

async function writeCodexThread(root, extraLines = []) {
  const sessionsDir = path.join(root, 'native-codex');
  const file = path.join(sessionsDir, '2026', '09', '06', 'rollout-thread.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { timestamp: '2026-09-06T15:16:57.000Z', type: 'session_meta', payload: { id: 'thread', cwd: root, source: 'vscode' } },
    { timestamp: '2026-09-06T15:17:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'First request' } },
    { timestamp: '2026-09-06T15:17:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'First answer' } },
    ...extraLines
  ];
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return { sessionsDir, file };
}

test('a native file that has not changed is not imported twice', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-unchanged-'));
  await initStore(root);
  const { sessionsDir, file } = await writeCodexThread(root);

  const first = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(first.unchanged, undefined);
  const entry = (await readManifest(root)).sessions.find((session) => session.id === first.id);
  const stat = await fs.stat(file);
  assert.equal(entry.sourceSize, stat.size);
  assert.equal(entry.sourceMtimeMs, stat.mtimeMs);

  const again = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(again.unchanged, true);
  assert.equal(again.id, first.id);
  assert.equal(again.turnCount, first.turnCount);
  assert.equal(again.relativePath, first.relativePath);
  const unchangedEntry = (await readManifest(root)).sessions.find((session) => session.id === first.id);
  assert.equal(unchangedEntry.importedAt, entry.importedAt, 'the ledger was not rewritten');

  // The user can insist.
  const forced = await importNativeSession(root, 'codex', { root, sessionsDir, last: true, force: true });
  assert.equal(forced.unchanged, undefined);
});

test('a native file that grew is imported again', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-grown-'));
  await initStore(root);
  const { sessionsDir } = await writeCodexThread(root);
  const first = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });

  await writeCodexThread(root, [
    { timestamp: '2026-09-06T15:20:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Second request' } }
  ]);
  const second = await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  assert.equal(second.unchanged, undefined);
  assert.equal(second.turnCount, first.turnCount + 1);
});

test('the same file imported with different options is imported again', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-options-'));
  await initStore(root);
  const { sessionsDir } = await writeCodexThread(root);
  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const withTranscripts = await importNativeSession(root, 'codex', { root, sessionsDir, last: true, subagentTranscripts: true });
  assert.equal(withTranscripts.unchanged, undefined);
  const again = await importNativeSession(root, 'codex', { root, sessionsDir, last: true, subagentTranscripts: true });
  assert.equal(again.unchanged, true);
});

test('discovery answers an unchanged file from the cache and a changed one from disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-cache-'));
  const { sessionsDir, file } = await writeCodexThread(root);
  // A whole-second timestamp, so it can be put back exactly after the rewrite
  // below; the cache key carries the mtime to sub-millisecond precision.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await fs.utimes(file, pinned, pinned);
  const discoveryCache = new Map();

  const first = await discoverNativeSessions('codex', { root, sessionsDir, discoveryCache });
  assert.equal(first.length, 1);
  assert.equal(first[0].title, 'First request');
  assert.equal(discoveryCache.size, 1);

  // Rewrite the opening request but keep the file's size and mtime: a cached
  // answer is used, so the old title is what comes back.
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace('First request', 'Other request'), 'utf8');
  await fs.utimes(file, pinned, pinned);
  const cached = await discoverNativeSessions('codex', { root, sessionsDir, discoveryCache });
  assert.equal(cached[0].title, 'First request');

  // Touch the file and the cache is bypassed.
  await fs.utimes(file, new Date(), new Date(pinned.getTime() + 5000));
  const fresh = await discoverNativeSessions('codex', { root, sessionsDir, discoveryCache });
  assert.equal(fresh[0].title, 'Other request');
  assert.equal(discoveryCache.size, 2);

  // Without a cache every call reads the file.
  const plain = await discoverNativeSessions('codex', { root, sessionsDir });
  assert.equal(plain[0].title, 'Other request');
});
