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
const { AccountsWebview } = require('../src/accounts-view.cjs');
Module._load = originalLoad;

function fakeStore(model) {
  return {
    onDidChange() {},
    viewModel: async () => model,
    reloadUsage: async () => {},
    refresh: async () => {}
  };
}

function fakeView() {
  const posted = [];
  let onMessage;
  const view = {
    visible: true,
    webview: {
      cspSource: 'vscode-resource:',
      options: {},
      html: '',
      onDidReceiveMessage(listener) { onMessage = listener; },
      postMessage(message) { posted.push(message); }
    },
    onDidChangeVisibility() {}
  };
  return { view, posted, message: (payload) => onMessage(payload) };
}

test('the accounts panel is told the maintenance state so it can show the switch', async () => {
  let enabled = false;
  const panel = new AccountsWebview(fakeStore({ sections: [] }), {
    maintenance: () => ({ enabled, intervalHours: 5 })
  });
  const { view, posted } = fakeView();
  await panel.resolveWebviewView(view);
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
