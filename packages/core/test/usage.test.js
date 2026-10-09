import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { estimateUsageCost, projectLimitWindow, readUsageIndex, scanUsage, summarizeUsage, usageInsights } from '../src/index.js';

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;

// Local noon on a fixed day, so hour buckets and "today" are predictable in
// any timezone the tests run in.
const NOON = new Date(2026, 9, 9, 12, 0, 0);
const at = (hoursBefore, minutes = 0) => new Date(NOON.getTime() - hoursBefore * 3600000 + minutes * 60000).toISOString();

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-usage-'));
  const claude = path.join(home, '.claude', 'projects', 'd--work');
  const codex = path.join(home, '.codex', 'sessions', '2026', '10', '09');
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(codex, { recursive: true });
  const options = { home, accountsRoot: path.join(home, '.turntrail'), usageIndexPath: path.join(home, 'usage-index.json'), now: () => NOON.getTime() };
  return { home, claude, codex, options };
}

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

function claudeReply(id, when, usage, model = 'claude-opus-5-5') {
  return { type: 'assistant', requestId: id, timestamp: when, cwd: 'D:\\work', message: { id: `msg-${id}`, role: 'assistant', model, usage } };
}

test('a Claude reply written as several lines is counted once', async () => {
  const { claude, options } = await sandbox();
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000, output_tokens: 300 };
  await fs.writeFile(path.join(claude, 'a.jsonl'), jsonl([
    { type: 'user', timestamp: at(1), cwd: 'D:\\work', message: { role: 'user', content: 'go' } },
    claudeReply('r1', at(1, 1), usage),
    claudeReply('r1', at(1, 1), usage),
    claudeReply('r1', at(1, 1), usage),
    claudeReply('r2', at(0), { input_tokens: 5, cache_read_input_tokens: 51000, output_tokens: 100 }),
    { ...claudeReply('r3', at(0), { output_tokens: 999 }), message: { model: '<synthetic>', usage: { output_tokens: 999 } } }
  ]));

  const summary = summarizeUsage(await scanUsage(options), { now: options.now, days: 7 });
  const total = summary.totals.claude;
  assert.equal(total.calls, 2);
  assert.equal(total.fresh, 15);
  assert.equal(total.cacheWrite, 1000);
  assert.equal(total.cacheRead, 101000);
  assert.equal(total.output, 400);
  assert.equal(total.work, 15 + 1000 + 400);
  assert.equal(summary.byProject[0].label, 'work');
  assert.equal(summary.byModel[0].label, 'claude-opus-5-5');
});

function codexMeta(cwd = 'D:\\work') {
  return { timestamp: at(3), type: 'session_meta', payload: { id: 't', cwd } };
}
function tokenCount(when, total, last) {
  return { timestamp: when, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } };
}
const u = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });

test('a forked Codex thread does not count the total it inherited from its parent', async () => {
  const { codex, options } = await sandbox();
  // The fork starts with its parent's 40 million already in the running total.
  await fs.writeFile(path.join(codex, 'rollout-fork.jsonl'), jsonl([
    codexMeta(),
    { timestamp: at(2), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: 'D:\\work' } },
    tokenCount(at(2), u(40_001_000, 30_000_000, 2_000), u(1_000, 400, 50)),
    tokenCount(at(2), u(40_001_000, 30_000_000, 2_000), u(1_000, 400, 50)),
    tokenCount(at(1), u(40_003_000, 30_001_000, 2_100), u(2_000, 600, 100))
  ]));
  const total = summarizeUsage(await scanUsage(options), { now: options.now }).totals.codex;
  assert.equal(total.calls, 2, 'the repeated event is the same turn');
  assert.equal(total.fresh, (1_000 - 400) + (2_000 - 600));
  assert.equal(total.cacheRead, 400 + 600);
  assert.equal(total.output, 150);
});

