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
const parts = (work, cacheRead = 0) => ({ fresh: work, cacheWrite: 0, cacheRead, output: 0, calls: 1, work });
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
    daily,
    byModel: [{ agent: 'codex', label: 'gpt-6.1-sol', work: 7e6, cacheRead: 1e8 }],
    byProject: [{ agent: 'claude', label: 'turntrail <x>', work: 5e6, cacheRead: 9e7 }],
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
