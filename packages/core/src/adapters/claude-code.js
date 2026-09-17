import fs from 'node:fs/promises';
import path from 'node:path';
import { createTurn } from '../schema.js';
import { writeSession } from '../store.js';
import {
  createBoundedTurnCollector,
  homePath,
  jsonlFileInfo,
  listJsonlFiles,
  oversizedLineSummary,
  pathsOverlap,
  cachedDiscovery,
  importSignature,
  readFirstJsonlObjects,
  readJsonlObjects,
  readLastJsonlObjects,
  reportDiscoveryError
} from './common.js';
import { describeRequests, readLatestRequest } from './preview.js';

export const CLAUDE_PROVIDER = 'anthropic';

// Claude Code records each subagent the Agent tool launches in its own file
// beside the parent transcript:
//
//   <projects>/<project>/<session-id>.jsonl                          parent
//   <projects>/<project>/<session-id>/subagents/agent-<agent-id>.jsonl
//   <projects>/<project>/<session-id>/subagents/agent-<agent-id>.meta.json
//
// Every line of a subagent file carries `isSidechain: true`, its `agentId` and
// the parent's `sessionId`. The meta file names the agent the way the Agent
// map does. Context compaction reuses the layout with `acompact-` ids and no
// meta file.
const SUBAGENTS_DIR = 'subagents';
const SUBAGENT_FILE = /^agent-(.+)$/;

export async function discoverClaudeSessions(options = {}) {
  const root = options.root || process.cwd();
  const projectsDir = options.projectsDir || homePath('.claude', 'projects');
  const files = options.path
    ? [await jsonlFileInfo(options.path)]
    : await listJsonlFiles(projectsDir, {
        signal: options.signal,
        maxFiles: options.maxDiscoveryFiles,
        maxEntries: options.maxDiscoveryEntries
      });
  const sessions = [];

  for (const file of files.slice(0, options.limit || 200)) {
    options.signal?.throwIfAborted();
    try {
      const agentId = subagentFileId(file.path);
      // A subagent run is machinery of its parent, so it is listed only on
      // request. Naming the file directly is a request.
      if (agentId && !options.includeSubagents && !options.path) continue;

      const { meta, matchesProject, latest } = await cachedDiscovery(options, file, root, async () => {
        const meta = await inspectClaudeFile(file.path, options);
        const matchesProject = meta.cwd ? await pathsOverlap(meta.cwd, root) : false;
        // Only sessions that could be offered as a choice get the extra tail read.
        const latest = matchesProject ? (await latestClaudeRequest(file.path, options)) || meta.last : undefined;
        return { meta, matchesProject, latest };
      });
      if (!options.all && !matchesProject) continue;
      const agent = agentId ? await describeSubagent(file.path, agentId, meta) : undefined;
      const title = agent?.description || meta.title || meta.first;
      const named = Boolean(agent?.description || meta.title);

      sessions.push({
        provider: CLAUDE_PROVIDER,
        surface: 'cli',
        path: file.path,
        sessionId: agent ? agent.sessionId : meta.sessionId || path.basename(file.path, '.jsonl'),
        cwd: meta.cwd,
        title,
        // Claude names most sessions itself, so say whether this is that name or
        // a stand-in derived from the opening request.
        named,
        opening: named && meta.first !== title ? meta.first : undefined,
        latest: latest && latest !== title ? latest : undefined,
        modifiedAt: file.modifiedAt,
        mtimeMs: file.mtimeMs,
        size: file.size,
        matchesProject,
        subagent: agent ? true : undefined,
        agentId: agent?.agentId,
        agentType: agent?.agentType,
        parentSessionId: agent?.parentSessionId
      });
    } catch (error) {
      reportDiscoveryError(options, file.path, error);
    }
  }

  return sessions;
}

export async function importClaudeSession(root, session, options = {}) {
  const collector = createBoundedTurnCollector(options);
  const ledgerSessionId = `native-claude-${session.sessionId}`;
  const launches = [];
  await readJsonlObjects(session.path, (event, lineNumber) => {
    const turn = claudeEventToTurn(event, session, lineNumber);
    collector.push(turn);
    const launch = backgroundAgentLaunch(event);
    // The agent's own transcript is spliced in right after the turn that
    // launched it, which is where a reader expects the result.
    if (launch) launches.push({ ...launch, after: collector.turns.length });
  }, options);

  const turns = launches.length > 0
    ? await spliceSubagents(collector.turns, launches, session, options)
    : collector.turns;
  if (turns.length === 0) throw new Error(`No importable Claude turns found in ${session.path}`);
  return writeSession(root, turns, {
    provider: CLAUDE_PROVIDER,
    surface: 'cli',
    sessionId: ledgerSessionId,
    sourcePath: session.path,
    sourceSize: session.size,
    sourceMtimeMs: session.mtimeMs,
    importSignature: importSignature(options),
    nativeSessionId: session.subagent ? session.parentSessionId : session.sessionId,
    title: session.title,
    named: session.named
  });
}

