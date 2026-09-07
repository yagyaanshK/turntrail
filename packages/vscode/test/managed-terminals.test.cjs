const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const fixtureRoot = path.resolve('managed-terminal-fixture');
const executableName = (provider) => process.platform === 'win32' ? `${provider}.exe` : provider;
const fixtureExecutable = (provider) => path.join(path.parse(fixtureRoot).root, 'bin', executableName(provider));

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() {}
}

const vscode = { EventEmitter, window: {} };
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const {
  MARKER,
  ManagedTerminalStore,
  managedAccount,
  matchesProviderLaunch,
  managedTerminalArgs,
  resolveProviderLaunch
} = require('../src/managed-terminals.cjs');
Module._load = originalLoad;

function fakeWindow() {
  const opened = new EventEmitter();
  const closed = new EventEmitter();
  const created = [];
  return {
    terminals: [],
    created,
    onDidOpenTerminal: opened.event,
    onDidCloseTerminal: closed.event,
    createTerminal(options) {
      const terminal = {
        creationOptions: options,
        exitStatus: undefined,
        sent: [],
        shown: 0,
        disposed: false,
        show() { this.shown++; },
        sendText(text, newline) { this.sent.push([text, newline]); },
        dispose() { this.disposed = true; closed.fire(this); }
      };
      created.push(terminal);
      opened.fire(terminal);
      return terminal;
    }
  };
}

test('provider resume commands keep the complete handoff prompt in one argument', () => {
  const prompt = 'Read `C:\\repo & remove-all`\nthen continue';
  assert.deepEqual(managedTerminalArgs('claude', { sessionId: 'claude-id', prompt }), [
    '--resume', 'claude-id', prompt
  ]);
  assert.deepEqual(managedTerminalArgs('codex', { sessionId: 'codex-id', prompt }), [
    'resume', 'codex-id', prompt
  ]);
  assert.deepEqual(managedTerminalArgs('codex', { prompt }), [prompt]);
});

test('Windows launch respects PATH order and never constructs a shell command', async () => {
  const prompt = '$(unsafe) & still one argument';
  const launch = await resolveProviderLaunch('codex', [prompt], {
    platform: 'win32',
    candidates: ['C:\\npm\\codex.cmd', 'C:\\extension\\codex.exe'],
    existsSync: (candidate) => candidate === 'C:\\npm\\codex.ps1'
  });
  assert.equal(launch.command, 'powershell.exe');
  assert.deepEqual(launch.args.slice(-2), ['C:\\npm\\codex.ps1', prompt]);
});

test('managed terminals launch direct agent processes and inject only while live', async () => {
  const window = fakeWindow();
  const store = new ManagedTerminalStore({
    window,
    resolveLaunch: async (provider, args) => ({ command: fixtureExecutable(provider), args })
  });
  const context = { subscriptions: [] };
  store.start(context);

  const prompt = 'Continue from C:\\repo';
  const record = await store.launch({
    provider: 'claude',
    root: fixtureRoot,
    sessionId: 'session-1',
    title: 'Feature',
    prompt,
    accountId: 'claude-primary',
    accountLabel: 'Primary',
    accountEnv: { CLAUDE_CONFIG_DIR: path.join(fixtureRoot, 'claude-home') }
  });
  const terminal = window.created[0];
  assert.equal(terminal.creationOptions.shellPath, fixtureExecutable('claude'));
  assert.deepEqual(terminal.creationOptions.shellArgs, ['--resume', 'session-1', prompt]);
  assert.equal(terminal.creationOptions.env[MARKER], '1');
  assert.equal(terminal.creationOptions.env.CLAUDE_CONFIG_DIR, path.join(fixtureRoot, 'claude-home'));
  assert.equal(terminal.creationOptions.env.TURNTRAIL_MANAGED_ACCOUNT_ID, 'claude-primary');
  assert.match(terminal.creationOptions.name, /Primary$/);
  assert.equal(terminal.shown, 1);
  assert.equal(store.viewModel(fixtureRoot)[0].id, record.id);
  assert.equal(store.viewModel(fixtureRoot)[0].accountLabel, 'Primary');

  store.inject(record.id, 'second handoff');
  assert.deepEqual(terminal.sent, [['second handoff', true]]);
  terminal.exitStatus = { code: 0 };
  assert.throws(() => store.inject(record.id, 'late handoff'), /has exited/i);
  assert.deepEqual(terminal.sent, [['second handoff', true]]);
});

