// The sessions panel's page script, run against a minimal stand-in for the
// DOM, so the behaviour that only exists inside the webview is still tested.
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
const { SessionsStore, SessionsWebview } = require('../src/sessions-view.cjs');
Module._load = originalLoad;

function pageScript() {
  let html;
  const webview = {
    cspSource: 'vscode-resource:',
    options: {},
    set html(value) { html = value; },
    get html() { return html; },
    onDidReceiveMessage() {},
    postMessage() {}
  };
  const store = new SessionsStore(async () => ({}), async () => '/workspace');
  store.refresh = async () => store.viewModel();
  new SessionsWebview(store).resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: false });
  const start = html.indexOf('<script nonce');
  return html.slice(html.indexOf('>', start) + 1, html.lastIndexOf('</script>'));
}

// Just enough page for the script: a root whose markup can be read back, a
// search box that can hold focus and a caret, and the message channel.
function page(state = {}) {
  const rootListeners = {};
  const windowListeners = {};
  const search = {
    classList: { contains: (name) => name === 'search' },
    selectionStart: 2,
    selectionEnd: 2,
    focused: 0,
    range: undefined,
    focus() { this.focused++; },
    setSelectionRange(start, end) { this.range = [start, end]; }
  };
  const root = {
    className: '',
    innerHTML: '',
    addEventListener(type, listener) { rootListeners[type] = listener; },
    querySelector(selector) { return selector === '.search' ? search : null; }
  };
  const document = { getElementById: () => root, activeElement: { classList: { contains: () => false } } };
  const context = vm.createContext({
    acquireVsCodeApi: () => ({ getState: () => state, setState() {}, postMessage() {} }),
    document,
    window: { addEventListener(type, listener) { windowListeners[type] = listener; } },
    console
  });
  new vm.Script(pageScript()).runInContext(context);
  return {
    root,
    search,
    document,
    state: (model) => windowListeners.message({ data: { type: 'state', model } }),
    type: (value) => rootListeners.input({ target: { matches: (selector) => selector === '.search', value } })
  };
}

const empty = (all) => ({ sessions: [], managed: [], providers: [], all, loading: false, errors: [] });

test('typing in the search box keeps focus and the caret through the re-render', () => {
  const view = page();
  view.state(empty(false));
  assert.equal(view.search.focused, 0, 'nothing is focused until the user types');

  view.document.activeElement = view.search;
  view.type('so');
  assert.equal(view.search.focused, 1);
  assert.deepEqual(view.search.range, [2, 2]);

  // A scan finishing while the user types must not steal focus either.
  view.state(empty(false));
  assert.equal(view.search.focused, 2);
});

test('an empty list says where the sessions are instead of that nothing matches', () => {
  const view = page();
  view.state(empty(false));
  assert.match(view.root.innerHTML, /No sessions were started in this workspace folder\. Chats started in other folders are under Everywhere\./);

  view.state(empty(true));
  assert.match(view.root.innerHTML, /No sessions were found on this machine\./);

  view.type('sor');
  assert.match(view.root.innerHTML, /No sessions match this search\./);
});
