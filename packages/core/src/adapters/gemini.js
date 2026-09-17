import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTurn } from '../schema.js';
import { writeSession } from '../store.js';
import {
  createBoundedTurnCollector,
  DEFAULT_MAX_IMPORTED_CHARS,
  DEFAULT_MAX_IMPORTED_TURNS,
  homePath,
  listSessionFiles,
  pathsOverlap,
  readJsonlObjects,
  reportDiscoveryError,
  sessionFileInfo
} from './common.js';
import { previewOf } from './preview.js';

export const GEMINI_PROVIDER = 'google';
const DEFAULT_MAX_LEGACY_FILE_BYTES = 64 * 1024 * 1024;

export async function discoverGeminiSessions(options = {}) {
  const root = options.root || process.cwd();
  const tempDir = options.tempDir || homePath('.gemini', 'tmp');
  const files = options.path
    ? [await sessionFileInfo(options.path, ['.json', '.jsonl'])]
    : await listSessionFiles(tempDir, {
        extensions: ['.json', '.jsonl'],
        signal: options.signal,
        maxFiles: options.maxDiscoveryFiles,
        maxEntries: options.maxDiscoveryEntries
      });
  const sessions = [];

  for (const file of files.slice(0, options.limit || 300)) {
    options.signal?.throwIfAborted();
    try {
      const relative = path.relative(tempDir, file.path);
      if (!relative.split(path.sep).includes('chats')) continue;
      const data = await readGeminiConversation(file.path, { ...options, metadataOnly: true });
      if (!data || data.kind === 'subagent' || data.messages.length === 0) continue;
      const projectRoot = await geminiProjectRoot(file.path, tempDir, options);
      const hashMatches = data.projectHash && projectHashes(root).has(data.projectHash);
      const directoryMatches = await anyPathOverlaps(data.directories, root, options);
      const markerMatches = projectRoot ? await pathsOverlap(projectRoot, root, options) : false;
      const matchesProject = Boolean(hashMatches || directoryMatches || markerMatches);
      if (!options.all && !matchesProject) continue;
      const requests = data.messages.filter((message) => message.type === 'user').map((message) => messageText(message));

      sessions.push({
        provider: GEMINI_PROVIDER,
        surface: 'cli',
        path: file.path,
        sessionId: data.sessionId || sessionIdFromPath(file.path),
        cwd: projectRoot || data.directories?.[0],
        title: previewOf(requests[0] || data.summary || ''),
        latest: previewOf(requests.at(-1) || ''),
        modifiedAt: data.lastUpdated || file.modifiedAt,
        mtimeMs: file.mtimeMs,
        size: file.size,
        matchesProject
      });
    } catch (error) {
      reportDiscoveryError(options, file.path, error);
    }
  }

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function importGeminiSession(root, session, options = {}) {
  const data = await readGeminiConversation(session.path, options);
  if (!data) throw new Error(`No importable Gemini session found in ${session.path}`);
  const collector = createBoundedTurnCollector(options);
  let index = 0;
  for (const message of data.messages) {
    index++;
    for (const turn of geminiMessageToTurns(message, session, index)) collector.push(turn);
  }
  if (collector.turns.length === 0) throw new Error(`No importable Gemini turns found in ${session.path}`);
  const nativeId = data.sessionId || session.sessionId || sessionIdFromPath(session.path);
  return writeSession(root, collector.turns, {
    provider: GEMINI_PROVIDER,
    surface: 'cli',
    sessionId: `native-gemini-${nativeId}`,
    sourcePath: session.path,
    sourceSize: session.size,
    sourceMtimeMs: session.mtimeMs,
    nativeSessionId: nativeId,
    title: session.title
  });
}

export function geminiMessageToTurns(message, session, index) {
  if (!message || typeof message !== 'object') return [];
  const type = String(message.type || '').toLowerCase();
  const role = type === 'user' ? 'user' : type === 'gemini' || type === 'model' || type === 'assistant' ? 'assistant' : 'system';
  const sessionId = session.sessionId || sessionIdFromPath(session.path);
  const content = messageText(message);
  const turns = [];
  if (content.trim()) {
    turns.push(createTurn({
      id: message.id ? `gemini-${message.id}` : `gemini-${sessionId}-${index}`,
      role,
      timestamp: message.timestamp || session.modifiedAt,
      content,
      metadata: {
        nativeProvider: 'gemini',
        nativeType: message.type,
        nativeSessionId: sessionId,
        nativePath: session.path,
        messageIndex: index,
        model: message.model
      }
    }, { provider: GEMINI_PROVIDER, surface: 'cli', sessionId: `native-gemini-${sessionId}` }));
  }
  for (const [toolIndex, call] of (Array.isArray(message.toolCalls) ? message.toolCalls : []).entries()) {
    const tool = toolCallText(call);
    if (!tool) continue;
    turns.push(createTurn({
      id: `gemini-${message.id || `${sessionId}-${index}`}-tool-${call.id || toolIndex}`,
      role: 'tool',
      timestamp: call.timestamp || message.timestamp || session.modifiedAt,
      content: tool,
      metadata: {
        nativeProvider: 'gemini',
        nativeType: 'toolCall',
        nativeSessionId: sessionId,
        nativePath: session.path,
        messageIndex: index,
        toolName: call.name,
        status: call.status
      }
    }, { provider: GEMINI_PROVIDER, surface: 'cli', sessionId: `native-gemini-${sessionId}` }));
  }
  return turns;
}

async function readGeminiConversation(filePath, options = {}) {
  if (path.extname(filePath).toLowerCase() === '.json') return readLegacyConversation(filePath, options);
  const metadata = {};
  const messages = new Map();
  const order = [];
  const maxMessages = positiveLimit(options.maxImportedTurns, DEFAULT_MAX_IMPORTED_TURNS);
  const maxChars = positiveLimit(options.maxImportedChars, DEFAULT_MAX_IMPORTED_CHARS);
  let chars = 0;
  await readJsonlObjects(filePath, (record) => {
    if (!record || typeof record !== 'object') return;
    if (record.type === 'parse_error' || record.type === 'oversized_line') return;
    if (typeof record.$rewindTo === 'string') {
      const at = order.indexOf(record.$rewindTo);
      const removed = at >= 0 ? order.splice(at) : order.splice(0);
      for (const id of removed) messages.delete(id);
      return;
    }
    if (record.$set && typeof record.$set === 'object') {
      Object.assign(metadata, record.$set);
      return;
    }
    if (typeof record.id === 'string') {
      const serializedSize = safeJson(record).length;
      const previous = messages.get(record.id);
      chars += serializedSize - (previous ? safeJson(previous).length : 0);
      if ((!previous && order.length + 1 > maxMessages) || chars > maxChars) {
        throw new Error(
          `Gemini transcript exceeds the in-memory import safety limit (${maxMessages} messages or ${maxChars} characters). ` +
            'Raise maxImportedTurns/maxImportedChars deliberately or import a smaller session.'
        );
      }
      if (!messages.has(record.id)) order.push(record.id);
      messages.set(record.id, record);
      return;
    }
    if (typeof record.sessionId === 'string' || typeof record.projectHash === 'string') Object.assign(metadata, record);
  }, options);
  const loaded = order.map((id) => messages.get(id)).filter(Boolean);
  if (!metadata.sessionId && loaded.length === 0) return null;
  return { ...metadata, messages: loaded };
}

async function readLegacyConversation(filePath, options) {
  const info = await sessionFileInfo(filePath, ['.json']);
  const limit = options.maxLegacyFileBytes || DEFAULT_MAX_LEGACY_FILE_BYTES;
  if (info.size > limit) throw new Error(`Gemini JSON session exceeds the ${limit}-byte safety limit: ${filePath}`);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? { ...parsed, messages: Array.isArray(parsed.messages) ? parsed.messages : [] }
      : null;
  } catch {
    return null;
  }
}

