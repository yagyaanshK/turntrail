import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { ensureDir, pathExists, writeFileAtomic } from './fs-utils.js';
import { accountsRoot, listAccounts } from './accounts/store.js';
import { claudeHome, defaultClaudeHome } from './accounts/claude.js';
import { codexHome, defaultCodexHome } from './accounts/codex.js';

// Token use, read from the transcripts the agents already write.
//
// Nothing here reaches the network. Claude Code records the provider's usage
// figures on every model reply; Codex records them on every turn. Turntrail
// reads those figures from every transcript folder on the machine, the default
// homes and each managed account's, and keeps a small index of hourly totals
// so a later pass reads only what was appended since.
//
// The figures are counted in four parts, because they cost and count against
// limits very differently:
//   fresh       input the model had not seen before
//   cacheWrite  input written into the prompt cache (Claude)
//   cacheRead   input served from the prompt cache; each turn re-reads the
//               conversation, so this is most of the raw total
//   output      generated tokens, reasoning included
// "Work" is fresh + cacheWrite + output: what a turn added.

const INDEX_VERSION = 1;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const CLAUDE_RECENT_IDS = 64;
export const USAGE_AGENTS = ['claude', 'codex'];

export function usageIndexPath(options = {}) {
  return options.usageIndexPath || path.join(accountsRoot(options), 'usage', 'usage-index.json');
}

// Every folder that can hold transcripts with usage, labelled with the account
// that writes there. The default homes belong to whichever account is active,
// which history does not record, so they are labelled as the default.
export async function usageLocations(options = {}) {
  const accounts = await listAccounts(options).catch(() => []);
  const locations = [
    { agent: 'claude', dir: path.join(defaultClaudeHome(options), 'projects'), account: 'default' },
    { agent: 'codex', dir: path.join(defaultCodexHome(options), 'sessions'), account: 'default' },
    { agent: 'codex', dir: path.join(defaultCodexHome(options), 'archived_sessions'), account: 'default' }
  ];
  for (const account of accounts) {
    if (account.provider === 'claude') {
      locations.push({ agent: 'claude', dir: path.join(claudeHome(account.id, options), 'projects'), account: account.id, label: account.label });
    } else if (account.provider === 'codex') {
      const home = codexHome(account.id, options);
      locations.push({ agent: 'codex', dir: path.join(home, 'sessions'), account: account.id, label: account.label });
      locations.push({ agent: 'codex', dir: path.join(home, 'archived_sessions'), account: account.id, label: account.label });
    }
  }
  return locations;
}

function emptyIndex() {
  return { version: INDEX_VERSION, tzOffsetMinutes: new Date().getTimezoneOffset(), files: {}, labels: {} };
}

export async function readUsageIndex(options = {}) {
  const file = usageIndexPath(options);
  if (!(await pathExists(file))) return emptyIndex();
  try {
    const index = JSON.parse(await fs.readFile(file, 'utf8'));
    // Hours are bucketed in local time, so a different timezone means every
    // bucket boundary is in the wrong place: start over.
    if (index?.version !== INDEX_VERSION || index.tzOffsetMinutes !== new Date().getTimezoneOffset()) return emptyIndex();
    index.files ||= {};
    index.labels ||= {};
    return index;
  } catch {
    return emptyIndex();
  }
}

// Bring the index up to date: new files are read whole, grown files from where
// the last pass stopped, rewritten or shrunk files from the start, and files
// that disappeared are dropped. Returns the index; also writes it unless
// `persist: false`.
export async function scanUsage(options = {}) {
  const index = options.index || (await readUsageIndex(options));
  const locations = options.locations || (await usageLocations(options));
  const seen = new Set();
  const stats = { files: 0, read: 0, bytes: 0 };

  for (const location of locations) {
    if (location.label) index.labels[location.account] = location.label;
    for (const file of await listJsonl(location.dir, options)) {
      options.signal?.throwIfAborted();
      seen.add(file.path);
      stats.files++;
      let entry = index.files[file.path];
      if (entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs) continue;
      if (!entry || file.size < entry.offset || entry.agent !== location.agent) {
        entry = { agent: location.agent, account: location.account, offset: 0, state: {}, buckets: {} };
      }
      entry.account = location.account;
      const consumed = await readFrom(file.path, entry.offset, (line) => parseLine(entry, line));
      stats.read++;
      stats.bytes += consumed;
      entry.offset += consumed;
      entry.size = file.size;
      entry.mtimeMs = file.mtimeMs;
      index.files[file.path] = entry;
    }
  }
  for (const known of Object.keys(index.files)) if (!seen.has(known)) delete index.files[known];

  index.scannedAt = new Date((options.now || Date.now)()).toISOString();
  if (options.persist !== false) {
    const target = usageIndexPath(options);
    await ensureDir(path.dirname(target));
    await writeFileAtomic(target, JSON.stringify(index));
  }
  Object.defineProperty(index, 'lastScan', { value: stats, enumerable: false, configurable: true, writable: true });
  return index;
}

