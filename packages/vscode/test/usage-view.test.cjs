const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => this.listeners.push(listener);
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
}
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter, Uri: { parse: (value) => value }, commands: { executeCommand: async () => {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const { UsageStore, UsageWebview, projectLimits } = require('../src/usage-view.cjs');
Module._load = originalLoad;

function day(offset) {
  const date = new Date(2026, 9, 9 - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const parts = (work, cacheRead = 0) => ({ fresh: work, cacheWrite: 0, cacheRead, output: Math.round(work / 10), calls: 1, work, resent: Math.round(work / 4), resentAfterPause: 0, newInput: work - Math.round(work / 4), total: work + cacheRead });
function summary(days = 7) {
  const daily = [];
  for (let i = days - 1; i >= 0; i--) daily.push({ day: day(i), codex: parts(i === 0 ? 3e6 : 1e6, 5e7), claude: parts(i % 2 ? 2e6 : 0, 4e7) });
  const windows = () => ({ lastHour: parts(1e5), last24h: parts(2.4e6), today: parts(3e6, 9e7), last7: parts(9e6), last30: parts(3e7) });
  return {
    days,
    range: { from: daily[0].day, to: daily.at(-1).day },
    scannedAt: '2026-10-09T10:00:00.000Z',
    totals: { codex: parts(5e7), claude: parts(4e7) },
    windows: { codex: windows(), claude: windows() },
    burnPerHour: { codex: 100000, claude: 50000 },
    heaviestSessions: [{ agent: 'claude', title: 'Long <chat>', project: 'turntrail', perTurn: 872000, lastActive: new Date().toISOString(), calls: 266, total: 1, resent: 0 }],
    insights: [{ kind: 'resent', agent: 'claude', message: 'Re-sent context was 69% of input.', advice: 'Start a fresh session after a break.' }],
    daily,
    byModel: [{ agent: 'codex', label: 'gpt-6.1-sol', work: 7e6, cacheRead: 1e8, total: 1.07e8, output: 7e5 }],
    byProject: [{ agent: 'claude', label: 'turntrail <x>', work: 5e6, cacheRead: 9e7, total: 9.5e7, output: 5e5 }],
    byAccount: []
  };
}

test('the store draws from the saved index, then brings it up to date', async () => {
  let scans = 0;
  const index = { files: { a: {} } };
  const store = new UsageStore(async () => ({
    readUsageIndex: async () => index,
    summarizeUsage: (got, options) => ({ ...summary(options.days), from: got }),
    estimateUsageCost: () => ({ total: 12.5, priced: 1, unpriced: [] })
  }), {
    runScan: async () => { scans++; },
    getLimits: async () => [{ agent: 'codex', account: 'Studio', window: 'weekly', usedPercent: 51 }],
    getPrices: () => ({ 'gpt-*': { input: 1, output: 2 } })
  });
  const model = await store.viewModel();
  assert.equal(model.summary.from, index);
  assert.equal(model.days, 30);
  assert.equal(model.limits.length, 1);
  assert.equal(model.cost.total, 12.5);
  assert.equal(scans, 0, 'showing the saved index needs no scan');

  await Promise.all([store.refresh(), store.refresh()]);
  assert.equal(scans, 1, 'a refresh during a refresh waits for it');
  store.setDays(90);
  assert.equal((await store.viewModel()).days, 90);
  store.setDays(12);
  assert.equal(store.days, 30, 'only the offered ranges are accepted');
});

test('a failed scan is reported, and an empty history says how to get one', async () => {
  const store = new UsageStore(async () => ({ readUsageIndex: async () => ({ files: {} }), summarizeUsage: () => { throw new Error('unused'); } }), {
    runScan: async () => { throw new Error('disk unreadable'); }
  });
  await store.refresh();
  const model = await store.viewModel();
  assert.equal(model.error, 'disk unreadable');
  assert.equal(model.summary, undefined);
});

test('limits that run out before their reset come first', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const accounts = [{ id: 'a', provider: 'codex', label: 'Studio' }, { id: 'b', provider: 'claude', label: 'Jha' }];
  const usage = new Map([
    ['a', { windows: [{ label: 'weekly', usedPercent: 20 }] }],
    ['b', { windows: [{ label: '5h' }, { label: 'weekly', usedPercent: 60 }] }]
  ]);
  const project = (window) => ({
    weekly: window.usedPercent === 60
      ? { label: 'weekly', usedPercent: 60, resetsAt: 'r', runsOutAt: 'o', beforeReset: true }
      : { label: 'weekly', usedPercent: 20, resetsAt: 'r', beforeReset: false },
    '5h': { label: '5h', stale: true }
  })[window.label];
  const rows = projectLimits(accounts, usage, project, now);
  assert.deepEqual(rows.map((row) => [row.account, row.window, row.beforeReset]), [['Jha', 'weekly', true], ['Studio', 'weekly', false]]);
});

function pageScript() {
  let html;
  const webview = { cspSource: 'x', options: {}, set html(v) { html = v; }, get html() { return html; }, onDidReceiveMessage() {}, postMessage() {} };
  const store = new UsageStore(async () => ({}));
  store.refresh = async () => {};
  new UsageWebview(store).resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: false });
  return html.slice(html.indexOf('>', html.indexOf('<script nonce')) + 1, html.lastIndexOf('</script>'));
}

function page(state = {}) {
  const sent = [];
  const listeners = {};
  const root = { innerHTML: '', clientWidth: 300, addEventListener(type, fn) { listeners[type] = fn; }, querySelector: () => null, querySelectorAll: () => [] };
  const context = vm.createContext({
    acquireVsCodeApi: () => ({ getState: () => state, setState() {}, postMessage: (m) => sent.push(m) }),
    document: { getElementById: () => root },
    window: { addEventListener(type, fn) { listeners['window:' + type] = fn; } },
    Date,
    Math
  });
  new vm.Script(pageScript()).runInContext(context);
  return {
    root,
    sent,
    state: (model) => listeners['window:message']({ data: { type: 'state', model } }),
    click: (target) => listeners.click({ target: { closest: (selector) => (target[selector] ? target[selector] : null) } })
  };
}

test('the page asks for its state once listening and draws both agents', () => {
  const view = page();
  assert.equal(JSON.stringify(view.sent), JSON.stringify([{ type: 'ready' }]));
  view.state({ days: 7, summary: summary(7), limits: [{ agent: 'claude', account: 'Jha', window: 'weekly', usedPercent: 60, resetsAt: new Date(Date.now() + 864e5).toISOString(), runsOutAt: new Date(Date.now() + 36e5).toISOString(), beforeReset: true }] });
  const html = view.root.innerHTML;
  assert.match(html, /Codex<\/div>/);
  assert.match(html, /Claude Code<\/div>/);
  assert.match(html, /<svg viewBox="0 0 300 150"/);
  assert.equal((html.match(/class="hit/g) || []).length, 7, 'one hover target per day');
  assert.match(html, /var\(--series-codex\)/);
  assert.match(html, /var\(--series-claude\)/);
  assert.match(html, /At this pace it runs out in/);
  assert.match(html, /turntrail &lt;x&gt;/, 'names are escaped');
  assert.match(html, /nothing is sent anywhere/);
});

test('the chart has a table view, and the range is the host\'s to change', () => {
  const view = page();
  view.state({ days: 7, summary: summary(7), limits: [] });
  view.click({ '[data-act]': { getAttribute: () => 'table' } });
  assert.match(view.root.innerHTML, /<table><thead><tr><th>Day<\/th>/);
  assert.doesNotMatch(view.root.innerHTML, /<svg/);
  view.click({ '[data-range]': { getAttribute: () => '90' } });
  assert.equal(JSON.stringify(view.sent.at(-1)), JSON.stringify({ type: 'range', days: 90 }));
});

test('a first scan says what it is doing instead of showing an empty chart', () => {
  const view = page();
  view.state({ days: 30, loading: true, firstScan: true });
  assert.match(view.root.innerHTML, /for the first time/);
});

function modelSummary(days, options = {}) {
  const base = summary(days);
  const models = [
    { key: 'codex|gpt-a', label: 'gpt-a', agent: 'codex', rank: 0 },
    { key: 'claude|opus-b', label: 'opus-b', agent: 'claude', rank: 1 },
    { key: 'other', label: 'Other models (3)', rank: -1 }
  ];
  return {
    ...base,
    range: { from: base.daily[0].day, to: base.daily.at(-1).day, max: Boolean(options.max) },
    byModel: [
      { key: 'codex|gpt-a', label: 'gpt-a', agent: 'codex', total: 6e6, output: 6e5 },
      { key: 'claude|opus-b', label: 'opus-b', agent: 'claude', total: 3e6, output: 3e5 },
      { key: 'codex|gpt-c <old>', label: 'gpt-c <old>', agent: 'codex', total: 1e6, output: 1e5 }
    ],
    modelSeries: {
      models,
      daily: base.daily.map((point) => ({ day: point.day, total: { 'codex|gpt-a': 2e6, 'claude|opus-b': 1e6, other: 5e5 }, work: { 'codex|gpt-a': 1e5, 'claude|opus-b': 5e4, other: 2e4 } }))
    }
  };
}

test('the chart can split by model, with each model\'s colour and an Other series', () => {
  const view = page();
  view.state({ days: 7, summary: modelSummary(7), limits: [] });
  view.click({ '[data-split]': { getAttribute: () => 'model' } });
  const html = view.root.innerHTML;
  assert.match(html, /aria-pressed="true">Models</);
  assert.match(html, /background:var\(--m0\)"><\/i>gpt-a/);
  assert.match(html, /background:var\(--m1\)"><\/i>opus-b/);
  assert.match(html, /background:var\(--m-other\)"><\/i>Other models \(3\)/);
  assert.match(html, /aria-label="Daily tokens by model"/);
  // The model table lists every model with its share of the range.
  assert.ok(html.includes('<span class="section-title">Models</span><span class="gist">3 · gpt-a '));
  assert.match(html, /gpt-a<span class="agent-tag">Codex<\/span>/);
  assert.match(html, />60%</);
  assert.match(html, /gpt-c &lt;old&gt;/);
});

test('Max asks the host for everything, and a long range is drawn in weeks', () => {
  const view = page();
  view.state({ days: 'max', summary: modelSummary(200, { max: true }), limits: [] });
  const html = view.root.innerHTML;
  assert.match(html, /data-range="max" aria-pressed="true" title="Everything recorded">Max</);
  assert.ok(html.includes('<span class="gist">by week · all time</span>'));
  assert.match(html, /<div class="stat-label">All time<\/div>/);
  const bars = (html.match(/class="hit/g) || []).length;
  assert.ok(bars >= 28 && bars <= 30, `200 days fall into about 29 weeks, got ${bars}`);
  view.click({ '[data-range]': { getAttribute: () => 'max' } });
  assert.equal(JSON.stringify(view.sent.at(-1)), JSON.stringify({ type: 'range', days: 'max' }));
});

test('the store accepts Max as a range', () => {
  const store = new UsageStore(async () => ({}));
  store.setDays('max');
  assert.equal(store.days, 'max');
});

test('the headline gives the total and its four parts, and insights sit right under it', () => {
  const view = page();
  view.state({ days: 7, summary: summary(7), limits: [] });
  const html = view.root.innerHTML;
  const headline = html.slice(html.indexOf('class="card headline"'), html.indexOf('class="card insight"'));
  assert.ok(headline.includes('Tokens processed · 7 days'));
  assert.ok(headline.includes('<div class="big">'));
  for (const label of ['Output', 'New input', 'Re-sent context', 'Cache reads']) assert.ok(headline.includes(label), label);
  assert.ok(html.includes('class="card insight"><div class="insight-title">What stands out</div><div class="insight-item"><div class="insight-head">Re-sent context was 69% of input.</div>'));
  assert.ok(html.indexOf('card insight') < html.indexOf('data-section="time"'), 'insights come before the sections');
});

test('details live in sections that show a gist when closed and remember being opened', () => {
  const view = page();
  view.state({ days: 7, summary: summary(7), limits: [{ agent: 'codex', account: 'Studio', window: 'weekly', usedPercent: 80, resetsAt: new Date(Date.now() + 864e5).toISOString(), runsOutAt: new Date(Date.now() + 36e5).toISOString(), beforeReset: true }] });
  const html = view.root.innerHTML;
  assert.ok(html.includes('<details class="section" data-section="time" open>'), 'the chart starts open');
  const limits = html.slice(html.indexOf('data-section="limits"'), html.indexOf('data-section="sessions"'));
  assert.ok(limits.startsWith('data-section="limits" open>'), 'a limit at risk opens its section');
  assert.ok(limits.includes('⚠ 1 will run out before reset'));
  assert.ok(html.includes('<details class="section" data-section="sessions"><summary><span class="section-title">Heaviest recent sessions</span><span class="gist">Long &lt;chat&gt; · 872k a turn</span>'));
  assert.ok(html.includes('<details class="section" data-section="models">'), 'other sections start closed');
  assert.ok(html.includes('data-section="about"'));
});

test('a reopened page draws sections as they were left', () => {
  const view = page({ open: { models: true, time: false } });
  view.state({ days: 7, summary: summary(7), limits: [] });
  assert.ok(view.root.innerHTML.includes('data-section="models" open'));
  assert.ok(view.root.innerHTML.includes('data-section="time">'));
});
