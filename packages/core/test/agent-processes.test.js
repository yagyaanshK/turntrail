import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertAgentStopped,
  classifyAgentProcesses,
  listAgentProcesses,
  matchingAgentProcesses,
  terminateAgentProcesses,
  unguardedAgentProcesses
} from '../src/index.js';

const CODEX_GUARD = 'Skipping token refresh because auth changed after guarded reload';
const CLAUDE_GUARD = 'tengu_oauth_refresh_save_adopted_newer_write';

const processes = [
  { pid: 10, name: 'Code.exe', commandLine: 'Code.exe --type=utility' },
  { pid: 11, name: 'codex.exe', commandLine: 'codex.exe app-server' },
  { pid: 12, name: 'claude.exe', commandLine: 'claude.exe --output-format stream-json' },
  { pid: 13, name: 'node', commandLine: 'node /opt/node_modules/@openai/codex/bin/codex.js' },
  { pid: 14, name: 'node', commandLine: 'node /opt/node_modules/@anthropic-ai/claude-code/cli.js' },
  { pid: 15, name: 'node', commandLine: 'node packages/core/test/claude.test.js' }
];

test('agent process matching ignores editors and test names but finds native and npm agents', () => {
  assert.deepEqual(matchingAgentProcesses('codex', processes).map((item) => item.pid), [11, 13]);
  assert.deepEqual(matchingAgentProcesses('claude', processes).map((item) => item.pid), [12, 14]);
});

test('Codex Windows app host is matched without treating unrelated ChatGPT apps as Codex', () => {
  const running = [
    {
      pid: 20,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.5280.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
    },
    {
      pid: 21,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0.0_x64__example\\app\\ChatGPT.exe'
    },
    {
      pid: 22,
      parentPid: 20,
      name: 'codex.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.5280.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe'
    }
  ];

  assert.deepEqual(matchingAgentProcesses('codex', running).map((item) => item.pid), [20, 22]);
  assert.deepEqual(
    classifyAgentProcesses('codex', running).map(({ pid, kind, client }) => ({ pid, kind, client })),
    [
      { pid: 20, kind: 'desktop', client: 'Codex desktop app' },
      { pid: 22, kind: 'desktop', client: 'Codex desktop app' }
    ]
  );
});

test('Codex extension services are distinguished from interactive Codex processes', () => {
  const running = [
    { pid: 100, name: 'Code.exe', commandLine: 'Code.exe' },
    { pid: 101, parentPid: 100, name: 'Code.exe', commandLine: 'Code.exe --type=utility' },
    {
      pid: 102,
      parentPid: 101,
      name: 'codex.exe',
      executablePath: 'C:\\Users\\dev\\.vscode\\extensions\\openai.chatgpt-1.2.3\\bin\\windows-x86_64\\codex.exe',
      commandLine: 'codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled'
    },
    { pid: 103, parentPid: 102, name: 'codex-code-mode-host.exe' },
    { pid: 104, name: 'codex.exe', commandLine: 'codex exec --full-auto' },
    { pid: 105, name: 'codex.exe', commandLine: 'codex app-server' }
  ];

  assert.deepEqual(
    classifyAgentProcesses('codex', running).map(({ pid, kind, editor }) => ({ pid, kind, editor })),
    [
      { pid: 102, kind: 'ide-background', editor: 'VS Code' },
      { pid: 103, kind: 'ide-background', editor: 'VS Code' },
      { pid: 104, kind: 'interactive', editor: undefined },
      { pid: 105, kind: 'interactive', editor: undefined }
    ]
  );
});

test('Codex extension services are recognized across common VS Code forks', () => {
  for (const [name, folder, editor] of [
    ['Cursor.exe', '.cursor', 'Cursor'],
    ['Windsurf.exe', '.windsurf', 'Windsurf'],
    ['Antigravity.exe', '.antigravity', 'Google Antigravity'],
    ['VSCodium.exe', '.vscode-oss', 'VSCodium']
  ]) {
    const classified = classifyAgentProcesses('codex', [
      { pid: 1, name },
      { pid: 2, parentPid: 1, name },
      {
        pid: 3,
        parentPid: 2,
        name: 'codex.exe',
        executablePath: `C:\\Users\\dev\\${folder}\\extensions\\openai.chatgpt-build\\bin\\codex.exe`,
        commandLine: 'codex.exe app-server'
      }
    ]);
    assert.equal(classified[0]?.kind, 'ide-background', name);
    assert.equal(classified[0]?.editor, editor, name);
  }
});

test('Claude processes remain interactive blockers until the provider exposes a restart contract', () => {
  const classified = classifyAgentProcesses('claude', [
    { pid: 1, name: 'Code.exe' },
    { pid: 2, parentPid: 1, name: 'claude.exe', commandLine: 'claude.exe --output-format stream-json' }
  ]);
  assert.equal(classified[0]?.kind, 'interactive');
  assert.equal(classified[0]?.editor, undefined);
});

