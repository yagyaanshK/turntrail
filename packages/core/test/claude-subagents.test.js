import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverNativeSessions, importNativeSession } from '../src/index.js';

const PARENT = 'c25c4cd9-1265-4bc9-8608-9c2ea906aaa7';
const AGENT = 'a31ab2e0d90cedeee';
const LAUNCH_TOOL_USE = 'toolu_01Ru4j9d2T8H9hAXPha5VY5P';

// The layout Claude Code writes for a session that launched one background
// agent: the parent transcript, and beside it a folder named after the session
// holding one recording and one meta file per agent.
async function writeMultiAgentSession(root, options = {}) {
  const projectsDir = path.join(root, 'claude-projects');
  const projectDir = path.join(projectsDir, 'c--project');
  const subagentsDir = path.join(projectDir, PARENT, 'subagents');
  await fs.mkdir(subagentsDir, { recursive: true });

  const line = (event) => JSON.stringify({ sessionId: PARENT, cwd: root, version: '2.1.96', ...event });
  const parent = [
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-16T14:00:00.000Z', message: { role: 'user', content: 'Check the fellowship page again' } }),
    line({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-09-16T14:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: LAUNCH_TOOL_USE, name: 'Agent', input: { description: 'Re-check Network School 2026 cycle', subagent_type: 'general-purpose', run_in_background: true, prompt: 'Fetch ns.com/fellowship and report.' } }]
      }
    }),
    line({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-09-16T14:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: LAUNCH_TOOL_USE, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${AGENT}` }] }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT, description: 'Re-check Network School 2026 cycle', prompt: 'Fetch ns.com/fellowship and report.' }
    }),
    line({ type: 'assistant', uuid: 'a2', timestamp: '2026-09-16T14:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The check is running in the background.' }] } }),
    line({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-09-16T14:05:00.000Z',
      content: `<task-notification>\n<task-id>${AGENT}</task-id>\n<tool-use-id>${LAUNCH_TOOL_USE}</tool-use-id>\n<output-file>C:\\tmp\\${AGENT}.output</output-file>\n<status>completed</status>\n<summary>Agent "Re-check Network School 2026 cycle" finished</summary>\n<usage><subagent_tokens>63805</subagent_tokens></usage>\n</task-notification>`
    }),
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-16T14:06:00.000Z', content: 'continue please' }),
    line({ type: 'user', uuid: 'u3', timestamp: '2026-09-16T14:06:01.000Z', message: { role: 'user', content: 'continue please' } })
  ];
  await fs.writeFile(path.join(projectDir, `${PARENT}.jsonl`), parent.join('\n') + '\n', 'utf8');

  if (options.agentFile !== false) {
    const agentLine = (event) => line({ isSidechain: true, agentId: AGENT, ...event });
    const agent = [
      agentLine({ type: 'user', uuid: 's1', parentUuid: null, timestamp: '2026-09-16T14:00:02.500Z', message: { role: 'user', content: 'Fetch ns.com/fellowship and report.' } }),
      agentLine({ type: 'assistant', uuid: 's2', timestamp: '2026-09-16T14:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { url: 'https://ns.com/fellowship' } }] } }),
      agentLine({ type: 'user', uuid: 's3', timestamp: '2026-09-16T14:01:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', content: 'Applications for the 2026 cohort open in October.' }] } }),
      agentLine({ type: 'assistant', uuid: 's4', timestamp: '2026-09-16T14:02:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_handback', name: 'SubagentHandback', input: { message: '# Fellowship check\n\nThe 2026 cohort opens applications in October. No deadline yet.' } }] } }),
      agentLine({ type: 'user', uuid: 's5', timestamp: '2026-09-16T14:02:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_handback', content: 'Report delivered.' }] } }),
      agentLine({ type: 'assistant', uuid: 's6', timestamp: '2026-09-16T14:02:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Report delivered. Nothing to add.' }] } })
    ];
    await fs.writeFile(path.join(subagentsDir, `agent-${AGENT}.jsonl`), agent.join('\n') + '\n', 'utf8');
    if (options.metaFile !== false) {
      await fs.writeFile(
        path.join(subagentsDir, `agent-${AGENT}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', description: 'Re-check Network School 2026 cycle', toolUseId: LAUNCH_TOOL_USE, spawnDepth: 1, requestShape: 'background' }),
        'utf8'
      );
    }
  }

  // Context compaction is recorded the same way, without a meta file.
  await fs.writeFile(
    path.join(subagentsDir, 'agent-acompact-4213b48db2497b26.jsonl'),
    line({ isSidechain: true, agentId: 'acompact-4213b48db2497b26', type: 'user', uuid: 'c1', timestamp: '2026-09-16T14:03:00.000Z', message: { role: 'user', content: 'Summarize the conversation so far.' } }) + '\n',
    'utf8'
  );

  return { projectsDir, parentPath: path.join(projectDir, `${PARENT}.jsonl`), agentPath: path.join(subagentsDir, `agent-${AGENT}.jsonl`) };
}

