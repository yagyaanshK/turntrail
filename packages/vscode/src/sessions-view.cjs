const crypto = require('node:crypto');
const vscode = require('vscode');

const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'cursor', label: 'Cursor' }
];

class SessionsStore {
  constructor(core, root, options = {}) {
    this.core = core;
    this.root = root;
    this.discoveryOptions = options.discoveryOptions;
    this.rows = new Map();
    this.all = false;
    this.loading = false;
    this.errors = [];
    this.updatedAt = undefined;
    this.managed = [];
    this.generation = 0;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  async refresh(options = {}) {
    const generation = ++this.generation;
    this.all = options.all === undefined ? this.all : Boolean(options.all);
    this.loading = true;
    this.fire();
    try {
      const [{ listSessionIndex }, root, discoveryOptions] = await Promise.all([
        this.core(),
        this.root(),
        typeof this.discoveryOptions === 'function' ? this.discoveryOptions() : this.discoveryOptions
      ]);
      const result = await listSessionIndex(root, {
        all: this.all,
        signal: options.signal,
        discoveryOptions: discoveryOptions || {}
      });
      if (generation !== this.generation) return this.viewModel();
      this.rows = new Map(result.sessions.map((row) => [row.id, row]));
      this.errors = result.errors || [];
      this.updatedAt = new Date().toISOString();
    } catch (error) {
      if (generation !== this.generation) return this.viewModel();
      if (options.signal?.aborted) throw error;
      this.errors = [{ provider: 'sessions', message: error instanceof Error ? error.message : String(error) }];
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.fire();
      }
    }
    return this.viewModel();
  }

  resolve(id) {
    return this.rows.get(String(id || ''));
  }

  markImported(id, result) {
    const row = this.resolve(id);
    if (!row) return;
    const updated = {
      ...row,
      imported: true,
      importedAt: new Date().toISOString(),
      ledgerSessionId: result?.id || row.ledgerSessionId
    };
    this.rows.set(updated.id, updated);
    this.fire();
  }

  setManaged(rows) {
    this.managed = Array.isArray(rows) ? rows.map(publicManagedRow) : [];
    this.fire();
  }

  stale(maxAgeMs = 60000) {
    const timestamp = Date.parse(this.updatedAt || '');
    return !Number.isFinite(timestamp) || Date.now() - timestamp > maxAgeMs;
  }

  viewModel() {
    return {
      sessions: [...this.rows.values()].map(publicRow),
      managed: this.managed,
      providers: PROVIDERS,
      all: this.all,
      loading: this.loading,
      errors: this.errors.map((error) => ({
        provider: String(error?.provider || 'sessions'),
        message: String(error?.message || 'Session discovery failed.')
      })),
      updatedAt: this.updatedAt
    };
  }

  fire() {
    this.emitter.fire(this.viewModel());
  }
}

class SessionsWebview {
  constructor(store) {
    this.store = store;
    this.view = undefined;
    store.onDidChange((model) => this.post(model));
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      const commands = {
        refresh: 'turntrail.refreshSessions',
        scope: 'turntrail.refreshSessions',
        import: 'turntrail.importIndexedSession',
        view: 'turntrail.viewIndexedSession',
        handoff: 'turntrail.handoffIndexedSession',
        openManaged: 'turntrail.openManagedSession',
        focusManaged: 'turntrail.focusManagedSession',
        closeManaged: 'turntrail.closeManagedSession'
      };
      const command = commands[message?.type];
      if (!command) return;
      vscode.commands.executeCommand(command, {
        rowId: message.id,
        all: message.all,
        target: message.target,
        mode: message.mode,
        delivery: message.delivery,
        provider: message.provider,
        managedId: message.managedId
      });
    });
    view.onDidChangeVisibility(() => {
      if (view.visible && this.store.stale()) this.store.refresh().catch(() => {});
    });
    this.post(this.store.viewModel());
    this.store.refresh().catch(() => {});
  }

  post(model) {
    if (this.view?.visible !== false) this.view?.webview.postMessage({ type: 'state', model });
  }
}

function publicRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    surface: row.surface,
    sessionId: row.sessionId,
    title: row.title,
    latest: row.latest,
    modifiedAt: row.modifiedAt,
    cwd: row.cwd,
    size: row.size,
    matchesProject: row.matchesProject,
    imported: row.imported,
    importedAt: row.importedAt
  };
}

