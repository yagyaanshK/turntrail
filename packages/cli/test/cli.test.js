import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli, spawnInteractive } from '../src/cli.js';

test('cli init and status write expected output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-cli-'));
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };

  await runCli(['init', '--cwd', root], io);
  assert.match(output, /Initialized Turntrail/);
  await fs.access(path.join(root, '.turntrail', 'manifest.json'));

  output = '';
  await runCli(['status', '--cwd', root], io);
  assert.match(output, /Sessions: 0/);
});

test('cli export dry-run reports a plan without writing an export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-cli-dry-run-'));
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };
  await runCli(['init', '--cwd', root], io);
  output = '';
  await runCli(['export', '--to', 'claude', '--dry-run', '--max-tokens', '1000', '--cwd', root], io);
  assert.match(output, /no files written/);
  assert.match(output, /Estimated final size: ~\d+ tokens/);
  assert.deepEqual(await fs.readdir(path.join(root, '.turntrail', 'exports')), []);
});

test('cli export writes a handoff and reports its planning metrics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-cli-export-'));
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };
  await runCli(['init', '--cwd', root], io);
  output = '';
  await runCli(['export', '--to', 'claude', '--max-tokens', '1000', '--cwd', root], io);
  assert.match(output, /Wrote handoff to exports\//);
  assert.match(output, /Estimated final size: ~\d+ tokens/);
  assert.match(output, /Reversible attachments stored: 0/);
  assert.equal((await fs.readdir(path.join(root, '.turntrail', 'exports'))).length, 1);
});

test('account maintain renders scheduler-friendly results', async () => {
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };
  await runCli(['account', 'maintain'], io, {
    maintainAccounts: async () => ({
      locked: false,
      results: [{ accountId: 'work', provider: 'codex', status: 'checked' }]
    })
  });
  assert.match(output, /codex\/work: checked/);
});

test('account maintain can emit JSON for OS schedulers', async () => {
  let output = '';
  const io = { stdout: { write: (chunk) => { output += chunk; } } };
  await runCli(['account', 'maintain', '--json'], io, {
    maintainAccounts: async () => ({ locked: true, results: [] })
  });
  assert.deepEqual(JSON.parse(output), { locked: true, results: [] });
});

function fakeChild(exitCode, signal) {
  const child = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => child.emit('exit', exitCode, signal));
  return child;
}

test('interactive native arguments are spawned directly without a shell', async () => {
  let invocation;
  const args = ['--prompt', 'literal && echo unsafe', 'name with spaces'];
  const exitCode = await spawnInteractive('codex', args, process.cwd(), {
    platform: 'linux',
    parentProcess: new EventEmitter(),
    spawn(command, passedArgs, options) {
      invocation = { command, args: passedArgs, options };
      return fakeChild(0, null);
    }
  });
  assert.equal(exitCode, 0);
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, args);
  assert.equal(invocation.options.shell, false);
});

test('Windows command shims use a sibling PowerShell script with an argument array', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-cli-shim-'));
  const cmd = path.join(root, 'codex.cmd');
  const ps1 = path.join(root, 'codex.ps1');
  await fs.writeFile(cmd, '@echo off\n', 'utf8');
  await fs.writeFile(ps1, 'exit 0\n', 'utf8');
  let invocation;
  const nativeArgs = ['literal&value', 'two words'];
  await spawnInteractive('codex', nativeArgs, root, {
    platform: 'win32',
    windowsCandidates: [cmd],
    powerShell: 'pwsh.exe',
    parentProcess: new EventEmitter(),
    spawn(command, args, options) {
      invocation = { command, args, options };
      return fakeChild(0, null);
    }
  });
  assert.equal(invocation.command, 'pwsh.exe');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(-nativeArgs.length), nativeArgs);
  assert.equal(invocation.args.includes(ps1), true);
});

test('a signal-terminated child returns the conventional nonzero exit status', async () => {
  const exitCode = await spawnInteractive('codex', [], process.cwd(), {
    platform: 'linux',
    parentProcess: new EventEmitter(),
    spawn: () => fakeChild(null, 'SIGTERM')
  });
  assert.equal(exitCode, 128 + os.constants.signals.SIGTERM);
});

test('parent signals are forwarded once and listeners are removed after exit', async () => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => child.emit('exit', null, signal));
  };

  const result = spawnInteractive('codex', [], process.cwd(), {
    platform: 'linux',
    parentProcess: parent,
    spawn: () => child
  });
  parent.emit('SIGINT');

  assert.equal(await result, 128 + os.constants.signals.SIGINT);
  assert.deepEqual(signals, ['SIGINT']);
  assert.equal(parent.listenerCount('SIGINT'), 0);
  assert.equal(parent.listenerCount('SIGTERM'), 0);
});

test('usage renders the total in four parts per agent, insights, and a breakdown on request', async () => {
  const { renderUsage } = await import('../src/cli.js');
  const parts = (output, newInput, resent, cacheRead) => ({ output, newInput, resent, cacheRead, total: output + newInput + resent + cacheRead, calls: 1 });
  const windows = () => ({ today: parts(1e5, 2e5, 1e5, 3.1e6), last7: parts(0, 0, 0, 0), lastHour: parts(0, 0, 0, 0), last24h: parts(0, 0, 0, 0), last30: parts(0, 0, 0, 0) });
  const summary = {
    days: 2,
    range: { from: '2026-10-08', to: '2026-10-09' },
    windows: { claude: windows(), codex: windows() },
    burnPerHour: { claude: 165_000, codex: 684_000 },
    daily: [
      { day: '2026-10-08', claude: parts(1e6, 2e6, 3e6, 94e6), codex: parts(2e6, 0, 0, 98e6) },
      { day: '2026-10-09', claude: parts(0, 0, 0, 0), codex: parts(0, 0, 0, 0) }
    ],
    byModel: [{ agent: 'codex', label: 'gpt-6.1-sol', total: 578e6, output: 2.6e6, resent: 9.1e6, calls: 3706 }],
    byProject: [],
    byAccount: [],
    insights: [{ message: 'Re-sent context was 69% of input.', advice: 'Start a fresh session after a break.' }]
  };
  const text = renderUsage(summary);
  assert.match(text, /^Tokens processed, last 2 days \(2026-10-08 to 2026-10-09\)/);
  assert.match(text, /Claude Code\s+3\.5M\s+100M\s+1\.0M\s+2\.0M\s+3\.0M\s+94\.0M\s+165k/);
  assert.match(text, /Codex\s+3\.5M\s+100M\s+2\.0M\s+0\s+0\s+98\.0M\s+684k/);
  assert.match(text, /\* Re-sent context was 69% of input\. Start a fresh session after a break\./);
  assert.match(renderUsage(summary, 'model'), /gpt-6\.1-sol\s+Codex\s+578M\s+2\.6M\s+9\.1M\s+3706/);
  assert.match(renderUsage(summary, 'day'), /2026-10-08\s+100M\s+100M\s+1\.0M\s+2\.0M/);
  assert.match(renderUsage(summary, 'agent', { total: 12.345, priced: 1, unpriced: ['gpt-6.1-sol'] }), /US\$12\.35 across 1 model\(s\); no price for gpt-6\.1-sol/);
});