async function listJsonl(dir, options, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listJsonl(full, options, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = await fs.stat(full);
        out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Gone between listing and stat.
      }
    }
  }
  return out;
}

// Reads complete lines from `start` and returns how many bytes they covered,
// so a line still being written is left for the next pass. Lines over 8 MiB
// (Codex compaction records) are passed over without being held in memory;
// none of them carry usage.
async function readFrom(file, start, onLine) {
  let consumed = 0;
  let parts = [];
  let partBytes = 0;
  let skipping = false;
  const stream = createReadStream(file, { start });
  for await (const chunk of stream) {
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(0x0a, from);
      if (newline < 0) break;
      const piece = chunk.subarray(from, newline);
      const lineBytes = partBytes + piece.length + 1;
      if (!skipping) {
        const buffer = parts.length > 0 ? Buffer.concat([...parts, piece]) : piece;
        onLine(buffer.toString('utf8'));
      }
      consumed += lineBytes;
      parts = [];
      partBytes = 0;
      skipping = false;
      from = newline + 1;
    }
    if (from < chunk.length) {
      const rest = chunk.subarray(from);
      partBytes += rest.length;
      if (!skipping) {
        parts.push(Buffer.from(rest));
        if (partBytes > MAX_LINE_BYTES) {
          skipping = true;
          parts = [];
        }
      }
    }
  }
  return consumed;
}

