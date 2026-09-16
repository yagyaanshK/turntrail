import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverNativeSessions,
  importNativeSession,
  normalizeNativeProvider,
  readAllTurns
} from '../src/index.js';
import { cursorProjectKey } from '../src/adapters/cursor.js';

test('native provider aliases include Gemini and Cursor Agent', () => {
  assert.equal(normalizeNativeProvider('google'), 'gemini');
  assert.equal(normalizeNativeProvider('Gemini'), 'gemini');
  assert.equal(normalizeNativeProvider('cursor-agent'), 'cursor');
  assert.equal(normalizeNativeProvider('agent'), 'cursor');
});

test('discovers and imports a legacy Gemini JSON session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-gemini-json-'));
  const tempDir = path.join(root, 'gemini-tmp');
  const projectHash = crypto.createHash('sha256').update(path.resolve(root)).digest('hex');
  const chats = path.join(tempDir, projectHash, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const transcript = path.join(chats, 'session-legacy.json');
  await fs.writeFile(transcript, JSON.stringify({
    sessionId: 'gemini-legacy',
    projectHash,
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:02.000Z',
    messages: [
      { id: 'u1', type: 'user', timestamp: '2026-01-01T00:00:01.000Z', content: [{ text: 'Inspect the cache' }] },
      { id: 'g1', type: 'gemini', timestamp: '2026-01-01T00:00:02.000Z', content: 'The cache is valid.' }
    ]
  }), 'utf8');

  const sessions = await discoverNativeSessions('gemini', { root, tempDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].matchesProject, true);
  assert.equal(sessions[0].sessionId, 'gemini-legacy');
  assert.equal(sessions[0].title, 'Inspect the cache');

  const imported = await importNativeSession(root, 'google', { path: transcript });
  assert.equal(imported.turnCount, 2);
  const turns = await readAllTurns(root);
  assert.deepEqual(turns.map((turn) => turn.provider), ['google', 'google']);
  assert.deepEqual(turns.map((turn) => turn.content), ['Inspect the cache', 'The cache is valid.']);
});

test('Gemini JSONL import applies rewinds and preserves tool context without inline media', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-gemini-jsonl-'));
  const tempDir = path.join(root, 'gemini-tmp');
  const projectDir = path.join(tempDir, 'friendly-project');
  const chats = path.join(projectDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  await fs.writeFile(path.join(projectDir, '.project_root'), root, 'utf8');
  const transcript = path.join(chats, 'session-current-12345678.jsonl');
  await fs.writeFile(transcript, [
    JSON.stringify({ sessionId: 'gemini-current', projectHash: 'different-install-hash', startTime: '2026-02-01T00:00:00.000Z' }),
    JSON.stringify({ id: 'u1', type: 'user', timestamp: '2026-02-01T00:00:01.000Z', content: 'Original request' }),
    JSON.stringify({ id: 'g-abandoned', type: 'gemini', timestamp: '2026-02-01T00:00:02.000Z', content: 'Abandoned answer' }),
    JSON.stringify({ $rewindTo: 'g-abandoned' }),
    JSON.stringify({ id: 'g2', type: 'gemini', timestamp: '2026-02-01T00:00:03.000Z', content: [
      { text: 'Replacement answer' },
      { inlineData: { mimeType: 'image/png', data: 'not-exported' } }
    ], toolCalls: [{ id: 'tool1', name: 'read_file', args: { path: 'src/a.js' }, result: [{ text: 'file body' }], status: 'success', timestamp: '2026-02-01T00:00:04.000Z' }] }),
    JSON.stringify({ $set: { lastUpdated: '2026-02-01T00:00:05.000Z' } })
  ].join('\n') + '\n', 'utf8');

  const sessions = await discoverNativeSessions('gemini', { root, tempDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].matchesProject, true);
  assert.equal(sessions[0].modifiedAt, '2026-02-01T00:00:05.000Z');

  const result = await importNativeSession(root, 'gemini', { path: transcript });
  assert.equal(result.turnCount, 3);
  const turns = await readAllTurns(root);
  assert.equal(turns.some((turn) => turn.content.includes('Abandoned answer')), false);
  assert.equal(turns.some((turn) => turn.content.includes('Replacement answer')), true);
  assert.equal(turns.some((turn) => turn.content.includes('[Inline image/png omitted by Turntrail]')), true);
  assert.equal(turns.some((turn) => turn.role === 'tool' && turn.content.includes('read_file')), true);
  assert.equal(turns.some((turn) => turn.content.includes('not-exported')), false);
});