test('Codex per-response records take over from turn figures without losing the turns before them', async () => {
  const { codex, options } = await sandbox();
  await fs.writeFile(path.join(codex, 'rollout-upgraded.jsonl'), jsonl([
    codexMeta(),
    { timestamp: at(3), type: 'turn_context', payload: { model: 'gpt-5.5' } },
    // Before the client wrote records: counted from the turn figure.
    tokenCount(at(3), u(1_000, 0, 10), u(1_000, 0, 10)),
    { timestamp: at(2), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    // Once records appear they are the count, and turn figures are ignored.
    tokenCount(at(2), u(3_000, 500, 30), u(2_000, 500, 20)),
    { timestamp: at(2), type: 'token_usage_record', payload: { response_id: 'resp-1', usage: u(2_000, 500, 20) } },
    tokenCount(at(1), u(6_000, 900, 60), u(3_000, 400, 30)),
    { timestamp: at(1), type: 'token_usage_record', payload: { response_id: 'resp-2', usage: u(3_000, 400, 30) } }
  ]));
  const summary = summarizeUsage(await scanUsage(options), { now: options.now });
  const total = summary.totals.codex;
  // The turn before records, then the two records. The turn figure written
  // just ahead of the first record is the same turn and is not counted again.
  assert.equal(total.output, 10 + 20 + 30);
  assert.equal(total.calls, 3);
  const models = Object.fromEntries(summary.byModel.map((row) => [row.label, row.output]));
  assert.equal(models['gpt-5.5'], 10);
});

test('a later pass reads only what was appended, and leaves a half-written line for next time', async () => {
  const { claude, options } = await sandbox();
  const file = path.join(claude, 'live.jsonl');
  await fs.writeFile(file, jsonl([claudeReply('a', at(2), { input_tokens: 1, output_tokens: 10 })]));
  let index = await scanUsage(options);
  const first = Object.values(index.files)[0].offset;
  assert.equal(index.lastScan.read, 1);

  // Nothing changed: nothing is read.
  index = await scanUsage({ ...options, index });
  assert.equal(index.lastScan.read, 0);

  // A complete reply and half of the next one.
  const next = JSON.stringify(claudeReply('b', at(1), { input_tokens: 2, output_tokens: 20 }));
  const partial = JSON.stringify(claudeReply('c', at(0), { input_tokens: 3, output_tokens: 30 }));
  await fs.appendFile(file, `${next}\n${partial.slice(0, 40)}`);
  index = await scanUsage({ ...options, index });
  assert.equal(index.lastScan.bytes, Buffer.byteLength(next) + 1, 'only the complete appended line was read');
  assert.equal(Object.values(index.files)[0].offset, first + Buffer.byteLength(next) + 1);
  assert.equal(summarizeUsage(index, { now: options.now }).totals.claude.output, 30);

  await fs.appendFile(file, `${partial.slice(40)}\n`);
  index = await scanUsage({ ...options, index });
  assert.equal(summarizeUsage(index, { now: options.now }).totals.claude.output, 60);

  // The saved index is the same as the one in memory.
  const saved = await readUsageIndex(options);
  assert.equal(summarizeUsage(saved, { now: options.now }).totals.claude.output, 60);
});

test('a rewritten file is read again from the start, and a deleted one is forgotten', async () => {
  const { claude, options } = await sandbox();
  const file = path.join(claude, 'x.jsonl');
  await fs.writeFile(file, jsonl([claudeReply('a', at(1), { output_tokens: 500 }), claudeReply('b', at(1), { output_tokens: 500 })]));
  let index = await scanUsage(options);
  await fs.writeFile(file, jsonl([claudeReply('z', at(1), { output_tokens: 7 })]));
  index = await scanUsage({ ...options, index });
  assert.equal(summarizeUsage(index, { now: options.now }).totals.claude.output, 7);
  await fs.rm(file);
  index = await scanUsage({ ...options, index });
  assert.equal(Object.keys(index.files).length, 0);
});

test('a record too long to hold is passed over without breaking the lines after it', async () => {
  const { codex, options } = await sandbox();
  const huge = JSON.stringify({ timestamp: at(2), type: 'compacted', payload: { replacement_history: 'x'.repeat(9 * 1024 * 1024) } });
  await fs.writeFile(path.join(codex, 'rollout-big.jsonl'), [
    JSON.stringify(codexMeta()),
    huge,
    JSON.stringify(tokenCount(at(1), u(100, 0, 5), u(100, 0, 5)))
  ].join('\n') + '\n');
  const total = summarizeUsage(await scanUsage(options), { now: options.now }).totals.codex;
  assert.equal(total.output, 5);
});

test('summaries split usage into the windows a burn rate needs', async () => {
  const { claude, options } = await sandbox();
  await fs.writeFile(path.join(claude, 'w.jsonl'), jsonl([
    claudeReply('now', at(0, 10), { input_tokens: 100, output_tokens: 0 }),
    claudeReply('2h', at(2), { input_tokens: 200, output_tokens: 0 }),
    claudeReply('3d', at(72), { input_tokens: 400, output_tokens: 0 }),
    claudeReply('20d', at(480), { input_tokens: 800, output_tokens: 0 }),
    claudeReply('60d', at(1440), { input_tokens: 1600, output_tokens: 0 })
  ]));
  const summary = summarizeUsage(await scanUsage(options), { now: options.now, days: 30 });
  const w = summary.windows.claude;
  assert.equal(w.lastHour.work, 100);
  assert.equal(w.last24h.work, 300);
  assert.equal(w.today.work, 300);
  assert.equal(w.last7.work, 700);
  assert.equal(w.last30.work, 1500);
  assert.equal(summary.totals.claude.work, 3100);
  assert.equal(summary.burnPerHour.claude, Math.round(300 / 24));
  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily.at(-1).claude.work, 300);
  assert.equal(summary.daily.reduce((sum, point) => sum + point.claude.work, 0), 1500);
});

