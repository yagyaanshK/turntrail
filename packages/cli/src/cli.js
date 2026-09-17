import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  activateCodexAccount,
  captureSnapshot,
  codexHome,
  createAccount,
  discoverNativeSessions,
  exportHandoff,
  getCodexUsage,
  headlineRemaining,
  importCodexAuth,
  importNativeSession,
  importTranscript,
  initStore,
  isSignedIn,
  listAccounts,
  maintainAccounts,
  normalizeNativeProvider,
  readManifest,
  removeAccount,
  resolveLedger,
  defaultCodexHome
} from '@turntrail/core';
import { spawn } from 'node:child_process';

const HELP = `Turntrail

Usage:
  turntrail init [--cwd <path>]
  turntrail import --provider <name> [--surface <name>] <file> [--cwd <path>]
  turntrail discover --provider claude|codex|gemini|cursor [--all] [--include-subagents] [--cwd <path>]
  turntrail import-native --provider claude|codex|gemini|cursor [--last|--session <id>] [--all] [--subagent-transcripts] [--force] [--cwd <path>]
  turntrail run claude|codex|gemini|cursor [-- <native args>] [--cwd <path>]
  turntrail snapshot [--cwd <path>]
  turntrail export --to <target> [--max-chars <n>] [--no-dedupe] [--since-last-export]
                        [--tool-max-chars <n>] [--system-max-chars <n>] [--cwd <path>]
  turntrail status [--cwd <path>]
  turntrail accounts [--provider codex] [--refresh]
  turntrail account add <label> [--import]
  turntrail account use <id>
  turntrail account remove <id> [--purge]
  turntrail account maintain [--json]

Account options:
  --import                Adopt the login already in the default CODEX_HOME
                          instead of signing in fresh.
  --refresh               Force a quota read instead of using the cache.
  --use <id>              Print the shell export needed to run codex as an
                          account without changing the machine default.
  --purge                 Delete the managed credential and the live default
                          login when this account is active.
  --json                  Emit machine-readable maintenance results.

Export options:
  --max-chars <n>         Character budget for the transcript (default 120000, 0 = off).
                          Receiving agents refuse or silently truncate oversized
                          handoffs, so the budget is on by default.
  --no-dedupe             Keep consecutive duplicate turns instead of collapsing them.
  --since-last-export     Send only what the target has not seen: its own last turn,
                          or the last handoff aimed at it, whichever is later.
                          Off by default: a new agent session has no memory of
                          what an earlier handoff already delivered.
  --tool-max-chars <n>    Truncate tool-output turns over n chars (default 2000, 0 = off).
  --system-max-chars <n>  Truncate system turns over n chars (default 800, 0 = off).
  --snapshot-diff-max-chars <n>
                          How much uncommitted diff to embed (default 4000, 0 = off).
  --keep-exports <n>      Past handoff files to keep (default 10, 0 = keep all).
  --no-summary            Omit the extractive "Where This Left Off" section.

Examples:
  turntrail init
  turntrail import --provider claude --surface cli ./transcript.jsonl
  turntrail discover --provider codex
  turntrail discover --provider gemini
  turntrail import-native --provider cursor --last
  turntrail import-native --provider claude --last
  turntrail run codex -- --approval-mode auto-edit
  turntrail snapshot
  turntrail export --to codex --max-chars 60000

Compatibility:
  The legacy context-bridge executable remains an alias for turntrail.
`;

