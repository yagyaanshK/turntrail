import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCodexStorage, discoverNativeSessions, importNativeSession, initStore, readAllTurns } from '../src/index.js';

// One fixture per layout Codex has written, so a change for a new Codex build
// cannot quietly break an older one. The layouts follow Codex's own rollout
// writers: the TypeScript CLI (April to August 2025), Rust 0.2 to 0.30, Rust
// 0.31 and later, and 2026 builds. Add a fixture here whenever Codex changes.

const AGENTS = '# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nAsk before acting.\n</INSTRUCTIONS>';
const environment = (cwd) => `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>bash</shell>\n</environment_context>`;
const userItem = (...texts) => ({ type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) });
const assistantItem = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

const ERAS = {
  // One JSON document per session, written on every update.
  'TypeScript CLI (.json)': {
    file: 'rollout-2025-04-20-ts-session.json',
    project: false,
    content: (root) => JSON.stringify({
      session: { timestamp: '2025-04-20T10:00:00.000Z', id: 'ts-session', instructions: 'Be terse.' },
      items: [
        userItem('Port the parser from the old prototype to TypeScript'),
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', name: 'shell', arguments: '{"command":["ls","src"]}', call_id: 'call_1' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"output":"parser.js\\n"}' },
        assistantItem('Ported the parser; the tests pass.'),
        userItem('Now add the missing error messages to the parser')
      ]
    }, null, 2),
    title: 'Port the parser from the old prototype to TypeScript',
    latest: 'Now add the missing error messages to the parser',
    turns: ['Port the parser', 'Tool call: shell', 'parser.js', 'Ported the parser', 'Now add the missing error']
  },
  // Bare metadata line, bare items, and state snapshots.
  'Rust 0.2 to 0.30': {
    file: 'rollout-2025-07-01T10-00-00-rust-early.jsonl',
    project: true,
    content: (root) => [
      { id: 'rust-early', timestamp: '2025-07-01T10:00:00.000Z', instructions: null, git: { commit_hash: 'abc123', branch: 'main' } },
      { record_type: 'state' },
      userItem(environment(root)),
      userItem('Find why the nightly build fails on Windows runners'),
      { type: 'local_shell_call', call_id: 'call_1', status: 'completed', action: { type: 'exec', command: ['npm', 'run', 'build'] } },
      { type: 'function_call_output', call_id: 'call_1', output: '{"output":"error: path too long"}' },
      assistantItem('The build fails because a generated path exceeds MAX_PATH.'),
      { record_type: 'state' },
      userItem('Shorten the generated paths and rerun the build')
    ].map((line) => JSON.stringify(line)).join('\n'),
    title: 'Find why the nightly build fails on Windows runners',
    latest: 'Shorten the generated paths and rerun the build',
    turns: ['Find why the nightly build', 'Tool call: shell\nnpm run build', 'path too long', 'exceeds MAX_PATH', 'Shorten the generated paths']
  },
  // Wrapped records, every message in both streams.
  'Rust 0.31 to 2025': {
    file: 'rollout-2025-10-02T20-36-46-rust-wrapped.jsonl',
    project: true,
    content: (root) => [
      { timestamp: '2025-10-02T20:36:46.000Z', type: 'session_meta', payload: { id: 'rust-wrapped', cwd: root, originator: 'codex_vscode' } },
      { timestamp: '2025-10-02T20:36:47.000Z', type: 'response_item', payload: userItem(AGENTS) },
      { timestamp: '2025-10-02T20:36:47.000Z', type: 'response_item', payload: userItem(environment(root)) },
      { timestamp: '2025-10-02T20:36:48.000Z', type: 'response_item', payload: userItem('Draft the release notes for version two') },
      { timestamp: '2025-10-02T20:36:48.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Draft the release notes for version two' } },
      { timestamp: '2025-10-02T20:36:50.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } },
      { timestamp: '2025-10-02T20:36:51.000Z', type: 'response_item', payload: assistantItem('Here are the release notes.') },
      { timestamp: '2025-10-02T20:36:51.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Here are the release notes.' } },
      { timestamp: '2025-10-02T20:37:10.000Z', type: 'response_item', payload: userItem('Make the release notes shorter and friendlier') },
      { timestamp: '2025-10-02T20:37:10.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Make the release notes shorter and friendlier' } }
    ].map((line) => JSON.stringify(line)).join('\n'),
    title: 'Draft the release notes for version two',
    latest: 'Make the release notes shorter and friendlier',
    turns: ['Draft the release notes', 'Here are the release notes.', 'Make the release notes shorter']
  },
  // Ordinals, token usage records, and no user_message events.
  '2026 builds': {
    file: 'rollout-2026-10-14T01-00-00-paged.jsonl',
    project: true,
    content: (root) => [
      { timestamp: '2026-10-14T01:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 'paged', cwd: root, originator: 'codex_vscode' } },
      { timestamp: '2026-10-14T01:00:01.000Z', ordinal: 1, type: 'world_state', payload: { cwd: root } },
      { timestamp: '2026-10-14T01:00:01.000Z', ordinal: 2, type: 'response_item', payload: userItem(AGENTS, environment(root)) },
      { timestamp: '2026-10-14T01:00:02.000Z', ordinal: 3, type: 'response_item', payload: userItem('Audit the admissions data for the fourth batch') },
      { timestamp: '2026-10-14T01:00:03.000Z', ordinal: 4, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'agentMessage' } } },
      { timestamp: '2026-10-14T01:00:04.000Z', ordinal: 5, type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' } },
      { timestamp: '2026-10-14T01:00:05.000Z', ordinal: 6, type: 'token_usage_record', payload: { usage: { input_tokens: 10, output_tokens: 2 } } },
      { timestamp: '2026-10-14T01:00:06.000Z', ordinal: 7, type: 'response_item', payload: assistantItem('The fourth batch is audited.') },
      { timestamp: '2026-10-14T01:00:07.000Z', ordinal: 8, type: 'response_item', payload: userItem('Now rewrite the summary of the outreach email') }
    ].map((line) => JSON.stringify(line)).join('\n'),
    title: 'Audit the admissions data for the fourth batch',
    latest: 'Now rewrite the summary of the outreach email',
    turns: ['Audit the admissions data', 'Tool call: apply_patch', 'The fourth batch is audited.', 'Now rewrite the summary']
  }
};