test('Claude extension services and Kiro Codex services identify their editor owner', () => {
  const running = [
    { pid: 1, name: 'Kiro.exe' },
    { pid: 2, parentPid: 1, name: 'Kiro.exe' },
    {
      pid: 3,
      parentPid: 2,
      name: 'codex.exe',
      executablePath: 'C:\\Users\\dev\\.kiro\\extensions\\openai.chatgpt-build\\bin\\codex.exe',
      commandLine: 'codex.exe app-server'
    },
    {
      pid: 4,
      parentPid: 2,
      name: 'claude.exe',
      executablePath: 'C:\\Users\\dev\\.kiro\\extensions\\anthropic.claude-code-2.1.0\\resources\\claude.exe',
      commandLine: 'claude.exe --output-format stream-json'
    }
  ];

  assert.equal(classifyAgentProcesses('codex', running)[0]?.editor, 'Kiro');
  assert.equal(classifyAgentProcesses('claude', running)[0]?.editor, 'Kiro');
});

test('confirmed process termination re-enumerates and stops matching provider processes only', async () => {
  const samples = [
    [
      { pid: 10, name: 'codex.exe', commandLine: 'codex.exe app-server' },
      { pid: 11, name: 'claude.exe', commandLine: 'claude.exe' }
    ],
    []
  ];
  const killed = [];
  const result = await terminateAgentProcesses('codex', {
    platform: 'win32',
    listAgentProcesses: async () => samples.shift() || [],
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value; })()
  });

  assert.deepEqual(killed, [{ pid: 10, signal: 'SIGKILL' }]);
  assert.deepEqual(result.terminated.map((item) => item.pid), [10]);
  assert.deepEqual(result.remaining, []);
});

test('confirmed Codex termination stops its ChatGPT-named desktop host only', async () => {
  const codexHost = {
    pid: 20,
    name: 'ChatGPT.exe',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.5280.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
  };
  const standaloneChatGPT = {
    pid: 21,
    name: 'ChatGPT.exe',
    executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0.0_x64__example\\app\\ChatGPT.exe'
  };
  const samples = [[codexHost, standaloneChatGPT], [standaloneChatGPT]];
  const killed = [];

  const result = await terminateAgentProcesses('codex', {
    platform: 'win32',
    listAgentProcesses: async () => samples.shift() || [standaloneChatGPT],
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value; })()
  });

  assert.deepEqual(killed, [{ pid: 20, signal: 'SIGKILL' }]);
  assert.deepEqual(result.terminated.map((item) => item.pid), [20]);
  assert.deepEqual(result.remaining, []);
});

test('process termination reports provider processes that keep restarting', async () => {
  let now = 0;
  const killed = [];
  const result = await terminateAgentProcesses('codex', {
    platform: 'linux',
    listAgentProcesses: async () => [{ pid: 10, name: 'codex', commandLine: 'codex app-server' }],
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    sleep: async () => { now += 100; },
    now: () => now,
    gracefulMs: 100,
    timeoutMs: 250,
    pollMs: 100
  });

  assert.deepEqual(killed.slice(0, 2), [
    { pid: 10, signal: 'SIGTERM' },
    { pid: 10, signal: 'SIGKILL' }
  ]);
  assert.deepEqual(result.remaining.map((item) => item.pid), [10]);
});

test('the switch preflight names the process and confirms no credential was changed', async () => {
  await assert.rejects(
    assertAgentStopped('codex', { agentProcesses: [{ pid: 42, name: 'codex.exe' }] }),
    /codex\.exe \(PID 42\).*did not change the live credential/i
  );
  await assert.doesNotReject(assertAgentStopped('claude', { agentProcesses: [] }));
});

test('Windows process enumeration accepts both singleton and array JSON', async () => {
  const execFile = async () => ({
    stdout: JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'codex.exe', CommandLine: 'codex.exe app-server' })
  });
  const listed = await listAgentProcesses({ platform: 'win32', execFile });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pid, 7);
});

test('process enumeration fails closed when the operating-system query fails', async () => {
  await assert.rejects(
    listAgentProcesses({ platform: 'linux', execFile: async () => { throw new Error('permission denied'); } }),
    /Could not inspect running agent processes: permission denied/
  );
});

async function guardFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-guard-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = async (name, content) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, content);
    return file;
  };
  return { directory, write, options: { accountsRoot: path.join(directory, 'accounts') } };
}