test('Cursor discovery matches encoded projects and excludes subagents by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-cursor-'));
  const projectsDir = path.join(root, 'cursor-projects');
  const projectKey = cursorProjectKey(root);
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const sessionDir = path.join(projectsDir, projectKey, 'agent-transcripts', sessionId);
  await fs.mkdir(path.join(sessionDir, 'subagents'), { recursive: true });
  const transcript = path.join(sessionDir, `${sessionId}.jsonl`);
  await fs.writeFile(transcript, [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Build the parser' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', name: 'read_file', input: { path: 'parser.js' } }
    ] } }),
    JSON.stringify({ role: 'user', message: { content: [{ type: 'tool_result', content: 'parser body' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Parser complete.' }] } })
  ].join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(sessionDir, 'subagents', 'sub.jsonl'), JSON.stringify({
    role: 'assistant', message: { content: [{ type: 'text', text: 'Subagent noise' }] }
  }) + '\n', 'utf8');

  const sessions = await discoverNativeSessions('cursor', { root, projectsDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].matchesProject, true);
  assert.equal(sessions[0].sessionId, sessionId);
  assert.equal(sessions[0].title, 'Build the parser');

  const all = await discoverNativeSessions('cursor', { root, projectsDir, all: true, includeSubagents: true });
  assert.equal(all.length, 2);
  assert.equal(all.filter((session) => session.subagent).length, 1);

  const result = await importNativeSession(root, 'cursor-agent', { path: transcript });
  assert.equal(result.turnCount, 4);
  const turns = await readAllTurns(root);
  assert.deepEqual(turns.map((turn) => turn.provider), ['cursor', 'cursor', 'cursor', 'cursor']);
  assert.equal(turns[1].content.includes('Tool call: read_file'), true);
  assert.equal(turns[2].role, 'tool');
  assert.equal(turns[2].content.includes('parser body'), true);
});

test('Cursor discovery does not claim similarly prefixed project folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-cursor-match-'));
  const projectsDir = path.join(root, 'cursor-projects');
  const wrongKey = `${cursorProjectKey(root)}-other`;
  const sessionId = 'wrong-project';
  const sessionDir = path.join(projectsDir, wrongKey, 'agent-transcripts', sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({
    role: 'user', message: { content: [{ type: 'text', text: 'Wrong project' }] }
  }) + '\n', 'utf8');

  assert.deepEqual(await discoverNativeSessions('cursor', { root, projectsDir }), []);
  const all = await discoverNativeSessions('cursor', { root, projectsDir, all: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].matchesProject, false);
});

test('one unreadable Claude transcript does not hide healthy sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-skip-'));
  const projectsDir = path.join(root, 'claude-projects');
  await fs.mkdir(projectsDir, { recursive: true });
  const valid = path.join(projectsDir, 'valid.jsonl');
  const invalid = path.join(projectsDir, 'invalid.jsonl');
  await fs.writeFile(valid, JSON.stringify({
    type: 'user',
    sessionId: 'healthy',
    cwd: root,
    timestamp: '2026-09-04T00:00:00.000Z',
    message: { role: 'user', content: 'Healthy request' }
  }) + '\n', 'utf8');
  // A cwd containing a NUL byte cannot be resolved on any platform, so this
  // transcript fails while its metadata is inspected rather than while it is
  // read: an oversized line no longer makes a transcript unreadable.
  await fs.writeFile(invalid, `${JSON.stringify({ type: 'user', cwd: `${root} broken`, message: { content: 'x' } })}\n`, 'utf8');
  const skipped = [];

  const sessions = await discoverNativeSessions('claude', {
    root,
    projectsDir,
    onDiscoveryError: (details) => skipped.push(details)
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'healthy');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].path, invalid);
});