async function era(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-era-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initStore(root);
  const home = path.join(root, 'codex-home');
  const sessionsDir = path.join(home, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const fixture = ERAS[name];
  await fs.writeFile(path.join(sessionsDir, fixture.file), fixture.content(root));
  const options = { root, sessionsDir, sessionIndex: path.join(home, 'session_index.jsonl') };
  return { root, home, options, fixture };
}

for (const name of Object.keys(ERAS)) {
  test(`Codex ${name}: the session is listed, described and imported`, async (t) => {
    const { root, home, options, fixture } = await era(t, name);

    // Only the TypeScript CLI recorded no folder at all, so its sessions are
    // offered when listing every project rather than this one.
    const listed = await discoverNativeSessions('codex', { ...options, all: !fixture.project });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].matchesProject, fixture.project);
    assert.equal(listed[0].title, fixture.title);
    if (fixture.project) assert.equal(listed[0].latest, fixture.latest);

    await importNativeSession(root, 'codex', { ...options, last: true, all: true });
    const contents = (await readAllTurns(root)).map((turn) => turn.content);
    for (const expected of fixture.turns) {
      assert.ok(contents.some((content) => content.includes(expected)), `imported turns include "${expected}"`);
    }

    assert.deepEqual(await checkCodexStorage({ homes: [home] }), [], 'a readable era raises no alarm');
  });
}

test('a session resumed after a Codex upgrade is described by the requests in both layouts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-resumed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'codex-home', 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  const lines = [
    // Written by a 2025 build: each request in both streams.
    { timestamp: '2025-10-02T20:00:00.000Z', type: 'session_meta', payload: { id: 'resumed', cwd: root } },
    { timestamp: '2025-10-02T20:00:01.000Z', type: 'response_item', payload: userItem('Plan the database migration for the orders table') },
    { timestamp: '2025-10-02T20:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Plan the database migration for the orders table' } },
    { timestamp: '2025-10-02T20:00:05.000Z', type: 'response_item', payload: assistantItem('Here is the plan.') },
    // Resumed in a 2026 build: requests only as response items.
    { timestamp: '2026-10-14T09:00:00.000Z', ordinal: 4, type: 'response_item', payload: userItem(AGENTS, environment(root)) },
    { timestamp: '2026-10-14T09:00:01.000Z', ordinal: 5, type: 'response_item', payload: userItem('Run the migration against the staging copy first') }
  ];
  await fs.writeFile(path.join(sessionsDir, 'rollout-2025-10-02T20-00-00-resumed.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));

  const [session] = await discoverNativeSessions('codex', { root, sessionsDir, sessionIndex: path.join(root, 'none.jsonl') });
  assert.equal(session.title, 'Plan the database migration for the orders table');
  assert.equal(session.latest, 'Run the migration against the staging copy first');
});

test('a .json file that is not a Codex rollout is not listed as a session', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-codex-json-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, 'pasted-text-attachments.json'), '{"items":[]}');
  assert.deepEqual(await discoverNativeSessions('codex', { root, sessionsDir, all: true, sessionIndex: path.join(root, 'none.jsonl') }), []);
});