function messageText(message) {
  const content = partsToText(message.displayContent ?? message.content);
  const thoughts = Array.isArray(message.thoughts)
    ? message.thoughts.map((thought) => [thought.subject, thought.description].filter(Boolean).join(': ')).filter(Boolean)
    : [];
  return [content, thoughts.length ? `Thought summaries:\n${thoughts.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

function partsToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (!Array.isArray(value)) return partToText(value);
  return value.map(partToText).filter(Boolean).join('\n');
}

function partToText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return String(part ?? '');
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) return `Tool call: ${part.functionCall.name || 'unknown'}\n${safeJson(part.functionCall.args)}`;
  if (part.functionResponse) return `Tool result: ${part.functionResponse.name || 'unknown'}\n${safeJson(part.functionResponse.response)}`;
  if (part.inlineData) return `[Inline ${part.inlineData.mimeType || 'media'} omitted by Turntrail]`;
  if (part.fileData?.fileUri) return `[File: ${part.fileData.fileUri}]`;
  return safeJson(part);
}

function toolCallText(call) {
  if (!call || typeof call !== 'object') return '';
  const lines = [`Tool call: ${call.name || 'unknown'}`];
  if (call.args !== undefined) lines.push(safeJson(call.args));
  if (call.result !== undefined && call.result !== null) lines.push(`Result:\n${partsToText(call.result)}`);
  if (call.status) lines.push(`Status: ${call.status}`);
  return lines.join('\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function projectHashes(root) {
  const values = new Set([path.resolve(root)]);
  if (process.platform === 'win32') {
    values.add(path.resolve(root).replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`));
  }
  return new Set([...values].map((value) => crypto.createHash('sha256').update(value).digest('hex')));
}

async function geminiProjectRoot(filePath, tempDir, options) {
  const relative = path.relative(tempDir, filePath);
  const identifier = relative.split(path.sep)[0];
  if (!identifier || identifier === '..') return undefined;
  const marker = path.join(tempDir, identifier, '.project_root');
  try {
    return (await fs.readFile(marker, 'utf8')).trim() || undefined;
  } catch {}
  const registryPath = options.projectsFile || path.join(path.dirname(tempDir), 'projects.json');
  try {
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    return Object.entries(registry.projects || {}).find(([, value]) => value === identifier)?.[0];
  } catch {
    return undefined;
  }
}

async function anyPathOverlaps(paths, root, options) {
  for (const candidate of Array.isArray(paths) ? paths : []) {
    if (await pathsOverlap(candidate, root, options)) return true;
  }
  return false;
}

function sessionIdFromPath(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  return name.startsWith('session-') ? name.slice('session-'.length) : name;
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
