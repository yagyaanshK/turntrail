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
  commands: { executeCommand: async (...args) => executed.push(args) }
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { SessionsStore, SessionsWebview } = require('../src/sessions-view.cjs');
Module._load = originalLoad;

test('sessions store keeps native paths out of the webview model and resolves opaque ids', async () => {
  const source = {
    id: 'native:codex:abc',
    kind: 'native',
    provider: 'codex',
    sessionId: 'native-one',
    path: 'C:\\secret\\session.jsonl',
    native: { path: 'C:\\secret\\session.jsonl' },
    title: 'Build it',
    imported: false
  };
  const store = new SessionsStore(
    async () => ({ listSessionIndex: async () => ({ sessions: [source], errors: [] }) }),
    async () => 'C:\\repo'
  );
  await store.refresh();
  assert.equal(store.resolve(source.id).path, source.path);
  assert.equal(store.viewModel().sessions[0].path, undefined);
  assert.equal(store.viewModel().sessions[0].native, undefined);

  store.markImported(source.id, { id: 'ledger-one' });
  assert.equal(store.resolve(source.id).imported, true);
  assert.equal(store.resolve(source.id).ledgerSessionId, 'ledger-one');
});

test('sessions store passes managed account locations and exposes only the account label', async () => {
  let receivedOptions;
  const store = new SessionsStore(
    async () => ({
      listSessionIndex: async (_root, options) => {
        receivedOptions = options;
        return { sessions: [], errors: [] };
      }
    }),
    async () => 'C:\\repo',
    { discoveryOptions: async () => ({ codex: { additionalLocations: [{ sessionsDir: 'managed' }] } }) }
  );
  store.setManaged([{
    id: 'managed-1',
    provider: 'codex',
    title: 'Feature',
    accountId: 'private-account-id',
    accountLabel: 'Primary'
  }]);
  await store.refresh();

  assert.equal(receivedOptions.discoveryOptions.codex.additionalLocations[0].sessionsDir, 'managed');
  assert.equal(store.viewModel().managed[0].accountLabel, 'Primary');
  assert.equal(store.viewModel().managed[0].accountId, undefined);
});

test('sessions webview has CSP, filters, and maps row actions to opaque commands', async () => {
  const store = new SessionsStore(async () => ({ listSessionIndex: async () => ({ sessions: [], errors: [] }) }), async () => 'C:\\repo');
  let receiver;
  const view = {
    visible: true,
    onDidChangeVisibility() {},
    webview: {
      cspSource: 'mock:',
      options: {},
      html: '',
      onDidReceiveMessage(handler) { receiver = handler; },
      postMessage() {}
    }
  };
  const webview = new SessionsWebview(store);
  await webview.resolveWebviewView(view);
  assert.equal(view.webview.options.enableScripts, true);
  assert.match(view.webview.html, /default-src 'none'/);
  assert.match(view.webview.html, /Search sessions/);
  assert.match(view.webview.html, /All providers/);
  assert.match(view.webview.html, /Import &amp; view/);
  assert.match(view.webview.html, /Managed CLI/);
  assert.match(view.webview.html, /Clipboard/);

  receiver({ type: 'handoff', id: 'native:codex:abc', target: 'claude', mode: 'new', delivery: 'managed' });
  assert.deepEqual(executed.at(-1), ['turntrail.handoffIndexedSession', {
    rowId: 'native:codex:abc',
    all: undefined,
    target: 'claude',
    mode: 'new',
    delivery: 'managed',
    provider: undefined,
    managedId: undefined
  }]);

  receiver({ type: 'openManaged', id: 'native:codex:abc', provider: 'codex' });
  assert.equal(executed.at(-1)[0], 'turntrail.openManagedSession');
});
