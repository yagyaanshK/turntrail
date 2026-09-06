const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

let createdOptions;
let createdPanel;
const vscode = {
  ViewColumn: { Active: 1 },
  Uri: { parse: (value) => value },
  env: {
    clipboard: { writeText: async () => {} },
    openExternal: async () => {}
  },
  window: {
    createWebviewPanel(type, title, column, options) {
      createdOptions = options;
      createdPanel = {
        title,
        reveal() {},
        webview: {
          cspSource: 'mock:',
          html: '',
          onDidReceiveMessage() {},
          postMessage() {}
        },
        onDidChangeViewState() {},
        onDidDispose() {}
      };
      return createdPanel;
    },
    showOpenDialog: async () => undefined
  },
  workspace: { fs: { readFile: async () => new Uint8Array() } }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { LoginPanel } = require('../src/login-view.cjs');
Module._load = originalLoad;

test('the login webview is discarded while hidden and clears submitted secrets', async () => {
  const panel = new LoginPanel({}, async () => ({}), {});
  await panel.open({ provider: 'codex', label: 'Test' });
  assert.equal(createdOptions.retainContextWhenHidden, false);
  assert.match(createdPanel.webview.html, /input\.value = ''/);
  assert.match(createdPanel.webview.html, /clearSecrets\(\)/);
});

test('login operations are serialized and failed provisional accounts are rolled back', async () => {
  const removals = [];
  const panel = new LoginPanel(
    {},
    async () => ({ removeAccount: async (id, options) => removals.push({ id, options }) }),
    {}
  );
  panel.provider = 'codex';
  panel.target = { provider: 'codex', accountId: 'new-account', label: 'New' };
  panel.provisionalAccountId = 'new-account';

  let rejectOperation;
  const first = panel.runOperation(() => new Promise((resolve, reject) => { rejectOperation = reject; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => panel.runOperation(async () => {}), /already running/i);
  rejectOperation(new Error('sign-in failed'));
  await assert.rejects(() => first, /sign-in failed/i);

  assert.deepEqual(removals, [{ id: 'new-account', options: { purge: true, purgeLive: false } }]);
  assert.equal(panel.provisionalAccountId, undefined);
  assert.equal(panel.target.accountId, undefined);
});

test('cancelling a login aborts its work and rolls back the provisional account', async () => {
  const removals = [];
  const panel = new LoginPanel(
    {},
    async () => ({ removeAccount: async (id, options) => removals.push({ id, options }) }),
    {}
  );
  panel.provider = 'claude';
  panel.target = { provider: 'claude', accountId: 'pending', label: 'Pending' };
  panel.provisionalAccountId = 'pending';

  const running = panel.runOperation((signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  running.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  await panel.cancel();
  await assert.rejects(() => running, /cancelled/i);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].options.purgeLive, false);
});

test('importing Claude current login records it as already applied', async () => {
  const updates = [];
  const reloads = [];
  const panel = new LoginPanel(
    {},
    async () => ({
      ensureClaudeHome: async () => {},
      defaultClaudeHome: () => 'live-claude-home',
      importClaudeAuth: async () => ({ email: 'person@example.com' }),
      backfillClaudeProfile: async () => ({ email: 'person@example.com' }),
      updateAccount: async (id, patch) => updates.push({ id, patch })
    }),
    { reloadUsage: async (options) => reloads.push(options) }
  );
  panel.provider = 'claude';
  panel.target = { provider: 'claude', accountId: 'claude-1', label: 'Claude 1' };

  await panel.importClaudeCurrent(new AbortController().signal);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'claude-1');
  assert.ok(Number.isFinite(Date.parse(updates[0].patch.lastUsedAt)));
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].force, true);
});
