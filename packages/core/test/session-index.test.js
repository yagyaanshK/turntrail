import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listSessionIndex, mergeSessionIndex } from '../src/index.js';

test('session index merges native sessions with their ledger imports', async () => {
  const native = {
    codex: [{
      path: 'C:\\Work\\Repo\\codex.jsonl',
      sessionId: 'codex-one',
      surface: 'vscode',
      title: 'Build the dashboard',
      latest: 'Add filters',
      modifiedAt: '2026-09-04T02:00:00.000Z',
      matchesProject: true,
      size: 4096
    }],
    gemini: [{
      path: 'C:\\Work\\Repo\\gemini.jsonl',
      sessionId: 'gemini-one',
      surface: 'cli',
      title: 'Review the dashboard',
      modifiedAt: '2026-09-04T03:00:00.000Z',
      matchesProject: true
    }]
  };
  const manifest = {
    sessions: [{
      id: 'native-codex-codex-one',
      provider: 'openai',
      surface: 'vscode',
      sourcePath: 'c:\\work\\repo\\CODEX.jsonl',
      nativeSessionId: 'codex-one',
      importedAt: '2026-09-04T02:01:00.000Z'
    }]
  };

  const rows = await mergeSessionIndex(native, manifest, { platform: 'win32' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'gemini');
  assert.equal(rows[0].imported, false);
  assert.equal(rows[1].provider, 'codex');
  assert.equal(rows[1].imported, true);
  assert.equal(rows[1].ledgerSessionId, 'native-codex-codex-one');
  assert.equal(rows.some((row) => row.kind === 'ledger'), false);
});

test('session index retains ledger-only sessions and normalizes provider names', async () => {
  const rows = await mergeSessionIndex({}, {
    sessions: [{
      id: 'manual-google',
      provider: 'google',
      surface: 'cli',
      title: 'Imported elsewhere',
      importedAt: '2026-09-04T01:00:00.000Z'
    }]
  });

  assert.deepEqual(rows.map(({ kind, provider, imported }) => ({ kind, provider, imported })), [
    { kind: 'ledger', provider: 'gemini', imported: true }
  ]);
});

test('session index is deterministic, deduplicated, sorted, and capped', async () => {
  const duplicate = {
    path: '/repo/session.jsonl',
    sessionId: 'same',
    modifiedAt: '2026-09-04T02:00:00.000Z',
    matchesProject: true
  };
  const rows = await mergeSessionIndex({
    claude: [duplicate, { ...duplicate }],
    cursor: [{
      path: '/repo/newer.jsonl',
      sessionId: 'newer',
      modifiedAt: '2026-09-04T04:00:00.000Z',
      matchesProject: true
    }]
  }, { sessions: [] }, { platform: 'linux', limit: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'cursor');
  assert.match(rows[0].id, /^native:cursor:[a-f0-9]{24}$/);
});

test('session index discovers transcripts in additional managed account homes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-managed-index-'));
  const defaultSessions = path.join(root, 'default-sessions');
  const managedSessions = path.join(root, 'managed-sessions');
  await fs.mkdir(path.join(defaultSessions, '2026', '09', '07'), { recursive: true });
  await fs.mkdir(path.join(managedSessions, '2026', '09', '07'), { recursive: true });

  const event = (id, message) => [
    JSON.stringify({
      timestamp: '2026-09-07T10:00:00.000Z',
      type: 'session_meta',
      payload: { id, cwd: root, source: 'cli' }
    }),
    JSON.stringify({
      timestamp: '2026-09-07T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message }
    })
  ].join('\n');
  await fs.writeFile(path.join(defaultSessions, '2026', '09', '07', 'default.jsonl'), event('default', 'Default chat'));
  await fs.writeFile(path.join(managedSessions, '2026', '09', '07', 'managed.jsonl'), event('managed', 'Managed chat'));

  const result = await listSessionIndex(root, {
    providers: ['codex'],
    discoveryOptions: {
      codex: {
        sessionsDir: defaultSessions,
        archivedDir: path.join(root, 'default-archive'),
        sessionIndex: path.join(root, 'default-index.jsonl'),
        additionalLocations: [{
          sessionsDir: managedSessions,
          archivedDir: path.join(root, 'managed-archive'),
          sessionIndex: path.join(root, 'managed-index.jsonl')
        }]
      }
    }
  });

  assert.deepEqual(result.sessions.map((row) => row.sessionId).sort(), ['default', 'managed']);
});