function localHourKey(iso) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return undefined;
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}`;
}

function addUsage(entry, at, model, usage, sign = 1) {
  const hour = localHourKey(at);
  if (!hour) return undefined;
  const key = `${hour}|${model || 'unknown'}`;
  const bucket = (entry.buckets[key] ||= [0, 0, 0, 0, 0]);
  bucket[0] += sign * usage.fresh;
  bucket[1] += sign * usage.cacheWrite;
  bucket[2] += sign * usage.cacheRead;
  bucket[3] += sign * usage.output;
  bucket[4] += sign;
  return key;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function parseLine(entry, line) {
  if (entry.agent === 'claude') parseClaudeLine(entry, line);
  else parseCodexLine(entry, line);
}

// One Claude reply is written as several lines, one per content block, each
// with the same usage; the request id says which lines are the same reply.
function parseClaudeLine(entry, line) {
  if (!entry.cwd && line.includes('"cwd"')) {
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
    if (cwd) entry.cwd = JSON.parse(`"${cwd[1]}"`);
  }
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const message = event.message;
  if (event.type !== 'assistant' || !message?.usage || !event.timestamp || message.model === '<synthetic>') return;
  const id = event.requestId || message.id || event.uuid;
  const recent = (entry.state.recent ||= []);
  if (id && recent.includes(id)) return;
  if (id) {
    recent.push(id);
    if (recent.length > CLAUDE_RECENT_IDS) recent.shift();
  }
  const usage = message.usage;
  addUsage(entry, event.timestamp, message.model, {
    fresh: num(usage.input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    output: num(usage.output_tokens)
  });
}

// Codex: per-response records where the client writes them, otherwise the
// per-turn figure on token_count events. The running total is not used: a
// forked or resumed thread starts with its parent's total already in it, and
// summing totals counted that work twice (measured: five times too much on
// one machine). Repeated token_count events with an unchanged total are the
// same turn reported again.
function parseCodexLine(entry, line) {
  const head = line.slice(0, 300);
  if (head.includes('"type":"session_meta"')) {
    try {
      entry.cwd ||= JSON.parse(line).payload?.cwd;
    } catch {
      // A malformed first line leaves the project unknown.
    }
    return;
  }
  if (head.includes('"type":"turn_context"')) {
    const model = /"model":"([^"]+)"/.exec(line);
    if (model) entry.state.model = model[1];
    return;
  }
  const record = head.includes('"type":"token_usage_record"');
  const count = !record && head.includes('"type":"token_count"');
  if (!record && !count) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event.timestamp) return;
  let usage;
  if (record) {
    usage = event.payload?.usage;
    // A client that starts writing records mid-thread writes the turn figure
    // of the same turn just before its first record; that turn was counted
    // from the figure, so it is taken back out rather than counted twice.
    const previous = entry.state.lastTurn;
    if (!entry.state.records && previous && usage && sameCodexUsage(previous.usage, usage)) {
      addUsage(entry, previous.at, previous.model, codexParts(previous.usage), -1);
    }
    entry.state.records = true;
    entry.state.lastTurn = undefined;
  } else {
    if (entry.state.records) return;
    const info = event.payload?.info;
    const total = info?.total_token_usage;
    if (!total) return;
    const last = entry.state.lastTotal;
    entry.state.lastTotal = [total.input_tokens, total.output_tokens];
    if (last && last[0] === total.input_tokens && last[1] === total.output_tokens) return;
    usage = info.last_token_usage;
  }
  if (!usage) return;
  addUsage(entry, event.timestamp, entry.state.model, codexParts(usage));
  if (!record) {
    entry.state.lastTurn = {
      at: event.timestamp,
      model: entry.state.model,
      usage: { input_tokens: usage.input_tokens, cached_input_tokens: usage.cached_input_tokens, cache_write_input_tokens: usage.cache_write_input_tokens, output_tokens: usage.output_tokens }
    };
  }
}

function codexParts(usage) {
  const input = num(usage.input_tokens);
  const cached = Math.min(input, num(usage.cached_input_tokens));
  return { fresh: input - cached, cacheWrite: num(usage.cache_write_input_tokens), cacheRead: cached, output: num(usage.output_tokens) };
}

function sameCodexUsage(a, b) {
  return ['input_tokens', 'cached_input_tokens', 'output_tokens'].every((key) => num(a?.[key]) === num(b?.[key]));
}

// ---------------------------------------------------------------------------
// Summaries

const zero = () => ({ fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0, work: 0 });
function accumulate(target, bucket) {
  target.fresh += bucket[0];
  target.cacheWrite += bucket[1];
  target.cacheRead += bucket[2];
  target.output += bucket[3];
  target.calls += bucket[4];
  target.work += bucket[0] + bucket[1] + bucket[3];
}

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function projectName(cwd) {
  if (!cwd) return '(unknown folder)';
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(cwd);
}

// Totals per agent for today, the last hour, 24 hours, 7 and 30 days; a daily
// series for the last `days` days; and the biggest models, projects and
// accounts over that range. Hours are local.
export function summarizeUsage(index, options = {}) {
  const now = new Date((options.now || Date.now)());
  const top = options.top || 8;
  const pad = (n) => String(n).padStart(2, '0');
  const hourOf = (date) => `${dayKey(date)}T${pad(date.getHours())}`;
  // Calendar days back from today. Subtracting 24-hour periods instead skips
  // or repeats a day across a daylight-saving change.
  const daysBack = (n) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
  const lastHour = hourOf(now);
  const since24 = hourOf(new Date(now.getTime() - 23 * 3600000));
  const today = dayKey(now);
  const since7 = daysBack(6);
  const since30 = daysBack(29);
  // "max" covers everything recorded, from the first day with any usage.
  const max = options.days === 'max' || options.days === Infinity;
  let days;
  if (max) {
    let first;
    for (const entry of Object.values(index.files || {})) {
      for (const key of Object.keys(entry.buckets || {})) {
        const day = key.slice(0, 10);
        if (!first || day < first) first = day;
      }
    }
    days = first ? Math.min(MAX_SUMMARY_DAYS, calendarDaysBetween(first, today) + 1) : 1;
  } else {
    days = Math.max(1, Math.min(MAX_SUMMARY_DAYS, Math.floor(Number(options.days) || 30)));
  }
  const rangeStart = daysBack(days - 1);

  const series = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const day = daysBack(i);
    series.set(day, { day, claude: zero(), codex: zero() });
  }
  // Per model and day, for the chart split by model.
  const modelDaily = new Map();
  const modelAllTime = new Map();
  const windows = {};
  const totals = {};
  const earliest = {};
  for (const agent of USAGE_AGENTS) {
    windows[agent] = { lastHour: zero(), last24h: zero(), today: zero(), last7: zero(), last30: zero() };
    totals[agent] = zero();
  }
  const byModel = new Map();
  const byProject = new Map();
  const byAccount = new Map();
  const group = (map, key, agent, label) => {
    if (!map.has(key)) map.set(key, { key, agent, label: label || key, ...zero() });
    return map.get(key);
  };

  for (const entry of Object.values(index.files || {})) {
    const agent = entry.agent;
    if (!USAGE_AGENTS.includes(agent)) continue;
    for (const [key, bucket] of Object.entries(entry.buckets || {})) {
      const [hour, model] = key.split('|');
      const day = hour.slice(0, 10);
      accumulate(totals[agent], bucket);
      const modelKey = `${agent}|${model}`;
      modelAllTime.set(modelKey, (modelAllTime.get(modelKey) || 0) + bucket[0] + bucket[1] + bucket[3]);
      if (!earliest[agent] || hour < earliest[agent]) earliest[agent] = hour;
      if (hour === lastHour) accumulate(windows[agent].lastHour, bucket);
      if (hour >= since24) accumulate(windows[agent].last24h, bucket);
      if (day === today) accumulate(windows[agent].today, bucket);
      if (day >= since7) accumulate(windows[agent].last7, bucket);
      if (day >= since30) accumulate(windows[agent].last30, bucket);
      if (day < rangeStart) continue;
      const point = series.get(day);
      if (point) accumulate(point[agent], bucket);
      if (!modelDaily.has(day)) modelDaily.set(day, new Map());
      const perModel = modelDaily.get(day);
      const cell = perModel.get(modelKey) || [0, 0];
      cell[0] += bucket[0] + bucket[1] + bucket[3];
      cell[1] += bucket[2];
      perModel.set(modelKey, cell);
      accumulate(group(byModel, modelKey, agent, model), bucket);
      accumulate(group(byProject, `${agent}|${entry.cwd || ''}`, agent, projectName(entry.cwd)), bucket);
      const accountLabel = entry.account === 'default' ? 'Default sign-in' : index.labels?.[entry.account] || entry.account;
      accumulate(group(byAccount, `${agent}|${entry.account}`, agent, accountLabel), bucket);
    }
  }

  const ranked = (map, limit = top) => [...map.values()]
    .filter((row) => row.work > 0 || row.cacheRead > 0)
    .sort((a, b) => b.work - a.work || b.cacheRead - a.cacheRead)
    .slice(0, limit);
  const models = ranked(byModel, options.modelTop || 50);
  return {
    generatedAt: now.toISOString(),
    scannedAt: index.scannedAt,
    days,
    range: { from: rangeStart, to: today, max },
    totals,
    earliest: Object.fromEntries(Object.entries(earliest).map(([agent, hour]) => [agent, hour.slice(0, 10)])),
    windows,
    // Per-hour work over the last 24 hours, the burn rate.
    burnPerHour: Object.fromEntries(USAGE_AGENTS.map((agent) => [agent, Math.round(windows[agent].last24h.work / 24)])),
    daily: [...series.values()],
    byModel: models,
    modelSeries: modelSeries(models, modelAllTime, modelDaily, [...series.keys()]),
    byProject: ranked(byProject),
    byAccount: ranked(byAccount),
    files: Object.keys(index.files || {}).length
  };
}

// The daily series split by model: the biggest models in the range each get a
// series and the rest fold into "Other", so the chart never needs more colours
// than it can tell apart. Each model carries its all-time rank, which the view
// uses to give it the same colour whatever range is shown.
// Four: the most colours the reference palette can keep apart in every pairing,
// light and dark, once the two agent colours are set aside.
const MODEL_SERIES = 4;
const MAX_SUMMARY_DAYS = 3660;

function modelSeries(rankedModels, allTime, modelDaily, days) {
  const allTimeOrder = [...allTime.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const shown = rankedModels.slice(0, MODEL_SERIES);
  const shownKeys = new Set(shown.map((row) => row.key));
  const models = shown.map((row) => ({ key: row.key, label: row.label, agent: row.agent, rank: allTimeOrder.indexOf(row.key) }));
  const hasOther = rankedModels.length > MODEL_SERIES;
  if (hasOther) models.push({ key: 'other', label: `Other models (${rankedModels.length - MODEL_SERIES})`, rank: -1 });
  const daily = days.map((day) => {
    const work = {};
    const cacheRead = {};
    for (const model of models) {
      work[model.key] = 0;
      cacheRead[model.key] = 0;
    }
    for (const [key, cell] of modelDaily.get(day) || []) {
      const target = shownKeys.has(key) ? key : hasOther ? 'other' : undefined;
      if (!target) continue;
      work[target] += cell[0];
      cacheRead[target] += cell[1];
    }
    return { day, work, cacheRead };
  });
  return { models, daily };
}

function calendarDaysBetween(from, to) {
  const parse = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86400000);
}

// ---------------------------------------------------------------------------
// Cost, only where the user has said what a model costs.
//
// Turntrail ships no prices: they change, they differ by plan, and a
// subscription is not billed per token at all. `prices` maps a model name,
// or a prefix ending in `*`, to US dollars per million tokens.
export function estimateUsageCost(rows, prices = {}) {
  const entries = Object.entries(prices || {}).filter(([, price]) => price && typeof price === 'object');
  const priceFor = (model) => {
    const exact = entries.find(([pattern]) => pattern === model);
    if (exact) return exact[1];
    const prefixes = entries
      .filter(([pattern]) => pattern.endsWith('*') && String(model).startsWith(pattern.slice(0, -1)))
      .sort((a, b) => b[0].length - a[0].length);
    return prefixes[0]?.[1];
  };
  let total = 0;
  let priced = 0;
  const unpriced = [];
  for (const row of rows || []) {
    const price = priceFor(row.label);
    if (!price) {
      unpriced.push(row.label);
      continue;
    }
    const cost =
      (row.fresh * num(price.input) +
        row.cacheWrite * num(price.cacheWrite ?? price.input) +
        row.cacheRead * num(price.cacheRead) +
        row.output * num(price.output)) /
      1e6;
    total += cost;
    priced++;
  }
  return { total, priced, unpriced };
}

// ---------------------------------------------------------------------------
// Limit projections from quota readings.
//
// A window's used percentage divided by the share of the window already gone
// is its average rate so far; at that rate the remainder runs out at a
// predictable time, which matters only if that is before the window resets.
export function projectLimitWindow(window, nowMs = Date.now()) {
  const used = Number(window?.usedPercent);
  const seconds = Number(window?.windowSeconds);
  const resetsAt = Date.parse(window?.resetsAt || '');
  if (!Number.isFinite(used) || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(resetsAt)) return undefined;
  if (resetsAt <= nowMs) return { label: window.label, stale: true };
  const startedAt = resetsAt - seconds * 1000;
  const elapsed = nowMs - startedAt;
  const base = { label: window.label, usedPercent: used, resetsAt: new Date(resetsAt).toISOString() };
  if (used >= 100) return { ...base, runsOutAt: new Date(nowMs).toISOString(), beforeReset: true, exhausted: true };
  if (elapsed <= 0 || used <= 0) return { ...base, projectedAtReset: used, beforeReset: false };
  const perMs = used / elapsed;
  const runsOutAt = nowMs + (100 - used) / perMs;
  return {
    ...base,
    projectedAtReset: Math.round(used + perMs * (resetsAt - nowMs)),
    runsOutAt: new Date(runsOutAt).toISOString(),
    beforeReset: runsOutAt < resetsAt
  };
}

export const DEFAULT_USAGE_DAYS = 30;
