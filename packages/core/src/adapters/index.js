import fs from 'node:fs/promises';
import path from 'node:path';
import { readManifest } from '../store.js';
import { resolveLedger } from '../fs-utils.js';
import { importSignature } from './common.js';
import { discoverClaudeSessions, importClaudeSession } from './claude-code.js';
import { discoverCodexSessions, importCodexSession } from './codex.js';
import { discoverCursorSessions, importCursorSession } from './cursor.js';
import { discoverGeminiSessions, importGeminiSession } from './gemini.js';

export async function discoverNativeSessions(provider, options = {}) {
  const normalized = normalizeNativeProvider(provider);
  if (normalized === 'claude') return discoverClaudeSessions(options);
  if (normalized === 'codex') return discoverCodexSessions(options);
  if (normalized === 'gemini') return discoverGeminiSessions(options);
  if (normalized === 'cursor') return discoverCursorSessions(options);
  throw new Error(`Unsupported native provider: ${provider}`);
}

export async function importNativeSession(root, provider, options = {}) {
  const normalized = normalizeNativeProvider(provider);
  const sessions = await discoverNativeSessions(normalized, {
    ...options,
    all: options.path || options.sessionId ? true : options.all,
    limit: options.path || options.sessionId ? 10000 : options.limit
  });
  const session = selectSession(sessions, options);
  if (!session) {
    throw new Error(`No ${normalized} native session matched the requested filters.`);
  }
  // An import re-reads the whole native file, which for a long thread takes
  // a minute. When the file has not changed since it was last imported with
  // the same options, the ledger already holds exactly what would be written.
  if (!options.force) {
    const previous = await unchangedImport(root, session, options);
    if (previous) return previous;
  }
  if (normalized === 'claude') return importClaudeSession(root, session, options);
  if (normalized === 'codex') return importCodexSession(root, session, options);
  if (normalized === 'gemini') return importGeminiSession(root, session, options);
  if (normalized === 'cursor') return importCursorSession(root, session, options);
  throw new Error(`Unsupported native provider: ${provider}`);
}

export function selectSession(sessions, options = {}) {
  if (options.path) {
    return sessions.find((session) => session.path === options.path || session.path === String(options.path));
  }
  if (options.sessionId) {
    return sessions.find((session) => session.sessionId === options.sessionId);
  }
  if (options.last || !options.sessionId) {
    return sessions[0];
  }
  return null;
}

// The ledger entry a native file was last imported into, when that file has
// not changed since and the import was shaped by the same options.
async function unchangedImport(root, session, options) {
  if (!session.path || !Number.isFinite(session.size) || !Number.isFinite(session.mtimeMs)) return undefined;
  let manifest;
  try {
    manifest = await readManifest(root);
  } catch {
    return undefined;
  }
  const entry = (manifest?.sessions || []).find((item) => item?.sourcePath === session.path);
  if (!entry || entry.sourceSize !== session.size || entry.sourceMtimeMs !== session.mtimeMs) return undefined;
  if ((entry.importSignature || '') !== importSignature(options)) return undefined;
  const absolute = path.join(resolveLedger(root), entry.path);
  try {
    await fs.access(absolute);
  } catch {
    return undefined;
  }
  return { id: entry.id, path: absolute, relativePath: entry.path, turnCount: entry.turnCount, unchanged: true };
}

export function normalizeNativeProvider(provider) {
  const value = String(provider || '').toLowerCase();
  if (value === 'claude' || value === 'anthropic') return 'claude';
  if (value === 'codex' || value === 'openai' || value === 'chatgpt') return 'codex';
  if (value === 'gemini' || value === 'google') return 'gemini';
  if (value === 'cursor' || value === 'cursor-agent' || value === 'agent') return 'cursor';
  return value;
}
