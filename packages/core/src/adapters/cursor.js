import fs from 'node:fs/promises';
import path from 'node:path';
import { createTurn } from '../schema.js';
import { writeSession } from '../store.js';
import {
  createBoundedTurnCollector,
  DEFAULT_MAX_DISCOVERY_ENTRIES,
  DEFAULT_MAX_DISCOVERY_FILES,
  homePath,
  jsonlFileInfo,
  readFirstJsonlObjects,
  readJsonlObjects,
  readLastJsonlObjects,
  reportDiscoveryError
} from './common.js';
import { previewOf } from './preview.js';

export const CURSOR_PROVIDER = 'cursor';

export async function discoverCursorSessions(options = {}) {
  const root = options.root || process.cwd();
  const projectsDir = options.projectsDir || homePath('.cursor', 'projects');
  const files = options.path
    ? [await jsonlFileInfo(options.path)]
    : await listCursorTranscripts(projectsDir, options);
  const expectedKey = cursorProjectKey(root);
  const sessions = [];

  for (const file of files.slice(0, options.limit || 300)) {
    options.signal?.throwIfAborted();
    try {
      const relative = path.relative(projectsDir, file.path);
      const parts = relative.split(path.sep);
      const projectKey = parts[0];
      const isSubagent = parts.includes('subagents');
      if (isSubagent && !options.includeSubagents) continue;
      if (!parts.includes('agent-transcripts')) continue;
      const head = await readFirstJsonlObjects(file.path, 80, options);
      const tail = await readLastJsonlObjects(file.path, 40, undefined, options);
      const requests = [...head, ...tail].filter((record) => cursorRole(record) === 'user').map(cursorRecordText).filter(Boolean);
      if (head.length === 0 && tail.length === 0) continue;
      const matchesProject = projectKeyMatches(projectKey, expectedKey);
      if (!options.all && !matchesProject) continue;
      const sessionId = cursorSessionId(file.path);

      sessions.push({
        provider: CURSOR_PROVIDER,
        surface: 'ide',
        path: file.path,
        sessionId,
        cwd: matchesProject ? path.resolve(root) : undefined,
        title: previewOf(requests[0] || ''),
        latest: previewOf(requests.at(-1) || ''),
        modifiedAt: file.modifiedAt,
        mtimeMs: file.mtimeMs,
        size: file.size,
        matchesProject,
        subagent: isSubagent || undefined
      });
    } catch (error) {
      reportDiscoveryError(options, file.path, error);
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function importCursorSession(root, session, options = {}) {
  const collector = createBoundedTurnCollector(options);
  await readJsonlObjects(session.path, (record, lineNumber) => {
    collector.push(cursorRecordToTurn(record, session, lineNumber));
  }, options);
  if (collector.turns.length === 0) throw new Error(`No importable Cursor turns found in ${session.path}`);
  const nativeId = session.sessionId || cursorSessionId(session.path);
  return writeSession(root, collector.turns, {
    provider: CURSOR_PROVIDER,
    surface: session.surface || 'ide',
    sessionId: `native-cursor-${nativeId}`,
    sourcePath: session.path,
    nativeSessionId: nativeId,
    title: session.title
  });
}

export function cursorRecordToTurn(record, session, lineNumber) {
  if (!record || typeof record !== 'object' || record.type === 'parse_error' || record.type === 'oversized_line') return null;
  const content = cursorRecordText(record);
  if (!content.trim()) return null;
  const nativeRole = cursorRole(record);
  const role = nativeRole === 'model' || nativeRole === 'ai' ? 'assistant' : nativeRole;
  const sessionId = session.sessionId || cursorSessionId(session.path);
  return createTurn({
    id: record.id ? `cursor-${record.id}` : `cursor-${sessionId}-${lineNumber}`,
    role,
    timestamp: record.timestamp || record.createdAt || session.modifiedAt,
    content,
    metadata: {
      nativeProvider: 'cursor',
      nativeRole,
      nativeSessionId: sessionId,
      nativePath: session.path,
      lineNumber
    }
  }, { provider: CURSOR_PROVIDER, surface: session.surface || 'ide', sessionId: `native-cursor-${sessionId}` });
}

export function cursorProjectKey(root) {
  return path.resolve(root)
    .replace(/^([A-Z]):/, (_, drive) => drive.toLowerCase())
    .replace(/[\\/:\s()]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function listCursorTranscripts(projectsDir, options) {
  const files = [];
  let entries = 0;
  const maxEntries = positiveLimit(options.maxDiscoveryEntries, DEFAULT_MAX_DISCOVERY_ENTRIES);
  const maxFiles = positiveLimit(options.maxDiscoveryFiles, DEFAULT_MAX_DISCOVERY_FILES);
  let projects;
  try {
    projects = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    options.signal?.throwIfAborted();
    if (!project.isDirectory()) continue;
    entries++;
    if (entries > maxEntries) throw discoveryLimitError(maxEntries);
    const transcriptRoot = path.join(projectsDir, project.name, 'agent-transcripts');
    let sessionDirs;
    try {
      sessionDirs = await fs.readdir(transcriptRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      options.signal?.throwIfAborted();
      entries++;
      if (entries > maxEntries) throw discoveryLimitError(maxEntries);
      if (!sessionDir.isDirectory()) continue;
      const direct = path.join(transcriptRoot, sessionDir.name, `${sessionDir.name}.jsonl`);
      try {
        files.push(await jsonlFileInfo(direct));
      } catch {}
      if (options.includeSubagents) {
        const subagents = path.join(transcriptRoot, sessionDir.name, 'subagents');
        let children = [];
        try { children = await fs.readdir(subagents, { withFileTypes: true }); } catch {}
        for (const child of children) {
          entries++;
          if (entries > maxEntries) throw discoveryLimitError(maxEntries);
          if (!child.isFile() || path.extname(child.name).toLowerCase() !== '.jsonl') continue;
          files.push(await jsonlFileInfo(path.join(subagents, child.name)));
        }
      }
      if (files.length >= maxFiles) return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function cursorRecordText(record) {
  const message = record.message && typeof record.message === 'object' ? record.message : record;
  return cursorPartsToText(message.content ?? message.text ?? message.message);
}

function cursorPartsToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return String(part ?? '');
    if (typeof part.text === 'string') return part.text;
    if (part.type === 'tool_use' || part.name || part.input) return `Tool call: ${part.name || 'unknown'}\n${safeJson(part.input)}`;
    if (part.type === 'tool_result') return `Tool result:\n${cursorPartsToText(part.content)}`;
    if (part.type === 'image' || part.source?.data) return `[Inline ${part.source?.media_type || 'image'} omitted by Turntrail]`;
    return safeJson(part);
  }).filter(Boolean).join('\n');
}

function cursorRole(record) {
  const role = String(record?.role || record?.message?.role || '').toLowerCase();
  if (role === 'assistant' || role === 'model' || role === 'ai') return 'assistant';
  if (role === 'user' || role === 'human') {
    const parts = record?.message?.content;
    if (Array.isArray(parts) && parts.length > 0 && parts.every((part) => part?.type === 'tool_result')) return 'tool';
    return 'user';
  }
  if (role === 'tool' || role === 'system') return role;
  return 'unknown';
}

function cursorSessionId(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function projectKeyMatches(actual, expected) {
  return process.platform === 'win32'
    ? String(actual).toLowerCase() === String(expected).toLowerCase()
    : actual === expected;
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function discoveryLimitError(limit) {
  return new Error(`Native session discovery exceeded ${limit} filesystem entries. Narrow the provider session directory or raise maxDiscoveryEntries.`);
}
