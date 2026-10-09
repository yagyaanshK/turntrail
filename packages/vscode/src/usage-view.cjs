const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');

// Usage Statistics: token use across every agent, read from the transcripts
// they write on this machine. Nothing is sent anywhere.

// 'max' is everything recorded, from the first day with any usage.
const RANGES = [7, 30, 90, 'max'];

class UsageStore {
  // options.getLimits(): quota-based projections per account.
  // options.getPrices(): the user's per-model prices, or nothing.
  // options.runScan(): scans in a worker; falls back to the host if absent.
  constructor(core, options = {}) {
    this.core = core;
    this.options = options;
    this.index = undefined;
    this.days = 30;
    this.loading = false;
    this.error = undefined;
    this.running = undefined;
    this.scannedOnce = false;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  setDays(days) {
    const value = days === 'max' ? 'max' : RANGES.includes(Number(days)) ? Number(days) : 30;
    if (value === this.days) return;
    this.days = value;
    this.fire();
  }

  // One scan at a time; a request during a scan waits for it.
  refresh() {
    if (this.running) return this.running;
    this.loading = true;
    this.fire();
    this.running = (async () => {
      const api = await this.core();
      if (this.options.runScan) await this.options.runScan();
      else await api.scanUsage();
      this.index = await api.readUsageIndex();
      this.error = undefined;
      this.scannedOnce = true;
    })()
      .catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.loading = false;
        this.running = undefined;
        this.fire();
      });
    return this.running;
  }

  async viewModel() {
    const api = await this.core();
    // The saved index is drawn at once; a scan brings it up to date after.
    if (!this.index) this.index = await api.readUsageIndex().catch(() => undefined);
    const hasData = Boolean(this.index && Object.keys(this.index.files || {}).length > 0);
    const summary = hasData ? api.summarizeUsage(this.index, { days: this.days, top: 6, modelTop: 50 }) : undefined;
    let limits = [];
    try {
      limits = (await this.options.getLimits?.()) || [];
    } catch {
      limits = [];
    }
    let cost;
    const prices = this.options.getPrices?.();
    if (summary && prices && Object.keys(prices).length > 0) cost = api.estimateUsageCost(summary.byModel, prices);
    return {
      days: this.days,
      loading: this.loading,
      firstScan: this.loading && !hasData,
      error: this.error,
      summary,
      limits,
      cost
    };
  }

  fire() {
    this.emitter.fire();
  }
}

class UsageWebview {
  constructor(store) {
    this.store = store;
    this.view = undefined;
    store.onDidChange(() => this.update());
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      // Sent by the page once it is listening, so the first state is never lost.
      if (message?.type === 'ready') {
        this.update({ force: true });
        return;
      }
      if (message?.type === 'range') this.store.setDays(message.days);
      if (message?.type === 'refresh') this.store.refresh();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.store.refresh();
    });
    this.update();
    this.store.refresh();
  }

  async update(options = {}) {
    if (!this.view || (!this.view.visible && !options.force)) return;
    const model = await this.store.viewModel().catch((error) => ({ error: error.message, days: this.store.days }));
    this.view?.webview.postMessage({ type: 'state', model });
  }
}