function publicManagedRow(row) {
  return {
    id: String(row?.id || ''),
    provider: String(row?.provider || ''),
    sessionId: row?.sessionId ? String(row.sessionId) : undefined,
    title: String(row?.title || 'Managed session'),
    accountLabel: row?.accountLabel ? String(row.accountLabel) : undefined,
    createdAt: row?.createdAt ? String(row.createdAt) : undefined
  };
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
  :root {
    --gap: 10px;
    --radius: 6px;
    --line: var(--vscode-panel-border, rgba(128,128,128,0.28));
    --dim: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 10px 10px 20px;
    color: var(--vscode-foreground);
    background: transparent;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  button, input, select { font: inherit; }
  .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
  .search, select {
    min-width: 0;
    height: 28px;
    padding: 3px 7px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }
  .search:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .scope { display: grid; grid-template-columns: 1fr 1fr; margin-top: 7px; }
  .scope button {
    height: 26px;
    color: var(--dim);
    background: transparent;
    border: 1px solid var(--line);
    border-right-width: 0;
  }
  .scope button:first-child { border-radius: 4px 0 0 4px; }
  .scope button:last-child { border-radius: 0 4px 4px 0; border-right-width: 1px; }
  .scope button[aria-pressed="true"] {
    color: var(--vscode-foreground);
    background: var(--vscode-list-inactiveSelectionBackground);
    border-color: var(--vscode-focusBorder);
  }
  .summary { display: flex; align-items: center; gap: 8px; min-height: 27px; margin-top: 7px; color: var(--dim); font-size: 0.84em; }
  .summary span:first-child { flex: 1; }
  .refresh {
    width: 26px; height: 24px; padding: 0;
    color: var(--vscode-icon-foreground); background: transparent;
    border: 1px solid transparent; border-radius: 4px; cursor: pointer;
  }
  .refresh:hover { background: var(--vscode-toolbar-hoverBackground); }
  .refresh:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .errors { margin: 0 0 9px; padding: 7px 8px; border-left: 2px solid var(--vscode-inputValidation-warningBorder); color: var(--dim); font-size: 0.82em; line-height: 1.4; }
  .managed { margin: 0 -10px 10px; padding: 8px 10px 9px; border-bottom: 1px solid var(--line); }
  .managed-head { display: flex; align-items: center; gap: 5px; }
  .managed-head strong { flex: 1; font-size: 0.86em; }
  .icon-command {
    width: 25px; height: 24px; padding: 0; cursor: pointer;
    color: var(--vscode-icon-foreground); background: transparent;
    border: 1px solid transparent; border-radius: 4px;
  }
  .icon-command:hover { background: var(--vscode-toolbar-hoverBackground); }
  .managed-list { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
  .managed-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 6px; min-height: 25px; }
  .managed-row .provider { width: 48px; }
  .managed-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82em; }
  .managed-empty { color: var(--dim); font-size: 0.78em; }
  .list { display: flex; flex-direction: column; gap: 7px; }
  .session {
    --accent: var(--vscode-foreground);
    padding: 9px 9px 8px;
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    background: var(--vscode-sideBar-background);
  }
  .session[data-provider="claude"] { --accent: #d97757; }
  .session[data-provider="codex"] { --accent: var(--vscode-foreground); }
  .session[data-provider="gemini"] { --accent: #4285f4; }
  .session[data-provider="cursor"] { --accent: #a970ff; }
  .session-head { display: flex; align-items: baseline; gap: 7px; }
  .provider { flex: none; color: var(--accent); font-size: 0.72em; font-weight: 700; text-transform: uppercase; }
  .badges { margin-left: auto; display: flex; gap: 4px; }
  .badge { padding: 1px 5px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); font-size: 0.7em; }
  .badge.imported { color: var(--vscode-charts-green); }
  .title { margin-top: 5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
  .latest { margin-top: 4px; color: var(--dim); font-size: 0.86em; line-height: 1.35; overflow-wrap: anywhere; }
  .meta { display: flex; flex-wrap: wrap; gap: 3px 9px; margin-top: 6px; color: var(--dim); font-size: 0.76em; }
  .folder { margin-top: 4px; color: var(--dim); font-size: 0.76em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .actions button, .handoff-controls button {
    min-height: 25px; padding: 3px 8px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  .actions button:hover, .handoff-controls button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions .primary, .handoff-controls .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .actions .primary:hover, .handoff-controls .primary:hover { background: var(--vscode-button-hoverBackground); }
  .handoff-controls { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  .choice { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: center; gap: 6px; margin-bottom: 6px; }
  .choice label { color: var(--dim); font-size: 0.78em; }
  .choice .segments { display: grid; grid-template-columns: 1fr 1fr; }
  .choice .segments button { border-radius: 0; border-right-width: 0; background: transparent; color: var(--dim); }
  .choice .segments button:first-child { border-radius: 4px 0 0 4px; }
  .choice .segments button:last-child { border-radius: 0 4px 4px 0; border-right-width: 1px; }
  .choice .segments button[aria-pressed="true"] { color: var(--vscode-foreground); background: var(--vscode-list-inactiveSelectionBackground); border-color: var(--vscode-focusBorder); }
  .handoff-controls > .primary { width: 100%; }
  .empty { padding: 18px 4px; color: var(--dim); text-align: center; line-height: 1.4; }
  .loading { opacity: 0.7; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="root"><div class="empty">Loading sessions...</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const saved = vscode.getState() || {};
let model = { sessions: [], managed: [], providers: [], all: false, loading: true, errors: [] };
let query = saved.query || '';
let provider = saved.provider || 'all';
let openHandoff = saved.openHandoff || '';
let target = saved.target || 'claude';
let mode = saved.mode || 'new';
let delivery = saved.delivery || 'clipboard';

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
  });
}
function ago(value) {
  const at = Date.parse(value || '');
  if (!isFinite(at)) return 'unknown time';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
}
function size(value) {
  if (!isFinite(value)) return '';
  if (value < 1024) return value + ' B';
  if (value < 1048576) return Math.round(value / 1024) + ' KB';
  return (value / 1048576).toFixed(1) + ' MB';
}
function label(value) {
  const found = (model.providers || []).find(function (item) { return item.id === value; });
  return found ? found.label : value;
}
function segments(name, values, selected) {
  return '<div class="segments">' + values.map(function (item) {
    return '<button data-choice="' + name + '" data-value="' + item.value + '" aria-pressed="' + (selected === item.value) + '">' + esc(item.label) + '</button>';
  }).join('') + '</div>';
}
function handoff(row) {
  if (openHandoff !== row.id) return '';
  return '<div class="handoff-controls">' +
    '<div class="choice"><label>Target</label>' + segments('target', [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }], target) + '</div>' +
    '<div class="choice"><label>Session</label>' + segments('mode', [{ value: 'new', label: 'New' }, { value: 'existing', label: 'Existing' }], mode) + '</div>' +
    '<div class="choice"><label>Send to</label>' + segments('delivery', [{ value: 'clipboard', label: 'Clipboard' }, { value: 'managed', label: 'Managed CLI' }], delivery) + '</div>' +
    '<button class="primary" data-act="create-handoff" data-id="' + esc(row.id) + '">Create handoff</button>' +
  '</div>';
}
function managedSessions() {
  const rows = model.managed || [];
  const list = rows.length ? '<div class="managed-list">' + rows.map(function (row) {
    return '<div class="managed-row"><span class="provider">' + esc(label(row.provider)) + '</span>' +
      '<span class="managed-title" title="' + esc(row.title + (row.accountLabel ? ' · ' + row.accountLabel : '')) + '">' +
        esc(row.title) + (row.accountLabel ? ' · ' + esc(row.accountLabel) : '') + '</span>' +
      '<button class="icon-command" data-act="focus-managed" data-managed-id="' + esc(row.id) + '" title="Focus managed terminal" aria-label="Focus managed terminal">&#x25B6;</button>' +
      '<button class="icon-command" data-act="close-managed" data-managed-id="' + esc(row.id) + '" title="Close managed terminal" aria-label="Close managed terminal">&#x2715;</button></div>';
  }).join('') + '</div>' : '<div class="managed-empty">No managed CLI sessions in this workspace.</div>';
  return '<section class="managed"><div class="managed-head"><strong>Managed CLI</strong>' +
    '<button class="icon-command" data-act="open-managed" title="Open managed CLI" aria-label="Open managed CLI">&#x2B;</button></div>' + list + '</section>';
}
function card(row) {
  const meta = [ago(row.modifiedAt), row.surface, size(row.size)].filter(Boolean);
  const action = row.imported
    ? '<button class="primary" data-act="view" data-id="' + esc(row.id) + '">View</button>' + (row.kind === 'native' ? '<button data-act="import" data-id="' + esc(row.id) + '">Reimport</button>' : '')
    : '<button class="primary" data-act="import" data-id="' + esc(row.id) + '">Import</button><button data-act="view" data-id="' + esc(row.id) + '">Import &amp; view</button>';
  const managedAction = (row.provider === 'claude' || row.provider === 'codex') && row.sessionId
    ? '<button data-act="open-managed" data-id="' + esc(row.id) + '" data-provider="' + esc(row.provider) + '">Open CLI</button>'
    : '';
  return '<article class="session" data-provider="' + esc(row.provider) + '">' +
    '<div class="session-head"><span class="provider">' + esc(label(row.provider)) + '</span><span class="badges">' +
      '<span class="badge">' + esc(row.kind) + '</span>' + (row.imported ? '<span class="badge imported">imported</span>' : '') +
    '</span></div>' +
    '<div class="title">' + esc(row.title || row.sessionId) + '</div>' +
    (row.latest && row.latest !== row.title ? '<div class="latest">' + esc(row.latest) + '</div>' : '') +
    '<div class="meta">' + meta.map(function (item) { return '<span>' + esc(item) + '</span>'; }).join('') + '</div>' +
    (row.cwd ? '<div class="folder" title="' + esc(row.cwd) + '">' + esc(row.cwd) + '</div>' : '') +
    '<div class="actions">' + action + managedAction + '<button data-act="handoff" data-id="' + esc(row.id) + '">Handoff</button></div>' +
    handoff(row) +
  '</article>';
}
function persist() {
  vscode.setState({ query: query, provider: provider, openHandoff: openHandoff, target: target, mode: mode, delivery: delivery });
}
function render() {
  const needle = query.trim().toLowerCase();
  const rows = (model.sessions || []).filter(function (row) {
    if (provider !== 'all' && row.provider !== provider) return false;
    if (!needle) return true;
    return [row.title, row.latest, row.cwd, row.sessionId, row.provider].some(function (value) {
      return String(value || '').toLowerCase().includes(needle);
    });
  });
  const providerOptions = ['<option value="all">All providers</option>'].concat((model.providers || []).map(function (item) {
    return '<option value="' + esc(item.id) + '"' + (provider === item.id ? ' selected' : '') + '>' + esc(item.label) + '</option>';
  })).join('');
  const errors = (model.errors || []).length ? '<div class="errors">' + model.errors.map(function (error) {
    return '<div><b>' + esc(label(error.provider)) + ':</b> ' + esc(error.message) + '</div>';
  }).join('') + '</div>' : '';
  root.className = model.loading ? 'loading' : '';
  root.innerHTML =
    managedSessions() +
    '<div class="toolbar"><input class="search" type="search" aria-label="Search sessions" placeholder="Search sessions" value="' + esc(query) + '">' +
      '<select aria-label="Filter provider">' + providerOptions + '</select></div>' +
    '<div class="scope"><button data-scope="false" aria-pressed="' + (!model.all) + '">Workspace</button><button data-scope="true" aria-pressed="' + model.all + '">Everywhere</button></div>' +
    '<div class="summary"><span>' + rows.length + ' of ' + (model.sessions || []).length + ' sessions' + (model.loading ? ' | scanning' : '') + '</span><button class="refresh" data-act="refresh" title="Refresh sessions" aria-label="Refresh sessions">&#x21bb;</button></div>' +
    errors +
    '<div class="list">' + (rows.length ? rows.map(card).join('') : '<div class="empty">No sessions match this view.</div>') + '</div>';
}

root.addEventListener('input', function (event) {
  if (event.target.matches('.search')) { query = event.target.value; persist(); render(); }
});
root.addEventListener('change', function (event) {
  if (event.target.matches('select')) { provider = event.target.value; persist(); render(); }
});
root.addEventListener('click', function (event) {
  const scope = event.target.closest('[data-scope]');
  if (scope) { vscode.postMessage({ type: 'scope', all: scope.dataset.scope === 'true' }); return; }
  const choice = event.target.closest('[data-choice]');
  if (choice) {
    if (choice.dataset.choice === 'target') target = choice.dataset.value;
    else if (choice.dataset.choice === 'mode') mode = choice.dataset.value;
    else delivery = choice.dataset.value;
    persist(); render(); return;
  }
  const button = event.target.closest('[data-act]');
  if (!button) return;
  if (button.dataset.act === 'refresh') { vscode.postMessage({ type: 'refresh' }); return; }
  if (button.dataset.act === 'handoff') {
    openHandoff = openHandoff === button.dataset.id ? '' : button.dataset.id;
    persist(); render(); return;
  }
  if (button.dataset.act === 'create-handoff') {
    vscode.postMessage({ type: 'handoff', id: button.dataset.id, target: target, mode: mode, delivery: delivery }); return;
  }
  if (button.dataset.act === 'open-managed') {
    vscode.postMessage({ type: 'openManaged', id: button.dataset.id, provider: button.dataset.provider }); return;
  }
  if (button.dataset.act === 'focus-managed' || button.dataset.act === 'close-managed') {
    vscode.postMessage({ type: button.dataset.act === 'focus-managed' ? 'focusManaged' : 'closeManaged', managedId: button.dataset.managedId }); return;
  }
  vscode.postMessage({ type: button.dataset.act, id: button.dataset.id });
});
window.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'state') { model = event.data.model; render(); }
});
render();
</script>
</body>
</html>`;
}

module.exports = { PROVIDERS, SessionsStore, SessionsWebview };