test('cost is estimated only for models the user priced', () => {
  const rows = [
    { label: 'claude-opus-5-5', fresh: 1e6, cacheWrite: 1e6, cacheRead: 10e6, output: 1e6 },
    { label: 'gpt-6.1-sol', fresh: 1e6, cacheWrite: 0, cacheRead: 0, output: 1e6 }
  ];
  const prices = { 'claude-opus-5*': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } };
  const cost = estimateUsageCost(rows, prices);
  assert.equal(cost.total, 5 + 6.25 + 5 + 25);
  assert.equal(cost.priced, 1);
  assert.deepEqual(cost.unpriced, ['gpt-6.1-sol']);
  // An exact name beats a prefix.
  assert.equal(estimateUsageCost([rows[0]], { ...prices, 'claude-opus-5-5': { input: 1, cacheRead: 0, output: 0 } }).total, 1 + 1);
  assert.deepEqual(estimateUsageCost(rows, {}), { total: 0, priced: 0, unpriced: ['claude-opus-5-5', 'gpt-6.1-sol'] });
});

test('a limit is projected from the pace of the window so far', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const week = 7 * 24 * 3600;
  const resetIn = (hours) => new Date(now + hours * 3600000).toISOString();
  // Two days into a week, 50% used: 25% a day, gone in two more days, five before reset.
  const fast = projectLimitWindow({ label: 'weekly', usedPercent: 50, windowSeconds: week, resetsAt: resetIn(120) }, now);
  assert.equal(fast.beforeReset, true);
  assert.equal(fast.runsOutAt, new Date(now + 48 * 3600000).toISOString());
  assert.equal(fast.projectedAtReset, 175);

  // Six days in, 30% used: on pace to last.
  const slow = projectLimitWindow({ label: 'weekly', usedPercent: 30, windowSeconds: week, resetsAt: resetIn(24) }, now);
  assert.equal(slow.beforeReset, false);
  assert.equal(slow.projectedAtReset, 35);

  assert.equal(projectLimitWindow({ usedPercent: 10, windowSeconds: week, resetsAt: resetIn(-1) }, now).stale, true);
  assert.equal(projectLimitWindow({ usedPercent: 100, windowSeconds: week, resetsAt: resetIn(5) }, now).exhausted, true);
  assert.equal(projectLimitWindow({ usedPercent: 10 }, now), undefined);
});

test('the max range runs from the first day with usage, and models fold into Other past four', async () => {
  const { claude, options } = await sandbox();
  const models = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'm-g'];
  const lines = [];
  // Seven models over 400 days: m-a used most, m-g least; one old reply 400 days back.
  models.forEach((model, i) => {
    lines.push(claudeReply(`r-${model}`, at(24 * (i + 1)), { input_tokens: (models.length - i) * 1000, output_tokens: 0 }, model));
  });
  lines.push(claudeReply('ancient', at(24 * 400), { input_tokens: 5, output_tokens: 0 }, 'm-a'));
  await fs.writeFile(path.join(claude, 'models.jsonl'), jsonl(lines));
  const index = await scanUsage(options);

  const max = summarizeUsage(index, { now: options.now, days: 'max' });
  assert.equal(max.range.max, true);
  assert.equal(max.days, 401);
  assert.equal(max.daily.length, 401);
  assert.equal(max.daily[0].claude.work, 5, 'the first day is the oldest reply');
  assert.equal(max.byModel.length, 7, 'every model is listed, not just the top few');

  const series = max.modelSeries;
  assert.deepEqual(series.models.map((m) => m.label), ['m-a', 'm-b', 'm-c', 'm-d', 'Other models (3)']);
  assert.deepEqual(series.models.map((m) => m.rank), [0, 1, 2, 3, -1]);
  const sum = (daily) => daily.reduce((total, day) => total + Object.values(day.work).reduce((a, b) => a + b, 0), 0);
  assert.equal(sum(series.daily), max.totals.claude.work, 'the model series adds up to the agent total');
  const other = series.daily.reduce((total, day) => total + day.work.other, 0);
  assert.equal(other, 3000 + 2000 + 1000, 'm-e, m-f and m-g are in Other');

  // In a short range a model keeps its all-time rank, so its colour does not move.
  const week = summarizeUsage(index, { now: options.now, days: 7 });
  assert.equal(week.range.max, false);
  assert.equal(week.modelSeries.models.find((m) => m.label === 'm-b').rank, 1);
});

