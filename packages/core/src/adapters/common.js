import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { omitInlineImages } from '../media.js';

export function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export const DEFAULT_MAX_DISCOVERY_FILES = 5000;
export const DEFAULT_MAX_DISCOVERY_ENTRIES = 50000;
export const DEFAULT_MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;
export const DEFAULT_MAX_IMPORTED_TURNS = 50000;
// Measured after inline images are dropped, so this is text. A 1.3 GB
// browser-driven Codex thread came to 77 MB of it.
export const DEFAULT_MAX_IMPORTED_CHARS = 128 * 1024 * 1024;

export async function listJsonlFiles(root, options = {}) {
  return listSessionFiles(root, { ...options, extensions: ['.jsonl'] });
}

export async function listSessionFiles(root, options = {}) {
  const files = [];
  const state = {
    entries: 0,
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_MAX_DISCOVERY_ENTRIES),
    maxFiles: positiveLimit(options.maxFiles, DEFAULT_MAX_DISCOVERY_FILES),
    extensions: new Set((options.extensions || ['.jsonl']).map((item) => String(item).toLowerCase())),
    signal: options.signal
  };
  await walk(root, files, state, 0);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function jsonlFileInfo(filePath) {
  return sessionFileInfo(filePath, ['.jsonl']);
}

export async function sessionFileInfo(filePath, extensions = ['.jsonl']) {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  const allowed = new Set(extensions.map((item) => String(item).toLowerCase()));
  if (!stat.isFile() || !allowed.has(path.extname(absolute).toLowerCase())) {
    throw new Error(`Native session is not a supported ${[...allowed].join(' or ')} file: ${absolute}`);
  }
  return {
    path: absolute,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString()
  };
}

export function createBoundedTurnCollector(options = {}) {
  const maxTurns = positiveLimit(options.maxImportedTurns, DEFAULT_MAX_IMPORTED_TURNS);
  const maxChars = positiveLimit(options.maxImportedChars, DEFAULT_MAX_IMPORTED_CHARS);
  const turns = [];
  let chars = 0;
  return {
    turns,
    push(turn) {
      options.signal?.throwIfAborted();
      if (!turn) return;
      // Every adapter's turns pass through here, so this is where inline
      // image payloads leave: the ledger stores text, and the limit below
      // counts text.
      const images = omitInlineImages(turn.content);
      if (images.omitted > 0) {
        turn.content = images.content;
        turn.metadata = { ...(turn.metadata || {}), inlineImagesOmitted: images.omitted };
      }
      chars += String(turn.content || '').length;
      if (turns.length + 1 > maxTurns || chars > maxChars) {
        throw new Error(
          `Transcript exceeds the in-memory import safety limit (${maxTurns} turns or ${maxChars} content characters). ` +
            'Raise maxImportedTurns/maxImportedChars deliberately or import a smaller session.'
        );
      }
      turns.push(turn);
    }
  };
}

export function reportDiscoveryError(options, filePath, error) {
  if (options.signal?.aborted || options.path) throw error;
  options.onDiscoveryError?.({ path: filePath, error });
}

// Discovery reads the head and tail of every candidate file on every refresh.
// A caller that refreshes often passes a Map in `options.discoveryCache`, and
// a file whose size and mtime have not changed is answered from it instead.
const DISCOVERY_CACHE_LIMIT = 5000;

export async function cachedDiscovery(options, file, root, probe) {
  const cache = options.discoveryCache instanceof Map ? options.discoveryCache : undefined;
  if (!cache) return probe();
  const key = `${file.path}\0${file.size}\0${file.mtimeMs}\0${root}`;
  if (cache.has(key)) return cache.get(key);
  const value = await probe();
  // Entries for files that have since grown are never read again; rather than
  // track them, start over once the map is clearly mostly stale.
  if (cache.size >= DISCOVERY_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

// Which import options change what a native file imports as. Recorded in the
// manifest so an unchanged file is re-imported when the options differ.
export function importSignature(options = {}) {
  return options.subagentTranscripts ? 'subagent-transcripts' : '';
}

// How much of an oversized line is kept for the placeholder: enough to name the
// native record type, never enough to matter for memory.
const OVERSIZED_LINE_HEAD_CHARS = 512;

// Stream a JSONL file one object at a time.
//
// A line longer than `maxLineChars` is never buffered whole. Codex writes a
// `compacted` record on every context compaction that carries the entire
// replacement history, and those lines grow past 8 MiB on long threads. They
// carry nothing the adapters use, so failing the import over one would lose the
// whole session. Instead the reader discards the line as it streams past and
// emits an `oversized_line` placeholder so the adapter can record that a native
// record was skipped, where, and what type it was.
export async function readJsonlObjects(filePath, onObject, options = {}) {
  const maxLineChars = positiveLimit(options.maxLineChars, DEFAULT_MAX_JSONL_LINE_CHARS);
  const lineFilter = typeof options.lineFilter === 'function' ? options.lineFilter : undefined;
  const stream = createReadStream(filePath, { encoding: 'utf8', signal: options.signal });
  let lineNumber = 0;
  // The pieces of the line in progress, joined once when its newline arrives.
  // Appending every chunk to one string instead re-copies all of it each time,
  // which on an 8 MB line means copying gigabytes for a record that is then
  // thrown away.
  let parts = [];
  let pendingChars = 0;
  // Set while the current line has already exceeded the limit and the rest of
  // it is being discarded chunk by chunk until its newline arrives.
  let skipping;

  const emit = async (line) => {
    lineNumber++;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) return;
    // A record the caller has no use for is not worth parsing. Most of a long
    // Codex thread is such records, and parsing them is most of the cost.
    if (lineFilter && lineFilter(line, lineNumber) === false) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parsed = {
        type: 'parse_error',
        error: error.message,
        rawLine: line.slice(0, 4096),
        rawLineClipped: line.length > 4096
      };
    }
    return onObject(parsed, lineNumber);
  };

  const emitOversized = async (head, chars) => {
    lineNumber++;
    return onObject(
      {
        type: 'oversized_line',
        chars,
        maxLineChars,
        rawLine: head.slice(0, OVERSIZED_LINE_HEAD_CHARS),
        rawLineClipped: true
      },
      lineNumber
    );
  };

  const pendingHead = () => {
    let head = '';
    for (const part of parts) {
      head += part;
      if (head.length >= OVERSIZED_LINE_HEAD_CHARS) break;
    }
    return head.slice(0, OVERSIZED_LINE_HEAD_CHARS);
  };

  for await (const chunk of stream) {
    options.signal?.throwIfAborted();
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      if (newline < 0) break;
      const piece = chunk.slice(start, newline);
      start = newline + 1;
      let outcome;
      if (skipping) {
        outcome = await emitOversized(skipping.head, skipping.chars + piece.length);
        skipping = undefined;
      } else {
        const line = parts.length > 0 ? parts.join('') + piece : piece;
        parts = [];
        pendingChars = 0;
        outcome = line.length > maxLineChars ? await emitOversized(line, line.length) : await emit(line);
      }
      if (outcome === false) {
        stream.destroy();
        return;
      }
    }
    if (start < chunk.length) {
      const rest = start === 0 ? chunk : chunk.slice(start);
      if (skipping) {
        skipping.chars += rest.length;
      } else {
        parts.push(rest);
        pendingChars += rest.length;
        if (pendingChars > maxLineChars) {
          skipping = { head: pendingHead(), chars: pendingChars };
          parts = [];
          pendingChars = 0;
        }
      }
    }
  }
  if (skipping) await emitOversized(skipping.head, skipping.chars);
  else if (parts.length > 0) await emit(parts.join(''));
}

