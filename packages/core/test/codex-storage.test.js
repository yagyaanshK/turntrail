import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCodexStorage, listSessionIndex } from '../src/index.js';

async function codexHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-storage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '10', '14');
  await fs.mkdir(day, { recursive: true });
  return { home, day };
}

const meta = (id) => JSON.stringify({ timestamp: '2026-10-14T01:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id, cwd: '/work' } });

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return undefined;
  }
}

test('a Codex home with only readable rollouts reports nothing', async (t) => {
  const { home, day } = await codexHome(t);
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-00-a.jsonl'), `${meta('a')}\n`);
  // Codex creates the file before it writes the first line.
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-01-b.jsonl'), '');
  await fs.writeFile(path.join(day, 'notes.txt'), 'not a rollout');
  assert.deepEqual(await checkCodexStorage({ homes: [home] }), []);
});

test('rollouts in another format, or that do not start with session metadata, are named', async (t) => {
  const { home, day } = await codexHome(t);
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-00-a.jsonl.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-01-b.jsonl.zst'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-02-c.jsonl'), '{"page":1,"items":[]}\n');

  const problems = await checkCodexStorage({ homes: [home] });
  const format = problems.find((problem) => problem.reason === 'format');
  const unrecognised = problems.find((problem) => problem.reason === 'unrecognised');
  assert.equal(format.count, 2);
  assert.match(format.message, /^2 Codex chats are stored in a format Turntrail cannot read yet \(rollout-.*\.jsonl\.zst\)/);
  assert.match(format.message, /left out of Sessions and Usage.*github\.com\/yagyaanshK\/turntrail\/issues/);
  assert.equal(unrecognised.count, 1);
  assert.match(unrecognised.message, /^1 Codex chat has a transcript that does not start the way Turntrail expects/);
});

test('chats in Codex\'s own index without a rollout file are named, but new or empty ones are not', async (t) => {
  const sqlite = await loadSqlite();
  if (!sqlite) {
    t.skip('node:sqlite is not available in this runtime');
    return;
  }
  const { home, day } = await codexHome(t);
  const present = path.join(day, 'rollout-2026-10-14T01-00-00-a.jsonl');
  await fs.writeFile(present, `${meta('a')}\n`);
  const now = Date.parse('2026-10-14T12:00:00Z');
  const db = new sqlite.DatabaseSync(path.join(home, 'state_7.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)');
  const hourAgo = now / 1000 - 3600;
  insert.run('a', present, hourAgo, 1);
  insert.run('gone', path.join(day, 'rollout-gone.jsonl'), hourAgo, 1);
  insert.run('relative', 'sessions/2026/10/14/rollout-relative.jsonl', hourAgo, 1);
  insert.run('empty', path.join(day, 'rollout-empty.jsonl'), hourAgo, 0);
  insert.run('just-started', path.join(day, 'rollout-new.jsonl'), now / 1000 - 30, 1);
  db.close();
  // An older index beside it is ignored in favour of the newest.
  await fs.writeFile(path.join(home, 'state_5.sqlite'), 'not a database');

  const problems = await checkCodexStorage({ homes: [home], now: () => now });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, 'missing');
  assert.equal(problems[0].count, 2);
  assert.match(problems[0].message, /^Codex lists 2 Codex chats with no transcript file, so Codex may now keep them only in its own database/);
});

test('an unreadable Codex index proves nothing and raises no alarm', async (t) => {
  const { home } = await codexHome(t);
  await fs.writeFile(path.join(home, 'state_5.sqlite'), 'not a database');
  assert.deepEqual(await checkCodexStorage({ homes: [home] }), []);
});

test('the session list carries the alarm for every Codex home it reads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-storage-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { home, day } = await codexHome(t);
  const managed = await codexHome(t);
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-00-a.jsonl'), `${meta('a')}\n`);
  await fs.writeFile(path.join(managed.day, 'rollout-2026-10-14T01-00-00-b.jsonl.gz'), 'gzip');

  const result = await listSessionIndex(root, {
    providers: ['codex'],
    all: true,
    discoveryOptions: {
      codex: {
        sessionsDir: path.join(home, 'sessions'),
        archivedDir: path.join(home, 'archived_sessions'),
        sessionIndex: path.join(home, 'session_index.jsonl'),
        additionalLocations: [{
          sessionsDir: path.join(managed.home, 'sessions'),
          archivedDir: path.join(managed.home, 'archived_sessions'),
          sessionIndex: path.join(managed.home, 'session_index.jsonl')
        }]
      }
    }
  });
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.errors.map((error) => error.provider), ['codex']);
  assert.match(result.errors[0].message, /1 Codex chat is stored in a format Turntrail cannot read yet \(rollout-.*\.jsonl\.gz\)/);
});

test('without user_message events, a chat is described by the text the user wrote, not the injected context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-requests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { home, day } = await codexHome(t);
  const userItem = (...texts) => JSON.stringify({
    timestamp: '2026-10-14T01:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) }
  });
  const lines = [
    JSON.stringify({ timestamp: '2026-10-14T01:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'paged', cwd: root } }),
    userItem('# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nAsk before acting.\n</INSTRUCTIONS>', '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>'),
    userItem('Audit the admissions data for the fourth batch of programmes'),
    JSON.stringify({ timestamp: '2026-10-14T01:00:02.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'agentMessage' } } }),
    userItem('Now rewrite the summary section of the outreach email')
  ];
  await fs.writeFile(path.join(day, 'rollout-2026-10-14T01-00-00-paged.jsonl'), `${lines.join('\n')}\n`);

  const { discoverCodexSessions } = await import('../src/adapters/codex.js');
  const [session] = await discoverCodexSessions({
    root,
    sessionsDir: path.join(home, 'sessions'),
    sessionIndex: path.join(home, 'session_index.jsonl')
  });
  // Codex never named it, so its first request is its title.
  assert.equal(session.title, 'Audit the admissions data for the fourth batch of programmes');
  assert.equal(session.latest, 'Now rewrite the summary section of the outreach email');
});
