import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJson, writeJson } from '../fs-utils.js';
import { accountsRoot } from './store.js';

const execFileAsync = promisify(execFile);
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

export async function listAgentProcesses(options = {}) {
  try {
    if (Array.isArray(options.agentProcesses)) return options.agentProcesses.map(normalizeProcess);
    if (typeof options.listAgentProcesses === 'function') {
      return (await options.listAgentProcesses()).map(normalizeProcess);
    }

    const platform = options.platform || process.platform;
    const run = options.execFile || execFileAsync;
    if (platform === 'win32') return await listWindowsProcesses(run);
    if (platform === 'linux' || platform === 'darwin') return await listPosixProcesses(run);
    throw new Error(`unsupported platform ${platform}`);
  } catch (error) {
    throw new Error(`Could not inspect running agent processes: ${error.message}`);
  }
}

export function matchingAgentProcesses(provider, processes) {
  const normalized = provider === 'claude' ? 'claude' : provider === 'codex' ? 'codex' : undefined;
  if (!normalized) throw new Error(`Unsupported agent provider: ${provider}`);
  return (processes || []).map(normalizeProcess).filter((item) => processMatches(normalized, item));
}

export function classifyAgentProcesses(provider, processes) {
  const all = (processes || []).map(normalizeProcess);
  const matches = matchingAgentProcesses(provider, all);
  return matches.map((item) => {
    const editor = agentEditorOwner(provider, item, all);
    const client = agentDesktopClient(provider, item, all);
    return {
      ...item,
      kind: editor ? 'ide-background' : client ? 'desktop' : 'interactive',
      editor,
      client
    };
  });
}

// With `allowGuarded`, a running client that re-reads the login before it
// refreshes (see unguardedAgentProcesses) does not block: it cannot write the
// previous account back over the new one. Every other caller still requires
// the provider to be fully stopped.
export async function assertAgentStopped(provider, options = {}) {
  const processes = await listAgentProcesses(options);
  const matches = options.allowGuarded
    ? await unguardedAgentProcesses(provider, processes, options)
    : matchingAgentProcesses(provider, processes);
  if (matches.length === 0) return;

  const label = provider === 'claude' ? 'Claude' : 'Codex';
  const details = matches
    .slice(0, 3)
    .map((item) => `${item.name || 'process'}${item.pid ? ` (PID ${item.pid})` : ''}`)
    .join(', ');
  const extra = matches.length > 3 ? ` and ${matches.length - 3} more` : '';
  const advice = options.allowGuarded
    ? `These run a ${label} too old to notice a login change. Close or update them, then retry. `
    : `Close its CLI sessions and desktop app, and close or reload IDE windows hosting the ${label} extension, then retry. `;
  throw new Error(`${label} is still running: ${details}${extra}. ${advice}Turntrail did not change the live credential.`);
}

// Current builds of both agents re-read the shared login before refreshing it
// and back off when another process changed it: Codex skips the refresh
// ("auth changed after guarded reload"), Claude Code only saves over the token
// it posted and otherwise adopts the newer one. A running client with that
// guard may stay on the previous account until restarted, but it cannot undo a
// switch. These strings are what each vendor's own binary carries; they are
// observed, not a published contract, so a build without them is treated as
// unguarded and must stop first.
const AUTH_GUARD_MARKERS = {
  codex: 'Skipping token refresh because auth changed after guarded reload',
  claude: 'tengu_oauth_refresh_save_adopted_newer_write'
};
const AUTH_GUARD_CACHE_FILE = 'auth-guards.json';
const guardCache = new Map();

// The running processes of this provider that hold its login and cannot be
// shown to carry the guard. Unknown means unguarded: a process whose image
// cannot be read, or a client Turntrail does not recognise, still blocks.
export async function unguardedAgentProcesses(provider, processes, options = {}) {
  const all = (processes || []).map(normalizeProcess);
  const scan = options.scanAuthGuard || ((file) => fileHasAuthGuard(provider, file, options));
  const unguarded = [];
  for (const item of matchingAgentProcesses(provider, all)) {
    const image = authHolderImage(provider, item, all);
    if (image === null) continue;
    if (!image || !(await scan(image).catch(() => false))) unguarded.push(item);
  }
  return unguarded;
}

