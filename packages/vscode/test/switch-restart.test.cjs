const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  consumeSwitchResults,
  createSwitchRequest,
  editorEnvironment,
  editorRelaunch,
  nodeWorkerEnvironment,
  resultPathForRequest,
  startSwitchHelper
} = require('../src/switch-restart.cjs');
const {
  main,
  relaunchEditor,
  validateRequest,
  waitForProviderStop,
  writeResult
} = require('../src/switch-helper.cjs');

async function tempDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-switch-'));
}

test('queued switch requests contain no credentials and prevent duplicate provider work', async () => {
  const directory = await tempDirectory();
  const queued = await createSwitchRequest(directory, {
    provider: 'codex',
    accountId: 'account-1',
    accountLabel: 'Work',
    editorHostPid: 42,
    relaunch: { executable: path.resolve('Code.exe'), args: ['--new-window', path.resolve('repo')] },
    blockers: [{ pid: 7, name: 'codex.exe', kind: 'ide-background', editor: 'VS Code' }]
  }, { id: 'request-1', now: () => 1000 });

  const text = await fs.readFile(queued.requestPath, 'utf8');
  const request = JSON.parse(text);
  assert.equal(request.provider, 'codex');
  assert.equal(request.accountId, 'account-1');
  assert.deepEqual(request.blockers, [
    { pid: 7, name: 'codex.exe', kind: 'ide-background', editor: 'VS Code' }
  ]);
  assert.doesNotMatch(text, /access.?token|refresh.?token|api.?key/i);

  await assert.rejects(
    createSwitchRequest(directory, { provider: 'codex', accountId: 'account-2' }, { now: () => 2000 }),
    /already waiting/i
  );
  await assert.doesNotReject(
    createSwitchRequest(directory, { provider: 'claude', accountId: 'account-2' }, { now: () => 2000 })
  );
});

test('expired requests do not permanently block another switch', async () => {
  const directory = await tempDirectory();
  await createSwitchRequest(
    directory,
    { provider: 'codex', accountId: 'old', timeoutMs: 30_000 },
    { id: 'old-request', now: () => 1000 }
  );
  const queued = await createSwitchRequest(
    directory,
    { provider: 'codex', accountId: 'new' },
    { id: 'new-request', now: () => 31_001 }
  );
  assert.equal((await fs.readdir(directory)).includes('old-request.request.json'), false);
  assert.equal((await fs.readFile(queued.requestPath, 'utf8')).includes('"accountId": "new"'), true);
});