test('a running client whose binary carries its vendor guard does not block a switch', async (t) => {
  const { write, options } = await guardFixture(t);
  const current = await write('codex-current.exe', `binary ${CODEX_GUARD} binary`);
  const old = await write('codex-old.exe', 'binary without the marker');
  const claude = await write('claude.exe', `${CLAUDE_GUARD}`);
  const running = [
    { pid: 1, name: 'codex.exe', executablePath: current, commandLine: 'codex.exe app-server' },
    { pid: 2, name: 'codex.exe', executablePath: old, commandLine: 'codex.exe' },
    { pid: 3, name: 'claude.exe', executablePath: claude }
  ];

  assert.deepEqual((await unguardedAgentProcesses('codex', running, options)).map((item) => item.pid), [2]);
  assert.deepEqual(await unguardedAgentProcesses('claude', running, options), []);
  // The Codex marker in a Claude binary proves nothing about Claude.
  assert.deepEqual(
    (await unguardedAgentProcesses('claude', [{ pid: 4, name: 'claude.exe', executablePath: current }], options))
      .map((item) => item.pid),
    [4]
  );

  await assert.doesNotReject(assertAgentStopped('claude', { ...options, allowGuarded: true, agentProcesses: running }));
  await assert.rejects(
    assertAgentStopped('codex', { ...options, allowGuarded: true, agentProcesses: running }),
    /codex\.exe \(PID 2\).*too old to notice a login change.*did not change the live credential/i
  );
  // Without the opt-in, every running client still blocks.
  await assert.rejects(assertAgentStopped('claude', { ...options, agentProcesses: running }), /PID 3/);
});

test('a client whose code cannot be read or recognised is treated as unguarded', async (t) => {
  const { write, options } = await guardFixture(t);
  const script = await write('cli.js', `/* ${CLAUDE_GUARD} */`);
  const running = [
    { pid: 1, name: 'codex.exe' },
    { pid: 2, name: 'codex.exe', executablePath: path.join(options.accountsRoot, 'missing.exe') },
    { pid: 3, name: 'node', commandLine: 'node /opt/node_modules/@openai/codex/bin/codex.js' }
  ];
  assert.deepEqual((await unguardedAgentProcesses('codex', running, options)).map((item) => item.pid), [1, 2, 3]);

  const npmClaude = { pid: 5, name: 'node', commandLine: `node "${script.replace('cli.js', '@anthropic-ai/claude-code/cli.js')}"` };
  assert.deepEqual((await unguardedAgentProcesses('claude', [npmClaude], options)).map((item) => item.pid), [5]);

  const installed = path.join(path.dirname(script), 'node_modules', '@anthropic-ai', 'claude-code');
  await fs.mkdir(installed, { recursive: true });
  await fs.copyFile(script, path.join(installed, 'cli.js'));
  const guardedNpm = { pid: 6, name: 'node', commandLine: `node "${path.join(installed, 'cli.js')}" --resume` };
  assert.deepEqual(await unguardedAgentProcesses('claude', [guardedNpm], options), []);
});

test('hosts and launchers that hold no login of their own are left to the process that does', async (t) => {
  const { write, options } = await guardFixture(t);
  const native = await write('codex.exe', CODEX_GUARD);
  const running = [
    {
      pid: 20,
      name: 'ChatGPT.exe',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.901.5280.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
    },
    { pid: 21, parentPid: 20, name: 'codex.exe', executablePath: native, commandLine: 'codex.exe app-server' },
    { pid: 22, parentPid: 21, name: 'codex-code-mode-host.exe', executablePath: 'C:\\x\\codex-code-mode-host.exe' },
    { pid: 30, name: 'node', commandLine: 'node /opt/node_modules/@openai/codex/bin/codex.js' },
    { pid: 31, parentPid: 30, name: 'codex', executablePath: native }
  ];
  assert.deepEqual(await unguardedAgentProcesses('codex', running, options), []);
});

test('the guard check finds a marker split across read chunks and remembers each file', async (t) => {
  const { write, options } = await guardFixture(t);
  const chunk = 4 * 1024 * 1024;
  const marker = Buffer.from(CODEX_GUARD);
  const content = Buffer.alloc(chunk + marker.length, 0x20);
  marker.copy(content, chunk - 10);
  const file = await write('large-codex.exe', content);
  const running = [{ pid: 9, name: 'codex.exe', executablePath: file }];

  assert.deepEqual(await unguardedAgentProcesses('codex', running, options), []);
  const cached = JSON.parse(await fs.readFile(path.join(options.accountsRoot, 'auth-guards.json'), 'utf8'));
  assert.deepEqual(Object.values(cached).map((entry) => entry.guarded), [true]);

  // A rebuilt binary at the same path is read again rather than trusted.
  await fs.writeFile(file, 'an older build without the marker');
  assert.deepEqual((await unguardedAgentProcesses('codex', running, options)).map((item) => item.pid), [9]);
});

test('stopping for a switch leaves guarded clients running', async (t) => {
  const { write, options } = await guardFixture(t);
  const current = await write('codex-current.exe', CODEX_GUARD);
  const old = await write('codex-old.exe', 'old');
  const guarded = { pid: 1, name: 'codex.exe', executablePath: current };
  const samples = [[guarded, { pid: 2, name: 'codex.exe', executablePath: old }], [guarded]];
  const killed = [];
  const result = await terminateAgentProcesses('codex', {
    ...options,
    onlyUnguarded: true,
    platform: 'win32',
    listAgentProcesses: async () => samples.shift() || [guarded],
    killProcess: (pid) => killed.push(pid),
    sleep: async () => {},
    now: (() => { let value = 0; return () => ++value; })()
  });
  assert.deepEqual(killed, [2]);
  assert.deepEqual(result.remaining, []);
});
