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
  readFirstJsonlObjects,
  readJsonlObjects,
  readLastJsonlObjects,
  reportDiscoveryError
} from './common.js';
import { describeRequests, readLatestRequest } from './preview.js';

export const CLAUDE_PROVIDER = 'anthropic';

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
      const meta = await inspectClaudeFile(file.path, options);
      const matchesProject = meta.cwd ? await pathsOverlap(meta.cwd, root) : false;
      if (!options.all && !matchesProject) continue;

      // Only sessions that could be offered as a choice get the extra tail read.
      const latest = matchesProject ? (await latestClaudeRequest(file.path, options)) || meta.last : undefined;
      const title = meta.title || meta.first;

      sessions.push({
        provider: CLAUDE_PROVIDER,
        surface: 'cli',
        path: file.path,
        sessionId: meta.sessionId || path.basename(file.path, '.jsonl'),
        cwd: meta.cwd,
        title,
        // Claude names most sessions itself, so say whether this is that name or
        // a stand-in derived from the opening request.
        named: Boolean(meta.title),
        opening: meta.title && meta.first !== meta.title ? meta.first : undefined,
        latest: latest && latest !== title ? latest : undefined,
        modifiedAt: file.modifiedAt,
        mtimeMs: file.mtimeMs,
        size: file.size,
        matchesProject
      });
    } catch (error) {
      reportDiscoveryError(options, file.path, error);
    }
  }

  return sessions;
}

export async function importClaudeSession(root, session, options = {}) {
  const collector = createBoundedTurnCollector(options);
  await readJsonlObjects(session.path, (event, lineNumber) => {
    const turn = claudeEventToTurn(event, session, lineNumber);
    collector.push(turn);
  }, options);
  const { turns } = collector;
  if (turns.length === 0) throw new Error(`No importable Claude turns found in ${session.path}`);
  return writeSession(root, turns, {
    provider: CLAUDE_PROVIDER,
    surface: 'cli',
    sessionId: `native-claude-${session.sessionId}`,
    sourcePath: session.path,
    nativeSessionId: session.sessionId,
    title: session.title,
    named: session.named
  });
}

export function claudeEventToTurn(event, session, lineNumber) {
  const role = event.message?.role || event.type;
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
        nativeSessionId: event.sessionId || session.sessionId,
        nativePath: session.path,
        lineNumber,
        cwd: event.cwd || session.cwd
      }
    },
    {
      provider: CLAUDE_PROVIDER,
      surface: 'cli',
      sessionId: `native-claude-${session.sessionId}`
    }
  );
}

function claudeContent(event) {
  if (event.message?.content !== undefined) return contentBlocksToText(event.message.content);
  if (event.toolUseResult !== undefined) return contentBlocksToText(event.toolUseResult);
  if (event.attachment !== undefined) return contentBlocksToText(event.attachment);
  if (event.aiTitle) return `Title: ${event.aiTitle}`;
  if (event.operation) return `Queue operation: ${event.operation}`;
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
