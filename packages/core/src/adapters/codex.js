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
import { readCodexThreadNames } from './codex-index.js';
import { describeRequests, readLatestRequest } from './preview.js';

export const CODEX_PROVIDER = 'openai';

// Codex records a session twice. `event_msg` entries are the UI event stream;
// `response_item` entries are the model transcript. Nearly every message appears
// in both, and `task_complete` repeats the final agent message a third time, so
// a naive import inflates the ledger roughly 2x on exactly the content that
// matters most. Tagging each turn with its source stream lets the collapse pass
// below drop the redundant copy safely.
const EVENT_STREAM = 'event';
const ITEM_STREAM = 'item';
const META_STREAM = 'meta';

// How far back to look for the other stream's copy of a message. The two copies
// are written back-to-back, so this only needs to absorb an interleaved tool
// call or two.
const STREAM_PAIR_WINDOW = 4;

export async function discoverCodexSessions(options = {}) {
  const root = options.root || process.cwd();
  const sessionsDir = options.sessionsDir || homePath('.codex', 'sessions');
  const archivedDir = options.archivedDir || homePath('.codex', 'archived_sessions');
  const files = options.path
    ? [await jsonlFileInfo(options.path)]
    : [
        ...(await listJsonlFiles(sessionsDir, {
          signal: options.signal,
          maxFiles: options.maxDiscoveryFiles,
          maxEntries: options.maxDiscoveryEntries
        })),
        ...(options.includeArchived
          ? await listJsonlFiles(archivedDir, {
              signal: options.signal,
              maxFiles: options.maxDiscoveryFiles,
              maxEntries: options.maxDiscoveryEntries
            })
          : [])
      ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Read once for the whole scan: it is one small file keyed by thread id, and
  // every session below asks it the same question.
  const names = await readCodexThreadNames(options);
  const sessions = [];

  for (const file of files.slice(0, options.limit || 300)) {
    options.signal?.throwIfAborted();
    try {
      const meta = await inspectCodexFile(file.path, options);
      const matchesProject = meta.cwd ? await pathsOverlap(meta.cwd, root) : false;
      if (!options.all && !matchesProject) continue;
      // Only sessions that could actually be offered as a choice get the extra
      // tail read. Scanning every transcript on the machine for this would cost
      // hundreds of reads to decorate rows nobody is choosing between.
      // The tail is authoritative, but a transcript whose last megabytes are one
      // enormous line yields nothing parseable. The head already holds several
      // messages, so fall back to the latest of those before giving up.
      const latest = matchesProject ? (await latestCodexRequest(file.path, options)) || meta.last : undefined;
      const sessionId = meta.sessionId || sessionIdFromCodexPath(file.path);
      // Codex's own name for the thread when it has one - the same text the app
      // sidebar shows. Sessions it never named, such as forks and subagent runs,
      // fall back to being described by their requests.
      const name = names.get(sessionId);
      const title = name || meta.first;

      sessions.push({
        provider: CODEX_PROVIDER,
        surface: meta.source || 'cli',
        path: file.path,
        sessionId,
        cwd: meta.cwd,
        title,
        named: Boolean(name),
        opening: name && meta.first !== name ? meta.first : undefined,
        latest: latest && latest !== meta.preview && latest !== title ? latest : undefined,
        forkedFrom: meta.forkedFrom,
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

export async function importCodexSession(root, session, options = {}) {
  const collector = createBoundedTurnCollector(options);
  await readJsonlObjects(session.path, (event, lineNumber) => {
    const turn = codexEventToTurn(event, session, lineNumber);
    collector.push(turn);
  }, options);
  const { turns } = collector;
  if (turns.length === 0) throw new Error(`No importable Codex turns found in ${session.path}`);
  const collapsed = collapseCodexStreamDuplicates(turns);
  return writeSession(root, collapsed.turns, {
    provider: CODEX_PROVIDER,
    surface: session.surface || 'cli',
    sessionId: `native-codex-${session.sessionId}`,
    sourcePath: session.path,
    nativeSessionId: session.sessionId,
    title: session.title,
    named: session.named
  });
}

export function codexEventToTurn(event, session, lineNumber) {
  const mapped = codexEventContent(event);
  if (!mapped || !mapped.content.trim()) return null;

  return createTurn(
    {
      role: mapped.role,
      timestamp: event.timestamp || event.payload?.timestamp,
      content: mapped.content,
      metadata: {
        nativeProvider: 'codex',
        nativeType: event.type,
        nativePayloadType: event.payload?.type,
        nativeSessionId: session.sessionId,
        nativePath: session.path,
        lineNumber,
        stream: mapped.stream,
        cwd: event.payload?.cwd || session.cwd,
        ...(mapped.media ? { media: mapped.media } : {})
      }
    },
    {
      provider: CODEX_PROVIDER,
      surface: session.surface || 'cli',
      sessionId: `native-codex-${session.sessionId}`
    }
  );
}

function codexEventContent(event) {
  const payload = event.payload || {};

  if (event.type === 'event_msg' && payload.type === 'user_message') {
    return { ...codexUserMessage(payload), stream: EVENT_STREAM };
  }

  if (event.type === 'event_msg' && payload.type === 'agent_message') {
    return { role: 'assistant', content: contentToText(payload.message || payload), stream: EVENT_STREAM };
  }

  if (event.type === 'event_msg' && payload.type === 'task_complete' && payload.last_agent_message) {
    return { role: 'assistant', content: contentToText(payload.last_agent_message), stream: EVENT_STREAM };
  }

  if (event.type === 'response_item' && payload.type === 'message') {
    const role = payload.role || 'assistant';
    if (role === 'user') return { ...codexUserItemMessage(payload), stream: ITEM_STREAM };
    return { role, content: contentToText(payload.content), stream: ITEM_STREAM };
  }

  if (event.type === 'response_item' && payload.type === 'function_call') {
    return { role: 'tool', content: `Tool call: ${payload.name}\n${contentToText(payload.arguments)}`, stream: ITEM_STREAM };
  }

  if (event.type === 'response_item' && payload.type === 'function_call_output') {
    return { role: 'tool', content: contentToText(payload.output || payload.content || payload), stream: ITEM_STREAM };
  }

  // Codex records built-in tools such as `apply_patch` as custom tool calls:
  // the same pair of records as a function call, with `input` in place of
  // `arguments`. Without these the ledger sees the edits' outcomes but never
  // the edits themselves.
  if (event.type === 'response_item' && payload.type === 'custom_tool_call') {
    return { role: 'tool', content: `Tool call: ${payload.name}\n${contentToText(payload.input)}`, stream: ITEM_STREAM };
  }

  if (event.type === 'response_item' && payload.type === 'custom_tool_call_output') {
    return { role: 'tool', content: contentToText(payload.output || payload.content || payload), stream: ITEM_STREAM };
  }

  if (event.type === 'turn_context') {
    return { role: 'system', content: `Turn context:\n${JSON.stringify(payload, null, 2)}`, stream: META_STREAM };
  }

  if (event.type === 'parse_error') {
    return { role: 'system', content: `Parse error: ${event.error}\n${event.rawLine}`, stream: META_STREAM };
  }

  if (event.type === 'oversized_line') {
    return { role: 'system', content: oversizedLineSummary(event), stream: META_STREAM };
  }

  return null;
}

// `event_msg/user_message` shape: message text plus sibling media arrays.
function codexUserMessage(payload) {
  const media = mediaFromPayload(payload);
  const text = contentToText(payload.message || payload.text_elements || '');
  return { role: 'user', content: renderUserContent(text, media), media };
}

// `response_item/message` shape for the user role: a content-part array that
// interleaves text with image parts. Extracting media here rather than letting
// `contentToText` stringify the raw part is what makes this stream's text
// byte-identical to the event stream's, so the two copies collapse cleanly -
// and it keeps inline base64 image payloads out of the ledger either way.
function codexUserItemMessage(payload) {
  const parts = Array.isArray(payload.content) ? payload.content : [payload.content];
  const media = { localImages: [], localFiles: [], inlineImageCount: 0 };
  const texts = [];

  for (const part of parts) {
    if (isImagePart(part)) {
      const local = mediaItemPath(part);
      if (local) media.localImages.push(local);
      else media.inlineImageCount++;
      continue;
    }
    if (isFilePart(part)) {
      const local = mediaItemPath(part);
      if (local) media.localFiles.push(local);
      continue;
    }
    const text = contentToText(part);
    if (text.trim()) texts.push(text);
  }

  media.localImages = [...new Set(media.localImages)];
  media.localFiles = [...new Set(media.localFiles)];
  return { role: 'user', content: renderUserContent(texts.join('\n'), media), media };
}

// Shared so both streams format a user message identically.
function renderUserContent(text, media) {
  const parts = [];
  if (String(text || '').trim()) parts.push(String(text));
  if (media.localImages.length > 0) {
    parts.push(['Attached local images:', ...media.localImages.map((item) => `- ${item}`)].join('\n'));
  }
  if (media.localFiles.length > 0) {
    parts.push(['Attached local files:', ...media.localFiles.map((item) => `- ${item}`)].join('\n'));
  }
  if (media.inlineImageCount > 0) {
    parts.push(`Inline image payloads omitted from imported text: ${media.inlineImageCount}`);
  }
  return parts.join('\n\n');
}

function isImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.image_url || part.imageUrl) return true;
  return String(part.type || '').toLowerCase().includes('image');
}

function isFilePart(part) {
  if (!part || typeof part !== 'object') return false;
  return String(part.type || '').toLowerCase().includes('file');
}

// Drop the second copy of a message that Codex wrote to both of its streams.
//
// The rule is deliberately narrow: the two turns must have the same role, byte-
// identical content, and come from *different* native streams, within a short
// window. Requiring different streams is what keeps genuinely repeated messages
// intact - a user who types "yes" twice produces an event+item pair each time,
// and those pairs never merge into one, because each candidate has already been
// matched by its own counterpart.
export function collapseCodexStreamDuplicates(turns) {
  const result = [];
  let removed = 0;

  for (const turn of turns) {
    const stream = turn.metadata?.stream;
    let merged = false;

    if (stream === EVENT_STREAM || stream === ITEM_STREAM) {
      const start = Math.max(0, result.length - STREAM_PAIR_WINDOW);
      for (let i = result.length - 1; i >= start; i--) {
        const candidate = result[i];
        const candidateStream = candidate.metadata?.stream;
        if (candidateStream !== EVENT_STREAM && candidateStream !== ITEM_STREAM) continue;
        if (candidateStream === stream) continue;
        if (candidate.role !== turn.role || candidate.content !== turn.content) continue;
        result[i] = mergeStreamPair(candidate, turn);
        removed++;
        merged = true;
        break;
      }
    }

    if (!merged) result.push(turn);
  }

  return { turns: result, removed };
}

// Keep the earlier turn's position and identity, but carry over media metadata
// if only the dropped copy had it.
function mergeStreamPair(kept, dropped) {
  const media = kept.metadata?.media || dropped.metadata?.media;
  return {
    ...kept,
    metadata: {
      ...kept.metadata,
      ...(media ? { media } : {}),
      collapsedStreams: [kept.metadata?.stream, dropped.metadata?.stream].filter(Boolean).join('+')
    }
  };
}

function mediaFromPayload(payload) {
  const localImages = [];
  const localFiles = [];
  let inlineImageCount = 0;

  for (const item of payload.local_images || payload.localImages || []) {
    const text = mediaItemPath(item);
    if (text) localImages.push(text);
  }

  for (const item of payload.local_files || payload.localFiles || []) {
    const text = mediaItemPath(item);
    if (text) localFiles.push(text);
  }

  for (const item of payload.images || []) {
    const text = mediaItemPath(item);
    if (text) localImages.push(text);
    else inlineImageCount++;
  }

  return {
    localImages: [...new Set(localImages)],
    localFiles: [...new Set(localFiles)],
    inlineImageCount
  };
}

// Returns a usable local path, or '' for an inline payload the caller should
// count rather than embed. Object parts are checked against the same data: URI
// rule as bare strings; `response_item` image parts carry theirs on image_url.
function mediaItemPath(item) {
  if (typeof item === 'string') return isInlinePayload(item) ? '' : item;
  if (!item || typeof item !== 'object') return '';
  const value =
    item.path || item.filePath || item.localPath || item.uri || item.url || item.image_url || item.imageUrl || '';
  return isInlinePayload(value) ? '' : String(value);
}

function isInlinePayload(value) {
  return /^data:/i.test(String(value || ''));
}

function contentToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return contentToText(value.content);
    if (value.type && value.text) return String(value.text);
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export function codexSurface(source, originator) {
  if (typeof source === 'string' && source) return source;

  if (source && typeof source === 'object') {
    if (source.subagent) {
      const name =
        typeof source.subagent === 'string'
          ? source.subagent
          : source.subagent.other || source.subagent.name || Object.keys(source.subagent)[0];
      return name ? `subagent · ${name}` : 'subagent';
    }
    const key = Object.keys(source)[0];
    if (key) return key;
  }

  // The originator names the client that started the session, which is the next
  // most useful thing when the source is missing or unrecognised.
  if (typeof originator === 'string' && originator) return originator.replace(/^codex_/, '');
  return undefined;
}

async function inspectCodexFile(filePath, options) {
  // Wide enough to get past the injected preamble - skills, instructions, world
  // state - to the first message the user actually typed.
  const objects = await readFirstJsonlObjects(filePath, 80, options);
  let sessionId;
  let cwd;
  let source;
  let forkedFrom;
  const messages = [];

  for (const event of objects) {
    if (event.type === 'session_meta') {
      sessionId ||= event.payload?.id;
      cwd ||= event.payload?.cwd;
      source ||= codexSurface(event.payload?.source, event.payload?.originator);
      forkedFrom ||= event.payload?.forked_from_id;
    }
    // The event stream records the message as sent; the response stream records
    // it again alongside the model's view of it. One is enough.
    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      messages.push(contentToText(event.payload.message));
    }
  }

  return {
    sessionId,
    cwd,
    source,
    forkedFrom,
    ...describeRequests(messages)
  };
}

// The most recent request in a session, read from the tail so a 400 MB
// transcript costs the same as a small one.
function latestCodexRequest(filePath, options) {
  return readLatestRequest(
    filePath,
    (objects) =>
      objects
        .filter((event) => event.type === 'event_msg' && event.payload?.type === 'user_message')
        .map((event) => contentToText(event.payload.message)),
    options
  );
}

function sessionIdFromCodexPath(filePath) {
  const base = path.basename(filePath, '.jsonl');
  return base.replace(/^rollout-/, '');
}