// Best-effort name of the native record type on a line that was never parsed.
export function oversizedLineSummary(event) {
  const type = /"type"\s*:\s*"([^"]{1,64})"/.exec(String(event.rawLine || ''))?.[1];
  return `Skipped oversized native record${type ? ` (${type})` : ''}: ${event.chars} characters exceed the ${event.maxLineChars}-character limit.`;
}

export async function readFirstJsonlObjects(filePath, limit = 80, options = {}) {
  const objects = [];
  await readJsonlObjects(
    filePath,
    (object) => {
      objects.push(object);
      return objects.length < limit;
    },
    options
  );
  return objects;
}

export async function pathsSameOrNested(candidate, root, options = {}) {
  if (!candidate || !root) return false;
  const [resolvedCandidate, resolvedRoot] = await Promise.all([
    normalizePath(candidate, options),
    normalizePath(root, options)
  ]);
  return isSameOrNested(resolvedCandidate, resolvedRoot, options.platform);
}

export async function pathsOverlap(left, right, options = {}) {
  if (!left || !right) return false;
  const [resolvedLeft, resolvedRight] = await Promise.all([
    normalizePath(left, options),
    normalizePath(right, options)
  ]);
  return isSameOrNested(resolvedLeft, resolvedRight, options.platform) ||
    isSameOrNested(resolvedRight, resolvedLeft, options.platform);
}

export async function normalizePath(value, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathApi.resolve(String(value));
  let canonical = resolved;
  try {
    canonical = await (options.realpath || fs.realpath)(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const normalized = pathApi.normalize(canonical);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrNested(candidate, root, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(root, candidate);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

async function walk(root, files, state, depth) {
  state.signal?.throwIfAborted();
  if (depth > 16) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    state.signal?.throwIfAborted();
    state.entries++;
    if (state.entries > state.maxEntries) {
      throw new Error(`Native session discovery exceeded ${state.maxEntries} filesystem entries. Narrow the provider session directory or raise maxDiscoveryEntries.`);
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, state, depth + 1);
    } else if (entry.isFile() && state.extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(await sessionFileInfo(fullPath, [...state.extensions]));
      if (files.length > state.maxFiles) {
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        files.length = state.maxFiles;
      }
    }
  }
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// The tail of a JSONL file, without reading the whole thing.
//
// Session transcripts run to hundreds of megabytes, so "what was asked most
// recently" cannot be answered by streaming from the start. Read a bounded
// window off the end instead and parse the complete lines in it. A window that
// lands mid-line simply yields fewer objects, which is fine: this only ever
// enriches a label.
export async function readLastJsonlObjects(filePath, limit = 40, maxBytes = 256 * 1024, options = {}) {
  let handle;
  try {
    options.signal?.throwIfAborted();
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return [];

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    options.signal?.throwIfAborted();

    const lines = buffer.toString('utf8').split(/\r?\n/);
    // When the window started mid-file the first line is a fragment - and may
    // begin mid-character, which is the other reason to drop it.
    if (start > 0) lines.shift();

    const objects = [];
    for (let index = lines.length - 1; index >= 0 && objects.length < limit; index--) {
      const line = lines[index];
      if (!line || !line.trim()) continue;
      try {
        objects.push(JSON.parse(line));
      } catch {
        // A truncated or oversized line is skipped rather than reported: this
        // path is decorative, and a parse error here is expected at the edges.
      }
    }
    return objects.reverse();
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}