test('only valid live Turntrail terminal markers are reattached', () => {
  const window = fakeWindow();
  const id = '12345678-1234-1234-1234-123456789abc';
  const valid = {
    exitStatus: undefined,
    creationOptions: { shellPath: fixtureExecutable('codex'), shellArgs: [], env: {
      [MARKER]: '1',
      TURNTRAIL_MANAGED_ID: id,
      TURNTRAIL_MANAGED_PROVIDER: 'codex',
      TURNTRAIL_MANAGED_ROOT: fixtureRoot,
      TURNTRAIL_MANAGED_SESSION_ID: 'session-2',
      TURNTRAIL_MANAGED_TITLE: 'Restored'
    } }
  };
  const foreign = { exitStatus: undefined, creationOptions: { env: { [MARKER]: '0' } } };
  const spoofed = { exitStatus: undefined, creationOptions: { shellPath: 'powershell.exe', shellArgs: [], env: {
    ...valid.creationOptions.env,
    TURNTRAIL_MANAGED_ID: '32345678-1234-1234-1234-123456789abc'
  } } };
  const malformed = { exitStatus: undefined, creationOptions: {
    shellPath: fixtureExecutable('codex'),
    shellArgs: [],
    env: {
      ...valid.creationOptions.env,
      TURNTRAIL_MANAGED_ID: '22345678-1234-1234-1234-123456789abc',
      TURNTRAIL_MANAGED_SESSION_ID: 'bad\nsession'
    }
  } };
  window.terminals.push(valid, foreign, malformed, spoofed);
  const store = new ManagedTerminalStore({ window });
  store.start({ subscriptions: [] });
  assert.equal(store.get(id).title, 'Restored');
  assert.equal(store.records.size, 1);
});

test('managed terminal input is bounded and provider-limited', async () => {
  assert.throws(() => managedTerminalArgs('cursor'), /only Claude and Codex/i);
  assert.throws(() => managedTerminalArgs('claude', { prompt: 'x'.repeat(16 * 1024 + 1) }), /too long/i);
  assert.throws(() => managedTerminalArgs('claude', { sessionId: 'id\n--dangerously-skip-permissions' }), /Invalid session id/i);
  assert.throws(() => managedAccount('codex', {
    accountId: '../escape', accountEnv: { CODEX_HOME: fixtureRoot }
  }), /account id/i);
  assert.throws(() => managedAccount('codex', {
    accountId: 'primary', accountEnv: { CLAUDE_CONFIG_DIR: fixtureRoot }
  }), /only CODEX_HOME/i);
  assert.throws(() => managedAccount('claude', {
    accountId: 'primary', accountEnv: { CLAUDE_CONFIG_DIR: 'relative-home' }
  }), /absolute path/i);
});

test('restored terminals must still have the expected direct provider launch', () => {
  assert.equal(matchesProviderLaunch({ shellPath: fixtureExecutable('claude'), shellArgs: [] }, 'claude'), true);
  assert.equal(matchesProviderLaunch({ shellPath: '/usr/local/bin/claude', shellArgs: [] }, 'claude', 'linux'), true);
  assert.equal(matchesProviderLaunch({ shellPath: 'C:\\bin\\claude.exe', shellArgs: [] }, 'claude', 'win32'), true);
  assert.equal(matchesProviderLaunch({
    shellPath: 'powershell.exe',
    shellArgs: ['-NoProfile', '-File', 'C:\\npm\\codex.ps1']
  }, 'codex', 'win32'), true);
  assert.equal(matchesProviderLaunch({ shellPath: 'codex', shellArgs: [] }, 'codex', 'win32'), false);
  assert.equal(matchesProviderLaunch({ shellPath: 'powershell.exe', shellArgs: [] }, 'codex'), false);
  assert.equal(matchesProviderLaunch({ shellPath: fixtureExecutable('codex'), shellArgs: [] }, 'claude'), false);
});

test('untrusted transcript titles cannot inject terminal control characters', async () => {
  const window = fakeWindow();
  const store = new ManagedTerminalStore({
    window,
    resolveLaunch: async (provider, args) => ({ command: provider, args })
  });
  const record = await store.launch({
    provider: 'codex', root: fixtureRoot, title: 'Feature\u001b]0;spoofed\u0007\nwork'
  });
  assert.equal(record.title.includes('\u001b'), false);
  assert.equal(record.title.includes('\n'), false);
  assert.equal(window.created[0].creationOptions.name.includes('\u001b'), false);
});
