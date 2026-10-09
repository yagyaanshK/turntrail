// The webviews' inline page scripts must parse.
//
// `node --check` cannot see this. Both panels build their HTML with a template
// literal, so an escape written for the inner script - a `\'` inside a
// single-quoted JS string - is consumed by the *outer* literal. The .cjs file
// stays valid, the extension loads without complaint, and the panel renders
// blank because its script died at parse time.
//
// So: render each page the way VS Code would, pull the script back out, and
// hand it to the parser.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Module = require('module');

// Enough of the VS Code API for the view constructors to run.
const stubVscode = {
  EventEmitter: class {
    constructor() {
      this.event = () => {};
    }
    fire() {}
  },
  window: {},
  Uri: { parse: (value) => value },
  commands: { executeCommand: () => {} },
  ViewColumn: { Active: 1 }
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return stubVscode;
  return load.call(this, request, ...rest);
};

// fileURLToPath, not .pathname: this repo's path contains spaces and
// parentheses, which arrive percent-encoded from a URL.
const src = fileURLToPath(new URL('../packages/vscode/src/', import.meta.url));
const { AccountsStore, AccountsWebview } = require(src + 'accounts-view.cjs');
const { SessionsStore, SessionsWebview } = require(src + 'sessions-view.cjs');
const { LoginPanel } = require(src + 'login-view.cjs');
const { UsageStore, UsageWebview } = require(src + 'usage-view.cjs');

function capture(assign) {
  let html;
  const webview = {
    cspSource: 'vscode-resource:',
    options: {},
    set html(value) {
      html = value;
    },
    get html() {
      return html;
    },
    onDidReceiveMessage() {},
    postMessage() {}
  };
  assign(webview);
  return html;
}

const pages = {
  accounts: capture((webview) => {
    const store = new AccountsStore(async () => ({}));
    store.viewModel = async () => ({ sections: [] });
    new AccountsWebview(store).resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: false });
  }),
  usage: capture((webview) => {
    const store = new UsageStore(async () => ({}));
    store.refresh = async () => {};
    new UsageWebview(store).resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: false });
  }),
  sessions: capture((webview) => {
    const store = new SessionsStore(async () => ({}), async () => '/workspace');
    store.refresh = async () => store.viewModel();
    new SessionsWebview(store).resolveWebviewView({ webview, onDidChangeVisibility() {}, visible: false });
  })
};

for (const provider of ['codex', 'claude']) {
  pages[`login/${provider}`] = capture((webview) => {
    stubVscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, reveal() {}, title: '' });
    new LoginPanel({}, async () => ({}), { reloadUsage: async () => {} }).open({ provider, label: 'T' });
  });
}

let failed = 0;
for (const [name, html] of Object.entries(pages)) {
  const start = html.indexOf('<script nonce');
  if (start < 0) {
    failed++;
    console.error(`Webview ${name}: no inline script found`);
    continue;
  }
  const body = html.slice(html.indexOf('>', start) + 1, html.lastIndexOf('</script>'));
  try {
    new vm.Script(body);
  } catch (error) {
    failed++;
    console.error(`Webview ${name}: emitted page script does not parse - ${error.message}`);
    const line = Number((error.stack.match(/evalmachine[^:]*:(\d+)/) || [])[1]);
    if (line) console.error('  ' + String(body.split('\n')[line - 1]).trim());
  }
}

if (failed > 0) {
  console.error(`\n${failed} webview page script(s) would fail to load.`);
  process.exit(1);
}