// The quota windows of every account, each with where it is heading at the
// pace it has been used so far.
function projectLimits(accounts, usageById, projectLimitWindow, now = Date.now()) {
  const rows = [];
  for (const account of accounts) {
    const usage = usageById.get(account.id);
    for (const window of usage?.windows || []) {
      const projection = projectLimitWindow(window, now);
      if (!projection || projection.stale) continue;
      rows.push({
        agent: account.provider,
        account: account.label || account.id,
        window: projection.label || window.label || 'limit',
        usedPercent: projection.usedPercent,
        resetsAt: projection.resetsAt,
        runsOutAt: projection.runsOutAt,
        beforeReset: Boolean(projection.beforeReset),
        exhausted: Boolean(projection.exhausted)
      });
    }
  }
  // The ones about to run out first.
  return rows.sort((a, b) => Number(b.beforeReset) - Number(a.beforeReset) || b.usedPercent - a.usedPercent);
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  /* Series colours from the reference categorical palette, slots 1 and 2,
     validated for colour-blind separation on light and dark sidebars. */
  /* Models: four reference palette slots (yellow, magenta, green, violet),
     kept clear of the two agent colours; "Other" is neutral. Models stack in
     range order but keep an all-time colour, so any two can touch: this is the
     only set that passes every pairing on light and dark sidebars. Its dark
     colour-blind separation is in the 6-8 band, legal with the segment gaps,
     legend, tooltip and table as second cues; two light slots are under 3:1,
     which the same text covers. */
  :root {
    --m0: #eda100; --m1: #e87ba4; --m2: #008300; --m3: #4a3aa7; --m-other: #8f8f8a;
    --line: var(--vscode-panel-border, rgba(128,128,128,0.28));
    --dim: var(--vscode-descriptionForeground);
    --grid: rgba(128,128,128,0.18);
    --series-codex: #2a78d6;
    --series-claude: #eb6834;
    --surface: var(--vscode-sideBar-background, #f8f8f8);
  }
  body.vscode-dark, body.vscode-high-contrast {
    --m0: #c98500; --m1: #d55181; --m2: #008300; --m3: #9085e9; --m-other: #77776f;
    --series-codex: #3987e5;
    --series-claude: #d95926;
    --surface: var(--vscode-sideBar-background, #181818);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 10px 10px 20px; color: var(--vscode-foreground); background: transparent; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .segments { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .segments button { border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--dim); padding: 2px 8px; font: inherit; font-size: 0.85em; cursor: pointer; }
  .segments button:last-child { border-right: 0; }
  .segments button[aria-pressed="true"] { color: var(--vscode-foreground); background: var(--vscode-list-inactiveSelectionBackground); }
  .spacer { flex: 1; }
  .icon-button { border: 0; background: transparent; color: var(--dim); cursor: pointer; font-size: 1em; padding: 2px 4px; }
  .icon-button:hover { color: var(--vscode-foreground); }
  .tiles { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 12px; }
  .agent { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  .agent-head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
  .s-codex { background: var(--series-codex); }
  .s-claude { background: var(--series-claude); }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .stat-label { color: var(--dim); font-size: 0.8em; }
  .stat-value { font-size: 1.25em; font-variant-numeric: tabular-nums; }
  .stat-sub { color: var(--dim); font-size: 0.78em; }
  h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); font-weight: 600; margin: 16px 0 6px; }
  .legend { display: flex; gap: 6px 12px; flex-wrap: wrap; font-size: 0.85em; margin-bottom: 4px; }
  .table-wrap { overflow-x: auto; }
  .agent-tag { display: block; color: var(--dim); font-size: 0.85em; }
  .share { height: 3px; background: var(--grid); border-radius: 2px; margin-top: 3px; overflow: hidden; }
  .share > div { height: 100%; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .chart { position: relative; }
  .chart-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 16px 0 6px; }
  .chart-head h3 { margin: 0; }
  .chart svg { display: block; width: 100%; overflow: visible; }
  .axis { fill: var(--dim); font-size: 10px; font-family: var(--vscode-font-family); }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .hit { fill: transparent; cursor: default; }
  .hit:hover, .hit.focus { fill: rgba(128,128,128,0.10); }
  .tooltip { position: absolute; pointer-events: none; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, inherit); border: 1px solid var(--vscode-editorHoverWidget-border, var(--line)); border-radius: 4px; padding: 6px 8px; font-size: 0.85em; white-space: nowrap; z-index: 2; }
  .tooltip .row { display: flex; align-items: center; gap: 6px; }
  .tooltip .num { margin-left: auto; padding-left: 12px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; color: var(--dim); font-weight: 600; border-bottom: 1px solid var(--line); padding: 3px 4px; }
  td { padding: 3px 4px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  td.n, th.n { text-align: right; }
  .name { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .limit { padding: 6px 0; border-bottom: 1px solid var(--grid); }
  .limit-top { display: flex; align-items: center; gap: 6px; }
  .limit-top .pct { margin-left: auto; font-variant-numeric: tabular-nums; }
  .limit-note { color: var(--dim); font-size: 0.85em; margin-top: 2px; }
  .limit-note.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .meter { height: 4px; background: var(--grid); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .meter > div { height: 100%; border-radius: 2px; }
  .note { color: var(--dim); font-size: 0.82em; line-height: 1.45; margin-top: 14px; }
  .empty { color: var(--dim); line-height: 1.5; padding: 6px 0; }
  .error { color: var(--vscode-errorForeground); margin: 6px 0; }
  .link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; font-size: 0.85em; }
</style>
</head>
<body>
<div id="root"><div class="empty">Reading token counts…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const saved = vscode.getState() || {};
let model = saved.model || null;
let metric = saved.metric || 'work';
let showTable = Boolean(saved.showTable);
let split = saved.split === 'model' ? 'model' : 'agent';
let lastView = null;
let hover = -1;
const MODEL_COLORS = 4;
const AGENTS = [
  { id: 'codex', name: 'Codex', cls: 's-codex', color: 'var(--series-codex)' },
  { id: 'claude', name: 'Claude Code', cls: 's-claude', color: 'var(--series-claude)' }
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function persist() { vscode.setState({ model: model, metric: metric, showTable: showTable, split: split }); }
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}
function dayLabel(day) {
  const parts = String(day).split('-');
  return MONTHS[Number(parts[1]) - 1] + ' ' + Number(parts[2]);
}
function until(iso) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!isFinite(minutes)) return 'soon';
  if (minutes <= 0) return 'now';
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '');
  const days = Math.floor(hours / 24);
  return days + 'd' + (hours % 24 ? ' ' + (hours % 24) + 'h' : '');
}
function niceMax(max) {
  if (max <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
  for (const step of steps) if (step * power >= max) return step * power;
  return 10 * power;
}
function rangeLabel(summary) { return summary.range && summary.range.max ? 'all time' : summary.days + ' days'; }

// Models keep the colour of their all-time rank, so a model looks the same in
// every range. A shown model outside the top five takes the first colour no
// higher-ranked shown model holds; the rest fold into grey "Other".
function modelColors(models) {
  const colors = {};
  const taken = {};
  models.forEach(function (m) {
    if (m.rank >= 0 && m.rank < MODEL_COLORS) { colors[m.key] = m.rank; taken[m.rank] = true; }
  });
  models.forEach(function (m) {
    if (m.key === 'other' || colors[m.key] !== undefined) return;
    for (let slot = 0; slot < MODEL_COLORS; slot++) {
      if (!taken[slot]) { colors[m.key] = slot; taken[slot] = true; return; }
    }
  });
  return colors;
}

function seriesFor(summary) {
  if (split === 'model' && summary.modelSeries && summary.modelSeries.models.length) {
    const slots = modelColors(summary.modelSeries.models);
    return summary.modelSeries.models.map(function (m) {
      const slot = slots[m.key];
      const agent = AGENTS.find(function (a) { return a.id === m.agent; });
      return { key: m.key, label: m.label, sub: agent ? agent.name : '', color: slot === undefined ? 'var(--m-other)' : 'var(--m' + slot + ')' };
    });
  }
  return AGENTS.map(function (a) { return { key: a.id, label: a.name, color: a.color }; });
}

function weekStart(day) {
  const parts = day.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// The bars to draw. Up to 120 days each day is a bar; longer ranges group into
// Monday-to-Sunday weeks, and past two years into calendar months, so a bar is
// never thinner than the screen can show.
function buildView(summary) {
  const series = seriesFor(summary);
  const byModel = split === 'model' && summary.modelSeries && summary.modelSeries.models.length;
  const days = summary.daily.map(function (p, i) {
    const values = {};
    series.forEach(function (s) {
      if (byModel) {
        const d = summary.modelSeries.daily[i];
        values[s.key] = ((metric === 'work' ? d.work : d.cacheRead) || {})[s.key] || 0;
      } else {
        values[s.key] = p[s.key] ? (metric === 'work' ? p[s.key].work : p[s.key].cacheRead) : 0;
      }
    });
    return { day: p.day, values: values };
  });
  const unit = days.length > 730 ? 'month' : days.length > 120 ? 'week' : 'day';
  if (unit === 'day') {
    return { unit: unit, series: series, points: days.map(function (d) { return { label: dayLabel(d.day), axis: dayLabel(d.day), values: d.values }; }) };
  }
  const bins = [];
  const index = {};
  days.forEach(function (d) {
    const key = unit === 'month' ? d.day.slice(0, 7) : weekStart(d.day);
    if (index[key] === undefined) {
      index[key] = bins.length;
      const parts = key.split('-');
      const month = MONTHS[Number(parts[1]) - 1];
      bins.push({
        label: unit === 'month' ? month + ' ' + parts[0] : 'Week of ' + dayLabel(key),
        axis: unit === 'month' ? month + " '" + parts[0].slice(2) : dayLabel(key),
        values: {}
      });
    }
    const bin = bins[index[key]];
    series.forEach(function (s) { bin.values[s.key] = (bin.values[s.key] || 0) + d.values[s.key]; });
  });
  return { unit: unit, series: series, points: bins };
}

function tiles(summary) {
  return '<div class="tiles">' + AGENTS.map(function (agent) {
    const w = summary.windows[agent.id];
    const range = summary.daily.reduce(function (sum, p) { return sum + p[agent.id].work; }, 0);
    const label = summary.range && summary.range.max ? 'All time' : summary.days + ' days';
    return '<div class="agent"><div class="agent-head"><span class="swatch ' + agent.cls + '"></span>' + esc(agent.name) + '</div>' +
      '<div class="stats">' +
        '<div><div class="stat-label">Today</div><div class="stat-value">' + fmt(w.today.work) + '</div><div class="stat-sub">' + fmt(w.today.cacheRead) + ' cache</div></div>' +
        '<div><div class="stat-label">Per hour</div><div class="stat-value">' + fmt(summary.burnPerHour[agent.id]) + '</div><div class="stat-sub">last 24h</div></div>' +
        '<div><div class="stat-label">' + label + '</div><div class="stat-value">' + fmt(range) + '</div><div class="stat-sub">' + fmt(w.last7.work) + ' in 7d</div></div>' +
      '</div></div>';
  }).join('') + '</div>';
}

function chart(view) {
  const points = view.points;
  const series = view.series;
  const width = Math.max(220, root.clientWidth || 280);
  const height = 150;
  const left = 34, right = 4, top = 8, bottom = 18;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const totals = points.map(function (p) { return series.reduce(function (sum, s) { return sum + p.values[s.key]; }, 0); });
  const max = niceMax(Math.max.apply(null, totals.concat([0])));
  const band = plotW / Math.max(1, points.length);
  const barW = Math.max(1, Math.min(24, band * 0.72));
  const y = function (v) { return top + plotH - (v / max) * plotH; };
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" height="' + height + '" role="img" aria-label="' +
    esc((view.unit === 'day' ? 'Daily ' : view.unit === 'week' ? 'Weekly ' : 'Monthly ') + (metric === 'work' ? 'work tokens' : 'cache reads') + ' by ' + (split === 'model' ? 'model' : 'agent')) + '">';
  [0, 0.5, 1].forEach(function (f) {
    const gy = y(max * f);
    svg += '<line class="grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + gy + '" y2="' + gy + '"/>';
    svg += '<text class="axis" x="' + (left - 4) + '" y="' + (gy + 3) + '" text-anchor="end">' + fmt(max * f) + '</text>';
  });
  points.forEach(function (p, i) {
    const x = left + i * band + (band - barW) / 2;
    const segments = series.map(function (s) { return { v: p.values[s.key], color: s.color }; }).filter(function (s) { return s.v > 0; });
    const gap = segments.length > 1 ? Math.min(2, barW / 2) : 0;
    const radius = Math.min(4, barW / 2);
    let base = y(0);
    segments.forEach(function (s, k) {
      const h = Math.max(0, (s.v / max) * plotH - (k > 0 ? gap : 0));
      const yTop = base - h - (k > 0 ? gap : 0);
      if (h <= 0) return;
      if (k === segments.length - 1 && h > radius) {
        const r = radius;
        svg += '<path fill="' + s.color + '" d="M' + x + ' ' + (yTop + h) + 'V' + (yTop + r) + 'Q' + x + ' ' + yTop + ' ' + (x + r) + ' ' + yTop +
          'H' + (x + barW - r) + 'Q' + (x + barW) + ' ' + yTop + ' ' + (x + barW) + ' ' + (yTop + r) + 'V' + (yTop + h) + 'Z"/>';
      } else {
        svg += '<rect fill="' + s.color + '" x="' + x + '" y="' + yTop + '" width="' + barW + '" height="' + h + '"/>';
      }
      base = yTop;
    });
    svg += '<rect class="hit' + (i === hover ? ' focus' : '') + '" data-i="' + i + '" x="' + (left + i * band) + '" y="' + top + '" width="' + band + '" height="' + plotH + '"/>';
  });
  if (points.length) {
    const labels = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [0, points.length - 1];
    labels.forEach(function (i, n) {
      const last = n === labels.length - 1;
      const anchor = n === 0 ? 'start' : last ? 'end' : 'middle';
      const x = n === 0 ? left : last ? width - right : left + i * band + band / 2;
      svg += '<text class="axis" x="' + x + '" y="' + (height - 4) + '" text-anchor="' + anchor + '">' + esc(points[i].axis) + '</text>';
    });
  }
  svg += '</svg>';
  const legend = '<div class="legend">' + series.map(function (s) {
    return '<span title="' + esc(s.sub || '') + '"><i class="swatch" style="background:' + s.color + '"></i>' + esc(s.label) + '</span>';
  }).join('') + '</div>';
  return legend + '<div class="chart">' + svg + '<div class="tooltip" id="tip" hidden></div></div>';
}

function dataTable(view) {
  const unit = view.unit === 'day' ? 'Day' : view.unit === 'week' ? 'Week' : 'Month';
  return '<div class="table-wrap"><table><thead><tr><th>' + unit + '</th>' + view.series.map(function (s) { return '<th class="n">' + esc(s.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    view.points.slice().reverse().map(function (p) {
      return '<tr><td>' + esc(p.label) + '</td>' + view.series.map(function (s) { return '<td class="n">' + fmt(p.values[s.key]) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}

function ranking(title, rows) {
  if (!rows || !rows.length) return '';
  return '<h3>' + esc(title) + '</h3><table><thead><tr><th>Name</th><th class="n">Work</th><th class="n">Cache</th></tr></thead><tbody>' +
    rows.map(function (r) {
      const agent = AGENTS.find(function (a) { return a.id === r.agent; }) || AGENTS[0];
      return '<tr><td><div class="name"><span class="swatch ' + agent.cls + '" title="' + esc(agent.name) + '"></span><span>' + esc(r.label) + '</span></div></td>' +
        '<td class="n">' + fmt(r.work) + '</td><td class="n">' + fmt(r.cacheRead) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

// Every model used in the range, with its share of the range's work. The
// swatch is the model's chart colour when it has its own series, otherwise
// its agent's, and the agent is named under the model.
function modelTable(summary) {
  const rows = summary.byModel || [];
  if (!rows.length) return '';
  const total = rows.reduce(function (sum, r) { return sum + r.work; }, 0) || 1;
  const shown = summary.modelSeries ? summary.modelSeries.models : [];
  const slots = modelColors(shown);
  return '<h3>Models · ' + esc(rangeLabel(summary)) + '</h3><table><thead><tr><th>Model</th><th class="n">Work</th><th class="n">Share</th><th class="n">Cache</th></tr></thead><tbody>' +
    rows.map(function (r) {
      const agent = AGENTS.find(function (a) { return a.id === r.agent; }) || AGENTS[0];
      const color = slots[r.key] !== undefined ? 'var(--m' + slots[r.key] + ')' : agent.color;
      const share = (r.work / total) * 100;
      return '<tr><td><div class="name"><span class="swatch" style="background:' + color + '"></span><span>' + esc(r.label) +
        '<span class="agent-tag">' + esc(agent.name) + '</span></span></div>' +
        '<div class="share"><div style="width:' + share.toFixed(1) + '%;background:' + color + '"></div></div></td>' +
        '<td class="n">' + fmt(r.work) + '</td><td class="n">' + (share >= 10 ? Math.round(share) : share.toFixed(1)) + '%</td><td class="n">' + fmt(r.cacheRead) + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function limits(rows) {
  if (!rows || !rows.length) return '';
  return '<h3>Limits at this pace</h3>' + rows.map(function (r) {
    const agent = AGENTS.find(function (a) { return a.id === r.agent; }) || AGENTS[0];
    let note;
    if (r.exhausted) note = '<div class="limit-note warn">⚠ Limit reached. Resets in ' + until(r.resetsAt) + '.</div>';
    else if (r.beforeReset) note = '<div class="limit-note warn">⚠ At this pace it runs out in ' + until(r.runsOutAt) + ', before it resets in ' + until(r.resetsAt) + '.</div>';
    else note = '<div class="limit-note">On pace to last. Resets in ' + until(r.resetsAt) + '.</div>';
    const pct = Math.max(0, Math.min(100, r.usedPercent));
    return '<div class="limit"><div class="limit-top"><span class="swatch ' + agent.cls + '"></span><span>' + esc(r.account) + ' · ' + esc(r.window) + '</span>' +
      '<span class="pct">' + Math.round(pct) + '% used</span></div>' +
      '<div class="meter"><div style="width:' + pct + '%;background:' + agent.color + '"></div></div>' + note + '</div>';
  }).join('');
}

function render() {
  if (!model) { root.innerHTML = '<div class="empty">Reading token counts…</div>'; return; }
  const days = model.days || 30;
  let html = '<div class="toolbar">' +
    '<div class="segments" role="group" aria-label="Range">' + [7, 30, 90, 'max'].map(function (d) {
      return '<button data-range="' + d + '" aria-pressed="' + (String(d) === String(days)) + '"' + (d === 'max' ? ' title="Everything recorded"' : '') + '>' + (d === 'max' ? 'Max' : d + 'd') + '</button>';
    }).join('') + '</div>' +
    '<div class="segments" role="group" aria-label="Measure">' +
      '<button data-metric="work" aria-pressed="' + (metric === 'work') + '" title="New input, cache writes and output">Work</button>' +
      '<button data-metric="cache" aria-pressed="' + (metric === 'cache') + '" title="The conversation re-read from the prompt cache each turn">Cache reads</button>' +
    '</div><span class="spacer"></span>' +
    (model.loading ? '<span class="stat-sub">Updating…</span>' : '') + '</div>';
  if (model.error) html += '<div class="error">' + esc(model.error) + '</div>';
  const summary = model.summary;
  if (!summary) {
    html += model.firstScan
      ? '<div class="empty">Reading token counts from every Claude Code and Codex chat on this machine for the first time. A long history takes about a minute; after that only new lines are read.</div>'
      : '<div class="empty">No token counts yet. Claude Code and Codex record them in their chats as you use them.</div>';
    root.innerHTML = html;
    return;
  }
  html += tiles(summary);
  lastView = buildView(summary);
  const unitTitle = lastView.unit === 'day' ? 'Daily' : lastView.unit === 'week' ? 'Weekly' : 'Monthly';
  html += '<div class="chart-head"><h3>' + unitTitle + ' ' + (metric === 'work' ? 'work' : 'cache reads') + ' · ' + esc(rangeLabel(summary)) + '</h3>' +
    '<div class="segments" role="group" aria-label="Split by">' +
      '<button data-split="agent" aria-pressed="' + (split === 'agent') + '">Agents</button>' +
      '<button data-split="model" aria-pressed="' + (split === 'model') + '">Models</button>' +
    '</div></div>';
  html += showTable ? dataTable(lastView) : chart(lastView);
  html += '<button class="link" data-act="table">' + (showTable ? 'Show as chart' : 'Show as table') + '</button>';
  html += limits(model.limits);
  if (model.cost) {
    html += '<h3>Estimated cost</h3><div>US$' + model.cost.total.toFixed(2) + ' over ' + esc(rangeLabel(summary)) + ' at your prices' +
      (model.cost.unpriced.length ? '<div class="stat-sub">No price set for ' + esc(model.cost.unpriced.join(', ')) + '.</div>' : '') + '</div>';
  }
  html += ranking('Projects', summary.byProject);
  html += modelTable(summary);
  html += ranking('Accounts', summary.byAccount);
  html += '<div class="note">Work is new input, cache writes and output. Cache reads are the conversation re-read from the prompt cache each turn: most of the raw count, and far cheaper. Read from the chats Claude Code and Codex write on this machine; nothing is sent anywhere.' +
    (summary.scannedAt ? ' Updated ' + new Date(summary.scannedAt).toLocaleTimeString() + '.' : '') + '</div>';
  root.innerHTML = html;
}

function showTip(i) {
  const tip = document.getElementById('tip');
  const svg = root.querySelector('.chart svg');
  if (!tip || !svg || !lastView) return;
  if (i < 0 || !lastView.points[i]) { tip.hidden = true; return; }
  const p = lastView.points[i];
  const total = lastView.series.reduce(function (sum, s) { return sum + p.values[s.key]; }, 0);
  tip.innerHTML = '<div><b>' + esc(p.label) + '</b></div>' + lastView.series.slice().reverse().filter(function (s) { return p.values[s.key] > 0; }).map(function (s) {
    return '<div class="row"><span class="swatch" style="background:' + s.color + '"></span>' + esc(s.label) + '<span class="num">' + fmt(p.values[s.key]) + '</span></div>';
  }).join('') + '<div class="row">Total<span class="num">' + fmt(total) + '</span></div>';
  tip.hidden = false;
  const hit = svg.querySelector('[data-i="' + i + '"]');
  const box = hit.getBoundingClientRect();
  const host = svg.parentElement.getBoundingClientRect();
  let x = box.left - host.left + box.width / 2 - tip.offsetWidth / 2;
  x = Math.max(0, Math.min(host.width - tip.offsetWidth, x));
  tip.style.left = x + 'px';
  tip.style.top = '-6px';
  tip.style.transform = 'translateY(-100%)';
}

root.addEventListener('mousemove', function (event) {
  const hit = event.target.closest && event.target.closest('[data-i]');
  const i = hit ? Number(hit.getAttribute('data-i')) : -1;
  if (i === hover) return;
  hover = i;
  root.querySelectorAll('.hit.focus').forEach(function (el) { el.classList.remove('focus'); });
  if (hit) hit.classList.add('focus');
  showTip(i);
});
root.addEventListener('mouseleave', function () { hover = -1; showTip(-1); });
root.addEventListener('click', function (event) {
  const range = event.target.closest('[data-range]');
  if (range) {
    const value = range.getAttribute('data-range');
    vscode.postMessage({ type: 'range', days: value === 'max' ? 'max' : Number(value) });
    return;
  }
  const by = event.target.closest('[data-split]');
  if (by) { split = by.getAttribute('data-split') === 'model' ? 'model' : 'agent'; hover = -1; persist(); render(); return; }
  const m = event.target.closest('[data-metric]');
  if (m) { metric = m.getAttribute('data-metric'); persist(); render(); return; }
  const act = event.target.closest('[data-act]');
  if (!act) return;
  if (act.getAttribute('data-act') === 'table') { showTable = !showTable; persist(); render(); return; }
  if (act.getAttribute('data-act') === 'refresh') vscode.postMessage({ type: 'refresh' });
});
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'state') { model = event.data.model; persist(); render(); }
});
if (typeof ResizeObserver === 'function') {
  let width = 0;
  new ResizeObserver(function () {
    if (Math.abs(root.clientWidth - width) < 4) return;
    width = root.clientWidth;
    if (model && model.summary && !showTable) render();
  }).observe(root);
}
render();
// Last, once the listener above exists: ask for the current state.
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { UsageStore, UsageWebview, projectLimits, RANGES, workerPath: path.join(__dirname, 'usage-worker.cjs') };