export function claudeEventToTurn(event, session, lineNumber, extra = {}) {
  const role = claudeRole(event);
  const content = claudeContent(event);
  if (!content.trim()) return null;

  return createTurn(
    {
      id: event.uuid,
      role,
      timestamp: event.timestamp,
      content,
      metadata: {
        nativeProvider: 'claude-code',
        nativeType: event.type,
        nativeSessionId: event.sessionId || session.parentSessionId || session.sessionId,
        nativePath: session.path,
        lineNumber,
        cwd: event.cwd || session.cwd,
        ...(event.agentId ? { nativeAgentId: event.agentId } : {}),
        ...extra
      }
    },
    {
      provider: CLAUDE_PROVIDER,
      surface: 'cli',
      sessionId: `native-claude-${session.sessionId}`
    }
  );
}

function claudeRole(event) {
  if (event.message?.role) return event.message.role;
  // A background agent's completion notice is queued for the model, not
  // written by it. It reads as a status line.
  if (event.type === 'queue-operation' && taskNotification(event.content)) return 'system';
  return event.type;
}

function claudeContent(event) {
  if (event.message?.content !== undefined) return contentBlocksToText(event.message.content);
  if (event.toolUseResult !== undefined) return contentBlocksToText(event.toolUseResult);
  if (event.attachment !== undefined) return contentBlocksToText(event.attachment);
  if (event.aiTitle) return `Title: ${event.aiTitle}`;
  if (event.operation) {
    const notification = taskNotification(event.content);
    return notification ? taskNotificationSummary(notification) : `Queue operation: ${event.operation}`;
  }
  if (event.type === 'parse_error') return `Parse error: ${event.error}\n${event.rawLine}`;
  if (event.type === 'oversized_line') return oversizedLineSummary(event);
  return '';
}

function contentBlocksToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(contentBlocksToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.name === 'string' && value.input) {
      return `Tool call: ${value.name}\n${JSON.stringify(value.input, null, 2)}`;
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

// Claude Code queues a <task-notification> block into the parent when a
// background agent stops. Only its status and summary say anything to a
// reader; the rest points at files of the live session.
function taskNotification(content) {
  if (typeof content !== 'string' || !/^\s*<task-notification>/.test(content)) return undefined;
  const field = (name) => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content);
    return match ? match[1].trim() : undefined;
  };
  return {
    taskId: field('task-id'),
    toolUseId: field('tool-use-id'),
    status: field('status'),
    summary: field('summary')
  };
}

function taskNotificationSummary(notification) {
  const parts = [`Subagent notification`];
  if (notification.status) parts.push(`(${notification.status})`);
  const head = parts.join(' ');
  return notification.summary ? `${head}: ${notification.summary}` : head;
}

// A foreground Agent call returns its report inside the tool result, so the
// parent already has it. A background launch returns only an id and the
// report lands in the agent's own file.
function backgroundAgentLaunch(event) {
  const result = event.toolUseResult;
  if (!result || typeof result !== 'object' || typeof result.agentId !== 'string') return undefined;
  if (!(result.isAsync || result.status === 'async_launched')) return undefined;
  return {
    agentId: result.agentId,
    description: typeof result.description === 'string' ? result.description : undefined,
    toolUseId: toolResultId(event)
  };
}

function toolResultId(event) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  return blocks.find((block) => block?.type === 'tool_result')?.tool_use_id;
}

async function spliceSubagents(turns, launches, session, options) {
  const inserts = new Map();
  for (const launch of launches) {
    options.signal?.throwIfAborted();
    const spliced = await readSubagent(session, launch, options);
    if (spliced.length === 0) continue;
    inserts.set(launch.after, [...(inserts.get(launch.after) || []), ...spliced]);
  }
  if (inserts.size === 0) return turns;

  const collector = createBoundedTurnCollector(options);
  turns.forEach((turn, index) => {
    collector.push(turn);
    for (const extra of inserts.get(index + 1) || []) collector.push(extra);
  });
  // A launch recorded before any turn survived, or after the last one.
  for (const extra of inserts.get(0) || []) collector.push(extra);
  return collector.turns;
}