// The file whose code handles the login for this process, null when the
// process holds no login of its own, or undefined when it cannot be told.
function authHolderImage(provider, item, all) {
  const name = processName(item);
  // The Codex desktop host drives a codex app-server child, which is checked
  // in its own right, and the code-mode host carries no login code at all.
  if (provider === 'codex' && (isCodexDesktopHost(item) || name === 'codex-code-mode-host')) return null;
  if (name === provider) return item.executablePath || undefined;

  // An npm launcher that has started the native binary leaves the login to it.
  const nativeChild = all.some((candidate) => candidate.parentPid === item.pid && processName(candidate) === provider);
  if (item.pid && nativeChild) return null;
  const pkg = provider === 'claude' ? '@anthropic-ai/claude-code/' : '@openai/codex/';
  const script = commandTokens(item.commandLine).find((token) =>
    token.toLowerCase().replaceAll('\\', '/').includes(pkg) && /\.[cm]?js$/i.test(token)
  );
  return script || undefined;
}

function commandTokens(commandLine) {
  return (String(commandLine || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^["']|["']$/g, ''));
}

// A binary is several hundred megabytes, so the answer is kept per file, in
// memory and in the accounts directory, keyed by size and modification time.
async function fileHasAuthGuard(provider, file, options = {}) {
  const marker = AUTH_GUARD_MARKERS[provider];
  const stat = await fs.stat(file);
  const key = `${provider}|${path.resolve(file).toLowerCase()}`;
  const stamp = `${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  const known = guardCache.get(key);
  if (known?.stamp === stamp) return known.guarded;

  const cachePath = path.join(accountsRoot(options), AUTH_GUARD_CACHE_FILE);
  const stored = await readJson(cachePath).catch(() => ({}));
  let guarded = stored?.[key]?.stamp === stamp ? stored[key].guarded === true : undefined;
  if (guarded === undefined) {
    guarded = await fileContains(file, marker);
    const next = { ...(stored && typeof stored === 'object' ? stored : {}), [key]: { stamp, guarded } };
    await writeJson(cachePath, next).catch(() => {});
  }
  guardCache.set(key, { stamp, guarded });
  return guarded;
}

function fileContains(file, text) {
  const needle = Buffer.from(text, 'latin1');
  return new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    let tail = Buffer.alloc(0);
    stream.on('data', (chunk) => {
      const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (window.indexOf(needle) !== -1) {
        stream.destroy();
        resolve(true);
        return;
      }
      tail = window.subarray(Math.max(0, window.length - needle.length + 1));
    });
    stream.on('error', reject);
    stream.on('close', () => resolve(false));
  });
}

// Stop only processes that still match the provider at execution time. The
// caller must obtain explicit user confirmation before invoking this: an
// interactive agent may have work in progress. A short graceful interval lets
// POSIX clients flush state; Windows maps these signals to process termination.
export async function terminateAgentProcesses(provider, options = {}) {
  const terminate = options.killProcess || process.kill.bind(process);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const gracefulMs = boundedDuration(options.gracefulMs, 750, 0, 10_000);
  const timeoutMs = boundedDuration(options.timeoutMs, 5_000, 250, 30_000);
  const pollMs = boundedDuration(options.pollMs, 100, 1, 1_000);
  const platform = options.platform || process.platform;
  const deadline = now() + timeoutMs;
  const firstSeenAt = new Map();
  const terminated = new Map();
  let remaining = [];
  // With `onlyUnguarded`, guarded clients are left running: they cannot block
  // a switch, so stopping them would only interrupt their work.
  const blocking = async () => {
    const processes = await listAgentProcesses(options);
    return options.onlyUnguarded
      ? unguardedAgentProcesses(provider, processes, options)
      : matchingAgentProcesses(provider, processes);
  };

  while (now() < deadline) {
    remaining = await blocking();
    if (remaining.length === 0) return { terminated: [...terminated.values()], remaining: [] };

    for (const item of remaining) {
      if (!item.pid) continue;
      const seenAt = firstSeenAt.get(item.pid);
      const force = platform === 'win32' ||
        (seenAt !== undefined && now() - seenAt >= gracefulMs);
      if (seenAt === undefined) firstSeenAt.set(item.pid, now());
      try {
        terminate(item.pid, force ? 'SIGKILL' : 'SIGTERM');
        terminated.set(item.pid, item);
      } catch (error) {
        // ESRCH means it exited between enumeration and termination, which is
        // the outcome we wanted. Permission failures must remain visible.
        if (error?.code !== 'ESRCH') throw new Error(`Could not stop ${item.name || `PID ${item.pid}`}: ${error.message}`);
      }
    }
    await sleep(pollMs);
  }

  remaining = await blocking();
  return { terminated: [...terminated.values()], remaining };
}

async function listWindowsProcesses(run) {
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ' +
    'ConvertTo-Json -Compress';
  const { stdout } = await run(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) =>
    normalizeProcess({
      pid: item.ProcessId,
      parentPid: item.ParentProcessId,
      name: item.Name,
      executablePath: item.ExecutablePath,
      commandLine: item.CommandLine
    })
  );
}

async function listPosixProcesses(run) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,comm=,args='], {
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024
  });
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter(Boolean)
    .map((match) =>
      normalizeProcess({ pid: match[1], parentPid: match[2], name: match[3], commandLine: match[4] })
    );
}

function processMatches(provider, item) {
  const name = path.basename(String(item.name || item.executablePath || '')).toLowerCase();
  if (provider === 'codex' && /^codex(?:-code-mode-host)?(?:\.exe)?$/.test(name)) return true;
  if (provider === 'codex' && isCodexDesktopHost(item)) return true;
  if (provider === 'claude' && /^claude(?:\.exe)?$/.test(name)) return true;

  const command = String(item.commandLine || '').toLowerCase().replaceAll('\\', '/');
  if (provider === 'codex') {
    return /(?:^|\s|["'])[^\s"']*@openai\/codex(?:\/|\s|["']|$)/.test(command);
  }
  return /(?:^|\s|["'])[^\s"']*@anthropic-ai\/claude-code(?:\/|\s|["']|$)/.test(command);
}

function agentDesktopClient(provider, item, processes) {
  if (provider !== 'codex') return undefined;

  const byPid = new Map(processes.filter((candidate) => candidate.pid).map((candidate) => [candidate.pid, candidate]));
  let current = item;
  for (let depth = 0; current && depth < 8; depth++) {
    if (isCodexDesktopHost(current)) return 'Codex desktop app';
    current = byPid.get(current.parentPid);
  }
  return undefined;
}

// The packaged Codex app currently uses ChatGPT.exe as its Windows host. Match
// the package-qualified path so a separate ChatGPT installation is untouched.
function isCodexDesktopHost(item) {
  if (processName(item) !== 'chatgpt') return false;
  const executable = String(item.executablePath || '').toLowerCase().replaceAll('\\', '/');
  return /\/openai\.codex_[^/]+\/app\/chatgpt\.exe$/.test(executable);
}

function agentEditorOwner(provider, item, processes) {
  if (provider === 'codex') return codexEditorOwner(item, processes);
  if (provider === 'claude') return claudeEditorOwner(item, processes);
  return undefined;
}

function codexEditorOwner(item, processes) {
  const name = processName(item);
  if (name === 'codex-code-mode-host') {
    const parent = processes.find((candidate) => candidate.pid === item.parentPid);
    return parent ? codexEditorOwner(parent, processes) : undefined;
  }
  if (name !== 'codex' || !/(?:^|\s)app-server(?:\s|$)/i.test(item.commandLine)) return undefined;

  const executable = String(item.executablePath || '').toLowerCase().replaceAll('\\', '/');
  if (!/\/extensions\/openai\.chatgpt-[^/]+\/bin\//.test(executable)) return undefined;

  const byPid = new Map(processes.filter((candidate) => candidate.pid).map((candidate) => [candidate.pid, candidate]));
  let ancestor = byPid.get(item.parentPid);
  for (let depth = 0; ancestor && depth < 8; depth++) {
    const editor = editorLabel(ancestor);
    if (editor) return editor;
    ancestor = byPid.get(ancestor.parentPid);
  }
  return undefined;
}

function claudeEditorOwner(item, processes) {
  if (processName(item) !== 'claude') return undefined;
  const executable = String(item.executablePath || '').toLowerCase().replaceAll('\\', '/');
  if (!/\/extensions\/anthropic\.claude-code-[^/]+\//.test(executable)) return undefined;
  return ancestorEditorOwner(item, processes);
}

function ancestorEditorOwner(item, processes) {
  const byPid = new Map(processes.filter((candidate) => candidate.pid).map((candidate) => [candidate.pid, candidate]));
  let ancestor = byPid.get(item.parentPid);
  for (let depth = 0; ancestor && depth < 8; depth++) {
    const editor = editorLabel(ancestor);
    if (editor) return editor;
    ancestor = byPid.get(ancestor.parentPid);
  }
  return undefined;
}

function editorLabel(item) {
  switch (processName(item)) {
    case 'code':
      return 'VS Code';
    case 'cursor':
      return 'Cursor';
    case 'windsurf':
      return 'Windsurf';
    case 'antigravity':
      return 'Google Antigravity';
    case 'kiro':
      return 'Kiro';
    case 'codium':
    case 'vscodium':
      return 'VSCodium';
    default:
      return undefined;
  }
}

function processName(item) {
  return path.basename(String(item.name || item.executablePath || '')).toLowerCase().replace(/\.exe$/, '');
}

function normalizeProcess(item = {}) {
  return {
    pid: numberOrUndefined(item.pid),
    parentPid: numberOrUndefined(item.parentPid),
    name: String(item.name || ''),
    executablePath: String(item.executablePath || ''),
    commandLine: String(item.commandLine || '')
  };
}

function numberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
