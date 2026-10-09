const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const executed = [];
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => this.listeners.push(listener);
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
}
const vscode = {
  EventEmitter,
  Uri: { parse: (value) => value },
  commands: { executeCommand: async (...args) => executed.push(args) }
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { AccountsStore, AccountsWebview } = require('../src/accounts-view.cjs');
Module._load = originalLoad;

function fakeStore(model) {
  return {
    onDidChange() {},
    viewModel: async () => model,
    reloadUsage: async () => {},
    reloadStaleUsage: async () => {},
    refresh: async () => {}
  };
}

function fakeView() {
  const posted = [];
  let onMessage;
  let onVisibility;
  const view = {
    visible: true,
    webview: {
      cspSource: 'vscode-resource:',
      options: {},
      html: '',
      onDidReceiveMessage(listener) { onMessage = listener; },
      postMessage(message) { posted.push(message); }
    },
    onDidChangeVisibility(listener) { onVisibility = listener; }
  };
  return {
    view,
    posted,
    message: (payload) => onMessage(payload),
    visibility: () => onVisibility()
  };
}

test('opening the accounts view refreshes only stale accounts once', async () => {
  const calls = [];
  const model = {
    sections: [{
      id: 'codex',
      rows: [
        { id: 'old', provider: 'codex', health: { id: 'usage-stale' } },
        { id: 'fresh', provider: 'codex', health: { id: 'healthy' } }
      ]
    }]
  };
  const store = fakeStore(model);
  store.reloadStaleUsage = async () => calls.push('refresh');
  const panel = new AccountsWebview(store);
  const { view, visibility } = fakeView();

  await panel.resolveWebviewView(view);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['refresh']);

  visibility();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['refresh'], 'the same visible period is refreshed only once');

  view.visible = false;
  visibility();
  view.visible = true;
  visibility();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['refresh', 'refresh']);
});

test('the accounts panel is told the maintenance state so it can show the switch', async () => {
  let enabled = false;
  const panel = new AccountsWebview(fakeStore({ sections: [] }), {
    maintenance: () => ({ enabled, intervalHours: 5 })
  });
  const { view, posted } = fakeView();
  await panel.resolveWebviewView(view);
  assert.match(view.webview.html, /Account readiness/);
  assert.match(view.webview.html, /Suggested:/);
  assert.doesNotMatch(view.webview.html, /pooled\.total/);
  assert.match(view.webview.html, /limit\.description \|\| 'Separate allowance'/);
  assert.match(view.webview.html, /authenticationFailure/);
  assert.match(view.webview.html, /Sign in again/);
  assert.match(view.webview.html, /USAGE_PERMISSION_DENIED/);
  assert.deepEqual(posted.at(-1).model.maintenance, { enabled: false, intervalHours: 5 });

  enabled = true;
  await panel.refresh();
  assert.deepEqual(posted.at(-1).model.maintenance, { enabled: true, intervalHours: 5 });
  assert.deepEqual(posted.at(-1).model.sections, []);
});

test('a panel without a maintenance reporter, or with a failing one, still renders', async () => {
  const plain = new AccountsWebview(fakeStore({ sections: [] }));
  const first = fakeView();
  await plain.resolveWebviewView(first.view);
  assert.equal(first.posted.at(-1).model.maintenance, undefined);

  const failing = new AccountsWebview(fakeStore({ sections: [] }), {
    maintenance: () => { throw new Error('no configuration'); }
  });
  const second = fakeView();
  await failing.resolveWebviewView(second.view);
  assert.equal(second.posted.at(-1).model.maintenance, undefined);
});

test('the maintenance buttons run the toggle and run-now commands', async () => {
  const panel = new AccountsWebview(fakeStore({ sections: [] }), { maintenance: () => ({ enabled: false }) });
  const { view, message } = fakeView();
  await panel.resolveWebviewView(view);
  executed.length = 0;

  message({ type: 'toggleMaintenance' });
  message({ type: 'runMaintenance' });
  assert.deepEqual(executed.map((call) => call[0]), [
    'turntrail.toggleAccountMaintenance',
    'turntrail.runAccountMaintenance'
  ]);
});

test('the Claude section reports whether Claude Code is set to keep chats', async () => {
  const retention = { days: 30, source: 'default', userDays: undefined, settingsState: 'ok', settingsPath: 'C:\private\settings.json' };
  const store = new AccountsStore(async () => ({ readClaudeRetention: async () => retention }));
  // Only what the card needs reaches the webview, not where the file lives.
  assert.deepEqual(await store.claudeRetention(), { days: 30, source: 'default', settingsState: 'ok' });

  const failing = new AccountsStore(async () => ({ readClaudeRetention: async () => { throw new Error('unreadable'); } }));
  assert.equal(await failing.claudeRetention(), undefined);
  const older = new AccountsStore(async () => ({}));
  assert.equal(await older.claudeRetention(), undefined);
});

test('the keep-chats button runs its command', async () => {
  const panel = new AccountsWebview(fakeStore({ sections: [] }));
  const { view, message } = fakeView();
  await panel.resolveWebviewView(view);
  executed.length = 0;
  message({ type: 'keepClaudeChats' });
  assert.deepEqual(executed.map((call) => call[0]), ['turntrail.keepClaudeChats']);
});

test('a rebuilt Accounts page that missed the first state asks for it and gets it', async () => {
  // Reproduces the panel stuck on "Loading subscriptions…": the view is
  // resolved while not yet visible, so the first state goes nowhere, and only
  // the page's "ready" brings the data.
  const panel = new AccountsWebview(fakeStore({ sections: [{ id: 'codex', rows: [] }] }));
  const { view, posted, message } = fakeView();
  view.visible = false;
  await panel.resolveWebviewView(view);
  assert.equal(posted.length, 0, 'nothing could be delivered yet');

  message({ type: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'state');
  assert.deepEqual(posted[0].model.sections, [{ id: 'codex', rows: [] }]);
});

test('the Accounts page script announces itself once its listener exists', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'accounts-view.cjs'), 'utf8');
  const listener = source.indexOf("window.addEventListener('message'");
  const ready = source.indexOf("vscode.postMessage({ type: 'ready' })");
  assert.ok(listener > 0 && ready > listener, 'ready is sent after the message listener is registered');
});