async function readSession(root, result) {
  const raw = await fs.readFile(path.join(root, '.turntrail', result.relativePath), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('subagent recordings are hidden from discovery until asked for, then listed under their own name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir } = await writeMultiAgentSession(root);

  const sessions = await discoverNativeSessions('claude', { root, projectsDir });
  assert.deepEqual(sessions.map((session) => session.sessionId), [PARENT]);
  assert.equal(sessions[0].subagent, undefined);

  const all = await discoverNativeSessions('claude', { root, projectsDir, includeSubagents: true });
  const byId = new Map(all.map((session) => [session.sessionId, session]));
  assert.equal(all.length, 3);

  const agent = byId.get(`${PARENT}-agent-${AGENT}`);
  assert.ok(agent, 'the agent recording gets an id of its own, so importing it cannot overwrite the parent');
  assert.equal(agent.subagent, true);
  assert.equal(agent.parentSessionId, PARENT);
  assert.equal(agent.agentId, AGENT);
  assert.equal(agent.agentType, 'general-purpose');
  assert.equal(agent.title, 'Re-check Network School 2026 cycle');
  assert.equal(agent.named, true);

  const compaction = byId.get(`${PARENT}-agent-acompact-4213b48db2497b26`);
  assert.ok(compaction);
  assert.equal(compaction.subagent, true);
  assert.equal(compaction.agentType, 'compact');
  assert.equal(compaction.named, false);
});

test('importing the parent splices each background agent report in after its launch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir } = await writeMultiAgentSession(root);

  const result = await importNativeSession(root, 'claude', { root, projectsDir, sessionId: PARENT });
  assert.equal(result.id, `native-claude-${PARENT}`);
  const turns = await readSession(root, result);

  const launchIndex = turns.findIndex((turn) => turn.content.includes('Async agent launched'));
  assert.ok(launchIndex >= 0);
  const report = turns[launchIndex + 1];
  assert.equal(report.role, 'assistant');
  assert.match(report.content, /^Subagent "Re-check Network School 2026 cycle" \(general-purpose\) reported after 6 turns:\n\n# Fellowship check/);
  assert.match(report.content, /opens applications in October/);
  assert.equal(report.metadata.nativeType, 'subagent');
  assert.equal(report.metadata.nativeAgentId, AGENT);
  assert.equal(report.metadata.subagentTurns, 6);
  assert.equal(report.timestamp, '2026-09-16T14:02:02.000Z');
  // The parent's own next turn follows the report.
  assert.equal(turns[launchIndex + 2].content, 'The check is running in the background.');

  const notice = turns.find((turn) => turn.metadata.nativeType === 'queue-operation' && turn.role === 'system');
  assert.equal(notice.content, 'Subagent notification (completed): Agent "Re-check Network School 2026 cycle" finished');
  // An ordinary queued prompt is still just a queue operation.
  assert.ok(turns.some((turn) => turn.content === 'Queue operation: enqueue'));
  // Only the agent report was added; the agent's own working stays in its file.
  assert.equal(turns.filter((turn) => turn.metadata.nativeAgentId).length, 1);
});

test('subagent transcripts can be spliced into the parent whole', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir, agentPath } = await writeMultiAgentSession(root);

  const result = await importNativeSession(root, 'claude', { root, projectsDir, sessionId: PARENT, subagentTranscripts: true });
  const turns = await readSession(root, result);
  const spliced = turns.filter((turn) => turn.metadata.nativeAgentId === AGENT);

  // header + 6 recorded turns + report
  assert.equal(spliced.length, 8);
  assert.equal(spliced[0].role, 'system');
  assert.match(spliced[0].content, /transcript begins \(6 turns\)/);
  assert.equal(spliced[1].content, 'Fetch ns.com/fellowship and report.');
  assert.equal(spliced[1].role, 'user');
  assert.equal(spliced[1].metadata.nativePath, agentPath);
  assert.equal(spliced[1].metadata.nativeSessionId, PARENT);
  assert.equal(spliced[1].sessionId, `native-claude-${PARENT}`);
  assert.match(spliced.at(-1).content, /^Subagent "Re-check Network School 2026 cycle" \(general-purpose\) reported/);

  const launchIndex = turns.findIndex((turn) => turn.content.includes('Async agent launched'));
  assert.equal(turns[launchIndex + 1].id, spliced[0].id);
  assert.equal(turns[launchIndex + 9].content, 'The check is running in the background.');
});