// Reads one subagent recording and returns the turns to splice into the
// parent: by default a single turn carrying the agent's final report, or the
// whole recording when the caller asked for subagent transcripts.
async function readSubagent(session, launch, options) {
  const filePath = subagentPath(session, launch.agentId);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  const agent = await describeSubagent(filePath, launch.agentId, {
    recordedSessionId: session.subagent ? session.parentSessionId : session.sessionId
  });
  const description = launch.description || agent.description || launch.agentId;
  const agentSession = {
    ...session,
    path: filePath,
    subagent: true,
    agentId: launch.agentId,
    parentSessionId: agent.parentSessionId
  };
  const extra = { nativeAgentId: launch.agentId, subagentDescription: description };

  const transcript = [];
  let report;
  let lastAssistantText;
  let lastTimestamp;
  let count = 0;
  await readJsonlObjects(filePath, (event, lineNumber) => {
    options.signal?.throwIfAborted();
    if (event.message) count++;
    lastTimestamp = event.timestamp || lastTimestamp;
    const handback = subagentHandback(event);
    if (handback) report = handback;
    else if (event.type === 'assistant') {
      const text = assistantText(event);
      if (text) lastAssistantText = text;
    }
    if (options.subagentTranscripts) {
      const turn = claudeEventToTurn(event, agentSession, lineNumber, extra);
      if (turn) transcript.push(turn);
    }
  }, options);

  const label = `Subagent "${description}"${agent.agentType ? ` (${agent.agentType})` : ''}`;
  const timestamp = lastTimestamp || new Date(stat.mtimeMs).toISOString();
  const metadata = {
    nativeProvider: 'claude-code',
    nativeType: 'subagent',
    nativeSessionId: agent.parentSessionId,
    nativePath: filePath,
    ...extra,
    subagentType: agent.agentType,
    subagentTurns: count
  };
  const defaults = { provider: CLAUDE_PROVIDER, surface: 'cli', sessionId: `native-claude-${session.sessionId}` };

  const summary = report || lastAssistantText;
  const reportTurn = summary
    ? createTurn({
        id: `${launch.toolUseId || launch.agentId}-report`,
        role: 'assistant',
        timestamp,
        content: `${label} reported after ${count} turns:\n\n${summary}`,
        metadata
      }, defaults)
    : createTurn({
        id: `${launch.toolUseId || launch.agentId}-report`,
        role: 'system',
        timestamp,
        content: `${label} has recorded ${count} turns and no final report yet.`,
        metadata
      }, defaults);

  if (!options.subagentTranscripts) return [reportTurn];

  const header = createTurn({
    id: `${launch.toolUseId || launch.agentId}-start`,
    role: 'system',
    timestamp: transcript[0]?.timestamp || timestamp,
    content: `${label} transcript begins (${count} turns).`,
    metadata
  }, defaults);
  return [header, ...transcript, reportTurn];
}

// The agent hands its report to the parent through one tool call; its message
// is the report verbatim.
function subagentHandback(event) {
  if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return undefined;
  for (const block of event.message.content) {
    if (block?.type === 'tool_use' && block.name === 'SubagentHandback' && typeof block.input?.message === 'string') {
      return block.input.message;
    }
  }
  return undefined;
}

function assistantText(event) {
  const content = event.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function subagentFileId(filePath) {
  const match = SUBAGENT_FILE.exec(path.basename(filePath, '.jsonl'));
  if (!match) return undefined;
  if (path.basename(path.dirname(filePath)) !== SUBAGENTS_DIR) return undefined;
  return match[1];
}

// Agents launched by an agent are recorded in the same folder as their parent.
function subagentPath(session, agentId) {
  const dir = session.subagent
    ? path.dirname(session.path)
    : path.join(path.dirname(session.path), path.basename(session.path, '.jsonl'), SUBAGENTS_DIR);
  return path.join(dir, `agent-${agentId}.jsonl`);
}

// What the Agent map shows for a subagent: the description its parent gave it
// and the agent type. Both live in the meta file; the transcript itself only
// says which parent it belongs to.
async function describeSubagent(filePath, agentId, meta) {
  const parentSessionId = meta.recordedSessionId || path.basename(path.dirname(path.dirname(filePath)));
  let description;
  let agentType;
  try {
    const raw = await fs.readFile(filePath.replace(/\.jsonl$/i, '.meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.description === 'string' && parsed.description.trim()) description = parsed.description.trim();
    if (typeof parsed?.agentType === 'string' && parsed.agentType.trim()) agentType = parsed.agentType.trim();
  } catch {
    // No meta file (compaction agents) or an unreadable one: the transcript
    // still identifies the run.
  }
  if (!agentType && agentId.startsWith('acompact-')) agentType = 'compact';
  return {
    agentId,
    parentSessionId,
    sessionId: `${parentSessionId}-agent-${agentId}`,
    description,
    agentType
  };
}

async function inspectClaudeFile(filePath, options) {
  const objects = await readFirstJsonlObjects(filePath, 80, options);
  let cwd;
  let sessionId;
  let title;
  const messages = [];

  for (const event of objects) {
    cwd ||= event.cwd;
    sessionId ||= event.sessionId;
    // Claude Code names most sessions itself. That is a real chat name and
    // beats anything derived from the transcript.
    title ||= event.aiTitle;
    if (event.type === 'user') messages.push(claudeMessageText(event));
  }

  return {
    cwd,
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    // The id the transcript itself records, absent when it records none.
    recordedSessionId: sessionId,
    title,
    // Only used when the session has no name of its own.
    ...describeRequests(messages)
  };
}

function latestClaudeRequest(filePath, options) {
  return readLatestRequest(
    filePath,
    (objects) => objects.filter((event) => event.type === 'user').map(claudeMessageText),
    options
  );
}

function claudeMessageText(event) {
  const content = event?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ');
}
