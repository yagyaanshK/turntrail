const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  editorEnvironment,
  resultPathForRequest
} = require('./switch-restart.cjs');

const POLL_MS = 400;
const QUIET_POLLS = 3;

async function main(requestPath = process.argv[2], options = {}) {
  const absoluteRequest = path.resolve(String(requestPath || ''));
  const resultPath = resultPathForRequest(absoluteRequest);
  let request;
  let result;
  try {
    request = validateRequest(JSON.parse(await fs.readFile(absoluteRequest, 'utf8')));
    const core = options.core || await import('@turntrail/core');
    const account = await core.getAccount(request.accountId);
    if (!account || account.provider !== request.provider) {
      throw new Error('The queued account no longer exists or changed provider.');
    }

    await waitForProviderStop(request.provider, request.deadlineAt, core, options.waitOptions);
    const activate = request.provider === 'claude' ? core.activateClaudeAccount : core.activateCodexAccount;
    const switched = await activate(request.accountId);
    result = completedResult(request, true, {
      alreadyActive: Boolean(switched?.alreadyActive),
      target: switched?.target
    });
    await (options.writeResult || writeResult)(resultPath, result);

    if (request.relaunch && !(options.isProcessRunning || isProcessRunning)(request.editorHostPid)) {
      try {
        await (options.relaunchEditor || relaunchEditor)(request.relaunch);
      } catch (error) {
        result = { ...result, relaunchError: error.message };
        await (options.writeResult || writeResult)(resultPath, result);
      }
    }
  } catch (error) {
    result = completedResult(request, false, { error: error.message });
    await (options.writeResult || writeResult)(resultPath, result).catch(() => {});
  } finally {
    await fs.rm(absoluteRequest, { force: true }).catch(() => {});
  }
  return result;
}

async function waitForProviderStop(provider, deadlineAt, core, options = {}) {
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) throw new Error('The queued switch has an invalid deadline.');
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? POLL_MS;
  const quietPolls = options.quietPolls ?? QUIET_POLLS;
  let quiet = 0;
  let lastMatches = [];

  while (quiet < quietPolls) {
    if (now() >= deadline) {
      const details = lastMatches
        .slice(0, 3)
        .map((item) => `${item.name || 'process'}${item.pid ? ` (PID ${item.pid})` : ''}`)
        .join(', ');
      throw new Error(`Timed out waiting for ${provider === 'claude' ? 'Claude' : 'Codex'} to stop${details ? `: ${details}` : ''}.`);
    }
    // Only clients that could write the previous login back must exit; the
    // switch routine itself enforces the same rule again before writing.
    const processes = await core.listAgentProcesses();
    lastMatches = await core.unguardedAgentProcesses(provider, processes);
    quiet = lastMatches.length === 0 ? quiet + 1 : 0;
    if (quiet < quietPolls) await sleep(pollMs);
  }
}

function validateRequest(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('Unsupported queued switch request.');
  if (value.provider !== 'codex' && value.provider !== 'claude') throw new Error('Unsupported queued switch provider.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value.accountId || ''))) {
    throw new Error('Invalid queued switch account id.');
  }
  return value;
}

function completedResult(request, success, extra = {}) {
  return {
    schemaVersion: 1,
    id: request?.id,
    provider: request?.provider,
    accountId: request?.accountId,
    accountLabel: request?.accountLabel,
    success,
    completedAt: new Date().toISOString(),
    ...extra
  };
}

async function writeResult(filePath, result) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function relaunchEditor(relaunch, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(relaunch.executable, relaunch.args || [], {
      cwd: relaunch.cwd || undefined,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false,
      env: editorEnvironment(process.env)
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

if (require.main === module) {
  main().then((result) => {
    process.exitCode = result?.success ? 0 : 1;
  });
}

module.exports = {
  completedResult,
  isProcessRunning,
  main,
  relaunchEditor,
  validateRequest,
  waitForProviderStop,
  writeResult
};