test('day lists follow the calendar, not 24-hour steps', async () => {
  const { claude, options } = await sandbox();
  await fs.writeFile(path.join(claude, 'one.jsonl'), jsonl([claudeReply('x', at(1), { input_tokens: 1 })]));
  const summary = summarizeUsage(await scanUsage(options), { now: options.now, days: 90 });
  const days = summary.daily.map((point) => point.day);
  assert.equal(new Set(days).size, 90, 'no day repeated');
  for (let i = 1; i < days.length; i++) {
    const [a, b] = [days[i - 1], days[i]].map((day) => new Date(`${day}T12:00:00`));
    assert.equal(Math.round((b - a) / 86400000), 1, `${days[i - 1]} is followed by the next day`);
  }
});

test('a call that re-caches the conversation is re-sent context, and a pause before it is noted', async () => {
  const { claude, options } = await sandbox();
  const reply = (id, minutesAgo, usage) => claudeReply(id, new Date(NOON.getTime() - minutesAgo * 60000).toISOString(), usage);
  await fs.writeFile(path.join(claude, 'long.jsonl'), jsonl([
    { type: 'assistant', aiTitle: 'Long <session>', timestamp: at(3) },
    // Normal turns: small new input on a large cached conversation.
    reply('a', 120, { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 100000, output_tokens: 500 }),
    reply('b', 119, { input_tokens: 3, cache_creation_input_tokens: 3000, cache_read_input_tokens: 102000, output_tokens: 400 }),
    // After a 60-minute break the cache has gone: the whole conversation is written again.
    reply('c', 59, { input_tokens: 3, cache_creation_input_tokens: 105000, cache_read_input_tokens: 0, output_tokens: 300 }),
    // Mid-session miss, no pause.
    reply('d', 58, { input_tokens: 3, cache_creation_input_tokens: 106000, cache_read_input_tokens: 0, output_tokens: 200 }),
    // A small conversation: a miss there is not worth flagging.
    reply('e', 57, { input_tokens: 3, cache_creation_input_tokens: 9000, cache_read_input_tokens: 0, output_tokens: 100 })
  ]));
  const summary = summarizeUsage(await scanUsage(options), { now: options.now, days: 7 });
  const t = summary.totals.claude;
  assert.equal(t.resent, 105000 + 106000);
  assert.equal(t.resentAfterPause, 105000);
  assert.equal(t.newInput, 15 + 2000 + 3000 + 9000);
  assert.equal(t.output, 1500);
  assert.equal(t.total, t.output + t.newInput + t.resent + t.cacheRead, 'the four parts add up to the total');

  const [session] = summary.heaviestSessions;
  assert.equal(session.title, 'Long <session>');
  assert.equal(session.perTurn, 9003, 'what the last call carried');
  assert.equal(session.calls, 5);
});

test('insights speak only when the numbers support them', () => {
  const week = (overrides) => ({ last7: { total: 0, cacheRead: 0, newInput: 0, resent: 0, resentAfterPause: 0, ...overrides } });
  // Re-sent context dominating input, mostly after pauses; cache reads 90% of the total.
  const insights = usageInsights({
    claude: week({ total: 100e6, cacheRead: 90e6, newInput: 3e6, resent: 7e6, resentAfterPause: 6e6 }),
    codex: week({ total: 10e6, cacheRead: 9e6, newInput: 1e6, resent: 0 })
  }, [{ agent: 'claude', title: 'Big chat', project: 'p', perTurn: 872000 }]);
  assert.deepEqual(insights.map((i) => i.kind), ['resent', 'cacheReads']);
  assert.match(insights[0].message, /^Re-sent context was 70% of Claude Code's input this week/);
  assert.match(insights[0].advice, /after a break/);
  assert.match(insights[1].message, /^90% of this week's tokens were cache reads/);
  assert.match(insights[1].advice, /"Big chat", carries 872k tokens a turn/);

  // Mid-session misses get different advice; small amounts say nothing.
  const midSession = usageInsights({ claude: week({ total: 20e6, cacheRead: 5e6, newInput: 3e6, resent: 7e6, resentAfterPause: 1e6 }) });
  assert.match(midSession[0].advice, /mid-session/);
  assert.deepEqual(usageInsights({ claude: week({ total: 2e6, cacheRead: 1e6, newInput: 1e5, resent: 9e5 }) }), []);
});

test('heaviest sessions are the ones still in use this week', async () => {
  const { claude, options } = await sandbox();
  const big = { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 400000, output_tokens: 10 };
  await fs.writeFile(path.join(claude, 'old.jsonl'), jsonl([claudeReply('old', at(24 * 20), big)]));
  await fs.writeFile(path.join(claude, 'recent.jsonl'), jsonl([claudeReply('new', at(2), { ...big, cache_read_input_tokens: 100000 })]));
  const summary = summarizeUsage(await scanUsage(options), { now: options.now, days: 30 });
  assert.deepEqual(summary.heaviestSessions.map((s) => s.perTurn), [101003], 'the bigger session was last used 20 days ago');
});
