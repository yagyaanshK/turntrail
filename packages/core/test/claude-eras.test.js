import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeSessions, importNativeSession, initStore, readAllTurns } from '../src/index.js';

// How Claude Code has named sessions and recorded subagents over time. Current
// builds keep the user's name in `custom-title` records and Claude's own in
// `ai-title` records, re-appending both as they change; earlier builds named a
// session by a `summary` record. Subagents have their own files under
// <session>/subagents/ now, sat beside the parent transcript as agent-*.jsonl
// in 2.0-era builds, and before that were written into the parent itself,
// marked `isSidechain`.

const SESSION = '5b0c1a7e-0000-4000-8000-000000000001';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-era-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initStore(root);
  const projectsDir = path.join(root, 'claude-projects');
  const projectDir = path.join(projectsDir, 'c--project');
  await fs.mkdir(projectDir, { recursive: true });
  const line = (event) => JSON.stringify({ sessionId: SESSION, cwd: root, version: '2.1.296', ...event });
  const write = (name, events) => fs.writeFile(path.join(projectDir, name), events.map(line).join('\n') + '\n', 'utf8');
  return { root, projectsDir, projectDir, write };
}

const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (uuid, text, extra = {}) => ({ type: 'assistant', uuid, timestamp: '2026-10-01T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

test('the name the user gave a session wins, and the latest of each name is shown', async (t) => {
  const { root, projectsDir, write } = await project(t);
  const filler = 'x'.repeat(2000);
  await write(`${SESSION}.jsonl`, [
    user('u1', 'Review the pricing offer for the bank'),
    { type: 'ai-title', aiTitle: 'Review pricing offer' },
    { type: 'custom-title', customTitle: 'CIBC' },
    // Far enough on that the early records are no longer near the end.
    ...Array.from({ length: 60 }, (_, index) => assistant(`a${index}`, filler)),
    { type: 'ai-title', aiTitle: 'Create competitive pricing offer' },
    { type: 'custom-title', customTitle: 'CIBC (handoff)' },
    user('u2', 'Now draft the email that goes with the offer')
  ]);

  const [session] = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(session.title, 'CIBC (handoff)');
  assert.equal(session.named, true);
  assert.equal(session.opening, 'Review the pricing offer for the bank');
  assert.equal(session.latest, 'Now draft the email that goes with the offer');
});

test('without a name of the user\'s, Claude\'s latest generated title is shown', async (t) => {
  const { root, projectsDir, write } = await project(t);
  await write(`${SESSION}.jsonl`, [
    user('u1', 'Read the project documentation in the docs folder'),
    { type: 'ai-title', aiTitle: 'Review project documentation' },
    assistant('a1', 'Read it.'),
    { type: 'ai-title', aiTitle: 'Understand project scope from documentation' }
  ]);
  const [session] = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(session.title, 'Understand project scope from documentation');
});

test('a session from before generated titles is named by its summary, unless the summary is an error', async (t) => {
  const { root, projectsDir, write } = await project(t);
  await write(`${SESSION}.jsonl`, [
    { type: 'summary', summary: 'Fix the login redirect loop', leafUuid: 'leaf-1' },
    user('u1', 'The login page keeps redirecting to itself after sign in')
  ]);
  let [session] = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(session.title, 'Fix the login redirect loop');

  await write(`${SESSION}.jsonl`, [
    { type: 'summary', summary: 'API Error: 404 {"type":"error","error":{"type":"not_found_error"}}', leafUuid: 'leaf-1' },
    user('u1', 'The login page keeps redirecting to itself after sign in')
  ]);
  [session] = await discoverNativeSessions('claude', { root, projectsDir, discoveryCache: new Map() });
  assert.equal(session.title, 'The login page keeps redirecting to itself after sign in');
  assert.equal(session.named, false);
});

test('a subagent written into the parent transcript is neither the request nor part of the import', async (t) => {
  const { root, projectsDir, write } = await project(t);
  await write(`${SESSION}.jsonl`, [
    user('u1', 'Find every place the old API client is still used'),
    assistant('a1', 'Launching a search agent.'),
    user('s1', 'Search the repository for imports of legacy-client and list them.', { isSidechain: true }),
    assistant('s2', 'Found three imports in src/billing.', { isSidechain: true }),
    user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'Three imports remain, all in src/billing.' }]),
    assistant('a2', 'Three imports remain, all in src/billing.')
  ]);

  const [session] = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(session.title, 'Find every place the old API client is still used');
  assert.equal(session.latest, undefined, 'the subagent\'s prompt is not offered as the latest request');

  await importNativeSession(root, 'claude', { root, projectsDir, last: true });
  const contents = (await readAllTurns(root)).map((turn) => turn.content);
  assert.ok(!contents.some((content) => content.includes('Search the repository for imports')));
  assert.ok(!contents.some((content) => content.includes('Found three imports in src/billing.')));
  assert.ok(contents.some((content) => content.includes('Three imports remain, all in src/billing.')), 'the report the parent received is kept');
});

test('a subagent recorded beside its parent, as 2.0-era builds did, is a subagent', async (t) => {
  const { root, projectsDir, write } = await project(t);
  const agent = 'b42c9d1e7f0a3b5c6';
  await write(`${SESSION}.jsonl`, [
    user('u1', 'Check the fellowship page for the new cycle'),
    user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_launch', content: `Async agent launched successfully.\nagentId: ${agent}` }], {
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: agent, description: 'Re-check the fellowship cycle' }
    }),
    assistant('a1', 'The check is running.')
  ]);
  await write(`agent-${agent}.jsonl`, [
    user('s1', 'Fetch the fellowship page and report.', { isSidechain: true, agentId: agent }),
    assistant('s2', 'Applications open in October.', { isSidechain: true, agentId: agent })
  ]);

  const listed = await discoverNativeSessions('claude', { root, projectsDir });
  assert.deepEqual(listed.map((session) => session.sessionId), [SESSION], 'the agent is not listed as a chat of its own');

  const withAgents = await discoverNativeSessions('claude', { root, projectsDir, includeSubagents: true });
  const recorded = withAgents.find((session) => session.subagent);
  assert.equal(recorded.sessionId, `${SESSION}-agent-${agent}`);
  assert.equal(recorded.parentSessionId, SESSION);
  assert.equal(recorded.title, 'Fetch the fellowship page and report.');

  await importNativeSession(root, 'claude', { root, projectsDir, sessionId: SESSION });
  const contents = (await readAllTurns(root)).map((turn) => turn.content);
  assert.ok(contents.some((content) => content.includes('Applications open in October.')), 'the agent\'s report is spliced in from beside the parent');
});

test('the editor\'s note about the open file is not taken for the request', async (t) => {
  const { root, projectsDir, write } = await project(t);
  await write(`${SESSION}.jsonl`, [
    user('u1', [
      { type: 'text', text: '<ide_opened_file>The user opened the file d:\work\notes.md in the IDE. This may or may not be related to the current task.</ide_opened_file>' },
      { type: 'text', text: 'Turn these notes into a project plan' }
    ])
  ]);
  const [session] = await discoverNativeSessions('claude', { root, projectsDir });
  assert.equal(session.title, 'Turn these notes into a project plan');
});