export async function runCli(argv, io = process, dependencies = {}) {
  const { command, args, flags } = parseArgs(argv);
  const cwd = path.resolve(flags.cwd || process.cwd());

  if (!command || flags.help || command === 'help') {
    io.stdout.write(HELP);
    return;
  }

  if (command === 'init') {
    await initStore(cwd);
    io.stdout.write(`Initialized Turntrail at ${resolveLedger(cwd)}\n`);
    return;
  }

  if (command === 'import') {
    const source = args[0];
    if (!source) throw new Error('import requires a transcript file path');
    if (!flags.provider) throw new Error('import requires --provider <name>');
    const result = await importTranscript(cwd, source, {
      provider: flags.provider,
      surface: flags.surface || 'unknown'
    });
    io.stdout.write(`Imported ${result.turnCount} turns into ${result.relativePath}\n`);
    return;
  }

  if (command === 'discover') {
    if (!flags.provider) throw new Error('discover requires --provider claude|codex|gemini|cursor');
    const sessions = await discoverNativeSessions(flags.provider, {
      root: cwd,
      all: Boolean(flags.all),
      includeArchived: Boolean(flags.includeArchived),
      includeSubagents: Boolean(flags.includeSubagents)
    });
    io.stdout.write(renderSessions(sessions));
    return;
  }

  if (command === 'import-native') {
    if (!flags.provider) throw new Error('import-native requires --provider claude|codex|gemini|cursor');
    const result = await importNativeSession(cwd, flags.provider, {
      root: cwd,
      all: Boolean(flags.all),
      last: Boolean(flags.last) || !flags.session,
      sessionId: flags.session,
      includeArchived: Boolean(flags.includeArchived),
      includeSubagents: Boolean(flags.includeSubagents),
      subagentTranscripts: Boolean(flags.subagentTranscripts),
      force: Boolean(flags.force)
    });
    io.stdout.write(
      result.unchanged
        ? `Native session unchanged since its last import; ${result.relativePath} already holds it (${result.turnCount} turns). Use --force to import again.\n`
        : `Imported native session into ${result.relativePath} (${result.turnCount} turns)\n`
    );
    return;
  }

  if (command === 'run') {
    const provider = args[0];
    if (!provider) throw new Error('run requires claude, codex, gemini, or cursor');
    const result = await runNativeCli(cwd, provider, flags._ || args.slice(1), io);
    if (result.imported) {
      io.stdout.write(`Imported native session into ${result.imported.relativePath} (${result.imported.turnCount} turns)\n`);
    } else {
      io.stdout.write('No changed native transcript was detected after the run.\n');
    }
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  if (command === 'snapshot') {
    const result = await captureSnapshot(cwd);
    io.stdout.write(`Captured snapshot at ${result.relativePath}\n`);
    return;
  }

  if (command === 'export') {
    if (!flags.to) throw new Error('export requires --to <target>');
    const result = await exportHandoff(cwd, {
      target: flags.to,
      maxChars: flags.maxChars !== undefined ? Number(flags.maxChars) : undefined,
      dedupe: flags['no-dedupe'] ? false : undefined,
      sinceLastExport: Boolean(flags.sinceLastExport),
      toolMaxChars: flags.toolMaxChars !== undefined ? Number(flags.toolMaxChars) : undefined,
      systemMaxChars: flags.systemMaxChars !== undefined ? Number(flags.systemMaxChars) : undefined,
      snapshotDiffMaxChars:
        flags.snapshotDiffMaxChars !== undefined ? Number(flags.snapshotDiffMaxChars) : undefined,
      keepExports: flags.keepExports !== undefined ? Number(flags.keepExports) : undefined,
      summary: flags['no-summary'] ? false : undefined
    });
    io.stdout.write(`Wrote handoff to ${result.relativePath}\n`);
    return;
  }

  if (command === 'status') {
    const manifest = await readManifest(cwd);
    io.stdout.write(renderStatus(manifest));
    return;
  }

  if (command === 'accounts') {
    const accounts = await listAccounts({ provider: flags.provider || 'codex' });
    if (accounts.length === 0) {
      io.stdout.write('No accounts yet. Add one with `turntrail account add <label>`.\n');
      return;
    }
    const rows = [];
    for (const account of accounts) {
      const usage = await getCodexUsage(account.id, { force: Boolean(flags.refresh), offline: !flags.refresh });
      rows.push(renderAccountRow(account, usage, await isSignedIn(account.id)));
    }
    io.stdout.write(`Accounts:\n\n${rows.join('\n')}\n`);
    return;
  }

  if (command === 'account') {
    const action = args[0];

    if (action === 'maintain') {
      const runMaintenance = dependencies.maintainAccounts || maintainAccounts;
      const maintenance = await runMaintenance(dependencies.accountOptions || {});
      io.stdout.write(flags.json ? `${JSON.stringify(maintenance, null, 2)}\n` : renderMaintenance(maintenance));
      return;
    }

    if (action === 'add') {
      const label = args.slice(1).join(' ').trim();
      if (!label) throw new Error('account add requires a label');
      const account = await createAccount({ label, provider: 'codex' });
      if (flags.import) {
        const auth = await importCodexAuth(account.id, defaultCodexHome());
        io.stdout.write(`Added ${account.id} (${auth?.claims?.email || label}) from ${defaultCodexHome()}\n`);
      } else {
        io.stdout.write(
          `Added ${account.id}. Sign in with:\n\n  CODEX_HOME="${codexHome(account.id)}" codex login\n`
        );
      }
      return;
    }

    if (action === 'use') {
      const id = args[1];
      if (!id) throw new Error('account use requires an account id');
      const result = await activateCodexAccount(id);
      io.stdout.write(
        `Default Codex account is now ${id}.\nWrote ${result.target}` +
          (result.backup ? `\nPrevious login backed up to ${result.backup}\n` : '\n')
      );
      return;
    }

    if (action === 'remove') {
      const id = args[1];
      if (!id) throw new Error('account remove requires an account id');
      const result = await removeAccount(id, { purge: Boolean(flags.purge) });
      io.stdout.write(
        `Removed ${id}${result.purged ? ' and deleted its credentials' : ' (credentials kept on disk)'}` +
          (result.livePurged ? ', including the active default login' : '') +
          '\n'
      );
      return;
    }

    throw new Error(`unknown account action: ${action || '(none)'}`);
  }

  throw new Error(`unknown command: ${command}`);
}

export function renderMaintenance(maintenance) {
  if (maintenance.locked) return 'Account maintenance is already running in another process.\n';
  if (maintenance.results.length === 0) return 'No managed accounts to maintain.\n';

  const lines = ['Account maintenance:', ''];
  for (const item of maintenance.results) {
    const detail = item.reason ? ` (${item.reason})` : item.error ? ` (${item.error})` : '';
    lines.push(`${item.provider}/${item.accountId}: ${item.status}${detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', args: [], flags: { help: true } };
  }

  const [command, ...rest] = argv;
  const args = [];
  const flags = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '--') {
      flags._ = rest.slice(i + 1);
      break;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        setFlag(flags, key, true);
      } else {
        setFlag(flags, key, next);
        i++;
      }
    } else {
      args.push(token);
    }
  }

  return { command, args, flags };
}

// Store each flag under its raw (kebab-case) key and a camelCase alias so that
// `--max-chars` and `--maxChars` are equivalent.
function setFlag(flags, key, value) {
  flags[key] = value;
  const camel = key.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
  if (camel !== key) flags[camel] = value;
}

export async function runNativeCli(cwd, provider, nativeArgs = [], io = process) {
  const normalized = normalizeNativeProvider(provider);
  const executable = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    cursor: 'cursor-agent'
  }[normalized] || provider;
  const startedAt = Date.now();
  const before = await discoverNativeSessions(normalized, {
    root: cwd,
    all: true,
    includeArchived: true,
    limit: 10000
  });
  const beforeByPath = new Map(before.map((session) => [session.path, session.mtimeMs]));

  const exitCode = await spawnInteractive(executable, nativeArgs, cwd);

  const after = await discoverNativeSessions(normalized, {
    root: cwd,
    all: true,
    includeArchived: true,
    limit: 10000
  });
  const changed = after
    .filter((session) => {
      const previousMtime = beforeByPath.get(session.path);
      return (previousMtime === undefined || session.mtimeMs > previousMtime) && session.mtimeMs >= startedAt - 2000;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const session = changed.find((item) => item.matchesProject) || changed[0];
  if (!session) return { exitCode, imported: null };

  const imported = await importNativeSession(cwd, normalized, {
    path: session.path,
    includeArchived: true
  });
  await captureSnapshot(cwd);
  io.stdout.write(`Detected changed native transcript: ${session.path}\n`);
  return { exitCode, imported };
}

export async function spawnInteractive(command, args, cwd, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = platform === 'win32'
    ? await (options.resolveWindows || resolveWindowsExecutable)(command, args, options)
    : { command, args };
  const spawnImpl = options.spawn || spawn;
  const parent = options.parentProcess || process;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(resolved.command, resolved.args, {
      cwd,
      stdio: 'inherit',
      shell: false
    });
    let settled = false;
    const forwarded = ['SIGINT', 'SIGTERM'];
    const handlers = new Map(forwarded.map((signal) => [signal, () => {
      try {
        child.kill(signal);
      } catch {
        // The child already exited.
      }
    }]));
    for (const [signal, handler] of handlers) parent.once(signal, handler);

    const cleanup = () => {
      for (const [signal, handler] of handlers) parent.removeListener(signal, handler);
    };
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code === null ? signalExitCode(signal) : code);
    });
  });
}

async function resolveWindowsExecutable(command, args, options = {}) {
  const candidates = await windowsCommandCandidates(command, options);
  const direct = candidates.find((candidate) => /\.(?:exe|com)$/i.test(candidate));
  if (direct) return { command: direct, args };

  const shim = candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate));
  const powerShellShim = candidates.find((candidate) => /\.ps1$/i.test(candidate)) ||
    (shim ? shim.replace(/\.(?:cmd|bat)$/i, '.ps1') : undefined);
  if (powerShellShim && fs.existsSync(powerShellShim)) {
    return {
      command: options.powerShell || 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', powerShellShim, ...args]
    };
  }
  if (shim) {
    throw new Error(`Cannot safely launch Windows command shim ${shim}: no sibling PowerShell shim was found.`);
  }
  throw new Error(`Command not found: ${command}`);
}

async function windowsCommandCandidates(command, options = {}) {
  if (options.windowsCandidates) return options.windowsCandidates;
  if (path.isAbsolute(command) || /[\\/]/.test(command)) return [path.resolve(command)];
  return new Promise((resolve, reject) => {
    const child = spawn(options.whereCommand || 'where.exe', [command], { shell: false, windowsHide: true });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-64 * 1024);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return resolve([]);
      resolve(output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
    });
  });
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal];
  return Number.isInteger(number) ? 128 + number : 1;
}

function renderSessions(sessions) {
  if (sessions.length === 0) return 'No native sessions found for this project.\n';
  const lines = ['Native sessions:', ''];
  for (const session of sessions) {
    lines.push([
      session.sessionId,
      session.provider,
      session.subagent ? `${session.surface} (subagent of ${session.parentSessionId || 'unknown'})` : session.surface,
      session.matchesProject ? 'project' : 'all',
      session.modifiedAt,
      session.cwd || '(no cwd)',
      session.path
    ].join(' | '));
  }
  lines.push('');
  return lines.join('\n');
}

function renderAccountRow(account, usage, signedIn) {
  const remaining = usage ? headlineRemaining(usage) : undefined;
  const state =
    !signedIn || usage?.error === 'not-signed-in'
      ? 'not signed in'
      : usage?.error
        ? `unavailable (${usage.error})`
        : remaining === undefined
          ? 'quota not read (use --refresh)'
          : `${remaining}% left`;

  const ordinary = (usage?.windows || [])
    .map((window) => `${window.label} ${window.remainingPercent}%`)
    .join(', ');
  const additional = (usage?.additionalLimits || [])
    .map((limit) => {
      const windows = (limit.windows || [])
        .map((window) => `${window.label} ${window.remainingPercent}%`)
        .join(', ');
      return `${limit.label} (separate allowance${windows ? `: ${windows}` : ''})`;
    })
    .join('; ');
  const detail = [ordinary, additional].filter(Boolean).join('; ');

  return [
    `  ${account.id}`,
    `    ${account.label}${account.email ? ` <${account.email}>` : ''}`,
    `    ${state}${detail ? ` — ${detail}` : ''}`,
    `    ${codexHome(account.id)}`
  ].join('\n');
}

function renderStatus(manifest) {
  return [
    'Turntrail status',
    '',
    `Project root: ${manifest.projectRoot}`,
    `Schema version: ${manifest.schemaVersion}`,
    `Sessions: ${(manifest.sessions || []).length}`,
    `Snapshots: ${(manifest.snapshots || []).length}`,
    `Exports: ${(manifest.exports || []).length}`,
    ''
  ].join('\n');
}
