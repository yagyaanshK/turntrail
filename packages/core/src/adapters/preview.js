// Naming a session you want to continue.
//
// Neither agent stores a chat name in its transcript. Claude Code writes an
// `aiTitle` on most sessions and that is used when present; Codex writes none
// at all, so the opening request has to stand in for one.
//
// Taking that request verbatim is what made the picker useless: the editor
// extensions do not record what you typed, they record what they sent, and that
// is your message wrapped in a block of context about open tabs and the active
// file. Several unrelated sessions therefore opened with the same paragraph.
// Worse, forked sessions share their opening message exactly, so the first
// request alone cannot tell two of them apart.

// What the IDE extensions put in front of the actual request.
const REQUEST_MARKERS = [/##\s*My request for Codex:\s*/i, /##\s*My request:\s*/i];

// Blocks the harness injects around or beside a message. None of it is what the
// user asked for.
const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<ide_selection>[\s\S]*?<\/ide_selection>/gi,
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<user_instructions>[\s\S]*?<\/user_instructions>/gi,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi
];

// A message that is entirely machinery: the agent was told this, the user did
// not ask it.
const INJECTED_MESSAGE = [
  /^<[a-z_][a-z0-9_-]*>/i,
  /^Turn context:/i,
  /^#\s*AGENTS\.md instructions/i,
  /^Caveat: The messages below/i,
  // The Codex editor extension probes for tools on connect.
  /^Check whether the tool [\w.]+ is available/i,
  // A subagent is handed its parent's transcript as its opening message. It is
  // the same paragraph in every such session, so it names none of them.
  /^The following is the Codex agent history/i,
  /^#\s*Context from my IDE setup:\s*$/i
];

export function unwrapRequest(text) {
  let value = String(text ?? '');

  // The request itself follows the marker; everything before it is the context
  // block the extension prepended.
  for (const marker of REQUEST_MARKERS) {
    const match = marker.exec(value);
    if (match) value = value.slice(match.index + match[0].length);
  }

  for (const block of INJECTED_BLOCKS) value = value.replace(block, ' ');

  // A slash command is recorded as a caveat plus the command name. The name is
  // the only part worth showing, and it identifies the session well.
  const command = /<command-name>\s*([^<]+?)\s*<\/command-name>/i.exec(value);
  if (command) return command[1].trim();

  return value.trim();
}

export function isInjectedMessage(text) {
  const value = String(text ?? '').trim();
  if (!value) return true;
  return INJECTED_MESSAGE.some((pattern) => pattern.test(value));
}

export function previewOf(text, maxChars = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

// A reply that carries no topic. "yes", "continue", "proceed as suggested" tell
// you nothing about which session you are looking at, and they are what most
// conversations end on.
const FILLER = /^(?:y(?:es|ep|eah)?|no|ok(?:ay)?|sure|thanks?|ty|go(?: ahead)?|continue|proceed|next|do it|cont|yy|k)\b[\s.!]*$/i;

function isSubstantive(text) {
  const value = String(text || '').trim();
  return value.length >= 25 && !FILLER.test(value);
}

// The opening request names the session; the most recent substantive one says
// where it actually got to.
//
// Both are needed, and the second matters more than it looks. Sessions forked
// from a common parent share their opening message *exactly* - on this machine
// seven of eight sessions in one folder opened with the same paragraph - so the
// first request cannot tell them apart and neither can a timestamp. What
// diverges is what was asked later.
export function describeRequests(messages, options = {}) {
  const maxChars = options.maxChars || 120;
  const unwrapped = (messages || []).map(unwrapRequest).filter(Boolean);
  const authored = unwrapped.filter((text) => !isInjectedMessage(text));
  // If a session is nothing but machinery, showing the machinery beats showing
  // an empty row.
  const pool = authored.length > 0 ? authored : unwrapped;
  if (pool.length === 0) return {};

  const first = previewOf(pool[0], maxChars);

  // Walk back to the last request that actually says something.
  let last;
  for (let index = pool.length - 1; index >= 0; index--) {
    if (isSubstantive(pool[index])) {
      last = previewOf(pool[index], maxChars);
      break;
    }
  }
  last ||= previewOf(pool[pool.length - 1], maxChars);

  return { first, last: last && last !== first ? last : undefined };
}

export function isSubstantivePreview(text) {
  return isSubstantive(text);
}

// The most recent meaningful request in a transcript.
//
// Read from the end, because these files reach hundreds of megabytes. The
// window is widened once if the first pass found nothing worth showing: a
// single embedded image or a huge tool output can fill the whole tail, leaving
// one short reply - or nothing - to go on. The retry only happens in that case,
// so the common path stays one small read.
export async function readLatestRequest(filePath, extractMessages, options = {}) {
  const { readLastJsonlObjects } = await import('./common.js');
  let fallback;

  for (const maxBytes of options.windows || [512 * 1024, 4 * 1024 * 1024]) {
    options.signal?.throwIfAborted();
    const objects = await readLastJsonlObjects(filePath, 400, maxBytes, options);
    const described = describeRequests(extractMessages(objects), options);
    const candidate = described.last || described.first;
    if (candidate && isSubstantive(candidate)) return candidate;
    fallback ||= candidate;
  }
  return fallback;
}