test('the detached helper uses the editor runtime as Node without leaking editor IPC', async () => {
  let call;
  let unref = false;
  const child = new EventEmitter();
  child.pid = 99;
  child.unref = () => { unref = true; };
  const started = startSwitchHelper({
    editorExecutable: path.resolve('Code.exe'),
    helperPath: path.resolve('switch-helper.cjs'),
    requestPath: path.resolve('request.json'),
    env: { VSCODE_IPC_HOOK: 'private', KEEP: 'yes' },
    spawnImpl(command, args, options) {
      call = { command, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  const pid = await started;
  assert.equal(pid, 99);
  assert.equal(unref, true);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(call.options.env.VSCODE_IPC_HOOK, undefined);

  assert.deepEqual(editorEnvironment(nodeWorkerEnvironment({ VSCODE_IPC_HOOK: 'private', KEEP: 'yes' })), {
    KEEP: 'yes'
  });
});

test('editor relaunch arguments preserve the workspace without using a shell', async () => {
  const executable = path.resolve('Code.exe');
  const folder = path.resolve('repo');
  assert.deepEqual(editorRelaunch({ execPath: executable }, { folder }), {
    executable,
    args: ['--new-window', folder],
    cwd: folder
  });

  let call;
  const child = new EventEmitter();
  child.pid = 88;
  child.unref = () => {};
  const launched = relaunchEditor(
    { executable, args: ['--new-window', folder], cwd: folder },
    (command, args, options) => {
      call = { command, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  );
  assert.equal(await launched, 88);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
});

test('the worker waits for consecutive quiet polls before switching', async () => {
  const samples = [[{ pid: 1, name: 'codex.exe' }], [], [], []];
  let reads = 0;
  const core = {
    async listAgentProcesses() {
      reads++;
      return samples.shift() || [];
    },
    async unguardedAgentProcesses(_provider, processes) {
      return processes;
    }
  };
  await waitForProviderStop('codex', new Date(Date.now() + 60_000).toISOString(), core, {
    quietPolls: 3,
    pollMs: 0,
    sleep: async () => {}
  });
  assert.equal(reads, 4);
});

test('the worker validates the account, waits, switches, records success, and removes its request', async () => {
  const directory = await tempDirectory();
  const queued = await createSwitchRequest(directory, {
    provider: 'codex',
    accountId: 'account-1',
    accountLabel: 'Work',
    editorHostPid: 42,
    relaunch: { executable: path.resolve('Code.exe'), args: ['--new-window'] }
  });
  let activated;
  let relaunched;
  const core = {
    async getAccount(id) {
      return { id, provider: 'codex' };
    },
    async listAgentProcesses() {
      return [];
    },
    async unguardedAgentProcesses() {
      return [];
    },
    async activateCodexAccount(id) {
      activated = id;
      return { target: path.resolve('auth.json') };
    }
  };
  const result = await main(queued.requestPath, {
    core,
    waitOptions: { quietPolls: 1 },
    isProcessRunning: () => false,
    relaunchEditor: async (value) => { relaunched = value; }
  });

  assert.equal(result.success, true);
  assert.equal(activated, 'account-1');
  assert.equal(relaunched.executable, path.resolve('Code.exe'));
  await assert.rejects(fs.access(queued.requestPath), { code: 'ENOENT' });
  const saved = JSON.parse(await fs.readFile(queued.resultPath, 'utf8'));
  assert.equal(saved.success, true);
  assert.equal(saved.accountLabel, 'Work');
});

test('an editor relaunch failure does not misreport or roll back a completed switch', async () => {
  const directory = await tempDirectory();
  const queued = await createSwitchRequest(directory, {
    provider: 'codex',
    accountId: 'account-1',
    editorHostPid: 42,
    relaunch: { executable: path.resolve('Code.exe') }
  });
  const core = {
    async getAccount(id) { return { id, provider: 'codex' }; },
    async listAgentProcesses() { return []; },
    async unguardedAgentProcesses() { return []; },
    async activateCodexAccount() { return { target: path.resolve('auth.json') }; }
  };
  const result = await main(queued.requestPath, {
    core,
    waitOptions: { quietPolls: 1 },
    isProcessRunning: () => false,
    relaunchEditor: async () => { throw new Error('editor missing'); }
  });
  assert.equal(result.success, true);
  assert.equal(result.relaunchError, 'editor missing');
  assert.equal(JSON.parse(await fs.readFile(queued.resultPath, 'utf8')).success, true);
});

test('the worker times out with the process that remains active', async () => {
  let now = 0;
  const core = {
    async listAgentProcesses() {
      now += 1000;
      return [{ pid: 7, name: 'codex.exe' }];
    },
    async unguardedAgentProcesses(_provider, processes) {
      return processes;
    }
  };
  await assert.rejects(
    waitForProviderStop('codex', new Date(2500).toISOString(), core, {
      now: () => now,
      pollMs: 0,
      sleep: async () => {}
    }),
    /codex\.exe \(PID 7\)/i
  );
});

test('switch results are consumed once and malformed result files are discarded', async () => {
  const directory = await tempDirectory();
  const requestPath = path.join(directory, 'one.request.json');
  const resultPath = resultPathForRequest(requestPath);
  await writeResult(resultPath, {
    schemaVersion: 1,
    success: true,
    completedAt: '2026-09-01T00:00:00.000Z'
  });
  await fs.writeFile(path.join(directory, 'bad.result.json'), 'not-json', 'utf8');

  const results = await consumeSwitchResults(directory);
  assert.equal(results.length, 1);
  assert.equal(results[0].success, true);
  assert.equal((await fs.readdir(directory)).includes('bad.result.json'), false);
  assert.deepEqual(await consumeSwitchResults(directory), []);
});

test('queued request validation rejects unsafe account ids and providers', () => {
  assert.throws(() => validateRequest({ schemaVersion: 1, provider: 'codex', accountId: '../escape' }), /account id/i);
  assert.throws(() => validateRequest({ schemaVersion: 1, provider: 'other', accountId: 'safe' }), /provider/i);
});