test('a subagent recording imports as its own ledger session, not over its parent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir, agentPath } = await writeMultiAgentSession(root);

  const parent = await importNativeSession(root, 'claude', { root, projectsDir, sessionId: PARENT });
  const agent = await importNativeSession(root, 'claude', { root, projectsDir, path: agentPath });
  assert.equal(agent.id, `native-claude-${PARENT}-agent-${AGENT}`);
  assert.notEqual(agent.id, parent.id);
  assert.equal(agent.turnCount, 6);

  const manifest = JSON.parse(await fs.readFile(path.join(root, '.turntrail', 'manifest.json'), 'utf8'));
  const entry = manifest.sessions.find((session) => session.id === agent.id);
  assert.equal(entry.title, 'Re-check Network School 2026 cycle');
  assert.equal(entry.nativeSessionId, PARENT, 'the chat to return to is the parent');
  // 7 parent turns plus the spliced report, untouched by the agent import.
  assert.equal((await readSession(root, parent)).length, 8);
});

test('a launch whose recording is missing or unnamed still imports', async () => {
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir } = await writeMultiAgentSession(missing, { agentFile: false });
  const result = await importNativeSession(missing, 'claude', { root: missing, projectsDir, sessionId: PARENT });
  const turns = await readSession(missing, result);
  assert.equal(turns.filter((turn) => turn.metadata.nativeAgentId).length, 0);
  assert.equal(turns.length, 7);

  const unnamed = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const layout = await writeMultiAgentSession(unnamed, { metaFile: false });
  const imported = await importNativeSession(unnamed, 'claude', { root: unnamed, projectsDir: layout.projectsDir, sessionId: PARENT });
  const report = (await readSession(unnamed, imported)).find((turn) => turn.metadata.nativeType === 'subagent');
  // The launch names the agent even when the meta file is gone; the type is unknown.
  assert.match(report.content, /^Subagent "Re-check Network School 2026 cycle" reported after 6 turns/);
  assert.equal(report.metadata.subagentType, undefined);
});

test('the newest session is never a subagent recording', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-agents-'));
  const { projectsDir, agentPath } = await writeMultiAgentSession(root);
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(agentPath, future, future);

  const result = await importNativeSession(root, 'claude', { root, projectsDir, last: true });
  assert.equal(result.id, `native-claude-${PARENT}`);
});
