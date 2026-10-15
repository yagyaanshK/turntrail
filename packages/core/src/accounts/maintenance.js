import path from 'node:path';
import { withFileLock } from '../fs-utils.js';
import {
  activateCodexAccount,
  codexHome,
  ensureCodexAccessToken,
  isActiveCodexAccount,
  readCodexAuth,
  syncActiveCodexAccount
} from './codex.js';
import {
  CLAUDE_PROACTIVE_REFRESH_MS,
  claudeMaintenanceAccountId,
  claudeHome,
  ensureClaudeAccessToken,
  isActiveClaudeAccount,
  maintainIdleClaudeLogin,
  readClaudeAuth,
  syncActiveClaudeAccount
} from './claude.js';
import { getClaudeUsage, getCodexUsage, recordAuthenticationFailure } from './quota.js';
import { deadLogin, deadLoginError } from './renewals.js';
import { listAgentProcesses, matchingAgentProcesses } from './processes.js';
import { accountsRoot, listAccounts } from './store.js';

export const DEFAULT_ACCOUNT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_ACCOUNT_MAINTENANCE_LOCK_TIMEOUT_MS = 100;
export const DEFAULT_ACCOUNT_MAINTENANCE_LOCK_STALE_MS = 60 * 60 * 1000;

export function accountMaintenanceLockPath(options = {}) {
  return path.join(accountsRoot(options), 'account-maintenance');
}

// Refresh due OAuth credentials and update quota caches for all managed
// accounts. A machine-wide lock prevents several editor windows or an OS
// scheduler from rotating the same refresh token concurrently.
export async function maintainAccounts(options = {}) {
  const startedAt = new Date().toISOString();
  try {
    return await withFileLock(
      accountMaintenanceLockPath(options),
      async () => {
        const all = await listAccounts(options);
        // `accountIds` maintains just those, as a card's "Try again" does.
        // Which Claude account owns the live login is still worked out from
        // all of them.
        const accounts = options.accountIds ? all.filter((account) => options.accountIds.includes(account.id)) : all;
        const claudeAccounts = all.filter((account) => account.provider === 'claude');
        let observedAgentProcesses = options.agentProcesses;
        let claudeRunning = false;
        let codexRunning = false;
        let maintainedClaudeAccountId;
        if (accounts.length > 0) {
          observedAgentProcesses = await listAgentProcesses(options);
          claudeRunning = matchingAgentProcesses('claude', observedAgentProcesses).length > 0;
          codexRunning = matchingAgentProcesses('codex', observedAgentProcesses).length > 0;
          if (claudeAccounts.length > 0 && !claudeRunning) {
            maintainedClaudeAccountId = await claudeMaintenanceAccountId(claudeAccounts, options);
          }
        }

        const results = [];
        for (const account of accounts) {
          options.signal?.throwIfAborted();
          results.push(await maintainAccount(account, {
            ...options,
            renewalSource: options.renewalSource || 'maintenance',
            observedAgentProcesses,
            claudeRunning,
            codexRunning,
            maintainedClaudeAccountId
          }));
        }
        return {
          startedAt,
          completedAt: new Date().toISOString(),
          locked: false,
          results
        };
      },
      {
        ...options,
        lockTimeoutMs: options.maintenanceLockTimeoutMs ?? DEFAULT_ACCOUNT_MAINTENANCE_LOCK_TIMEOUT_MS,
        lockStaleMs: options.maintenanceLockStaleMs ?? DEFAULT_ACCOUNT_MAINTENANCE_LOCK_STALE_MS
      }
    );
  } catch (error) {
    if (/Timed out waiting for storage lock:/.test(error.message)) {
      return {
        startedAt,
        completedAt: new Date().toISOString(),
        locked: true,
        results: []
      };
    }
    throw error;
  }
}

// One account's failure is that account's result, never the end of the run:
// every account after it still has to be kept alive.
async function maintainAccount(account, options) {
  try {
    if (account.provider === 'codex') return await maintainCodexAccount(account, options);
    if (account.provider === 'claude') return await maintainClaudeAccount(account, options);
    return result(account, 'skipped', { reason: 'unsupported-provider' });
  } catch (error) {
    if (error?.code === 'AUTH_EXPIRED') return signInRequired(account, error, options);
    return result(account, 'failed', { error: error.message });
  }
}

// A login whose refresh token the provider has already refused is not sent
// again, here or anywhere: the answer cannot change until a new sign-in.
async function knownDeadLogin(account, auth, options) {
  const dead = await deadLogin(account.id, auth?.refreshToken, options);
  return dead ? signInRequired(account, deadLoginError(dead), options) : undefined;
}

async function signInRequired(account, error, options) {
  await recordAuthenticationFailure(
    account.id,
    { code: 'AUTH_EXPIRED', reason: error.reason, message: error.message },
    options
  ).catch(() => {});
  return result(account, 'sign-in-required', { reason: error.reason, error: error.message });
}

async function maintainCodexAccount(account, options) {
  const before = await readCodexAuth(codexHome(account.id, options));
  if (before?.apiKey) return result(account, 'skipped', { reason: 'api-key' });
  if (!before?.accessToken) return result(account, 'skipped', { reason: 'not-signed-in' });
  const dead = await knownDeadLogin(account, before, options);
  if (dead) return dead;

  const active = await isActiveCodexAccount(account.id, options);
  const synchronizedActive = active ? await syncActiveCodexAccount(account.id, options) : false;
  const synchronized = await readCodexAuth(codexHome(account.id, options));
  let usage = await getCodexUsage(account.id, maintenanceUsageOptions(options));
  let revalidated = false;
  if (usage?.requiresRevalidation) {
    if (active && options.codexRunning) {
      return result(account, 'deferred', {
        active: true,
        refreshed: false,
        synchronized: synchronizedActive && credentialChanged(before, synchronized),
        reason: 'codex-running'
      });
    }
    if (active) {
      await activateCodexAccount(account.id, options);
    } else {
      await ensureCodexAccessToken(account.id, { ...options, forceRefresh: true });
    }
    usage = await getCodexUsage(account.id, maintenanceUsageOptions(options));
    revalidated = true;
  }
  const after = await readCodexAuth(codexHome(account.id, options));
  return usageResult(account, usage, {
    active,
    refreshed: credentialChanged(synchronized, after),
    synchronized: synchronizedActive && credentialChanged(before, synchronized),
    revalidated
  });
}

async function maintainClaudeAccount(account, options) {
  const before = await readClaudeAuth(claudeHome(account.id, options), options);
  if (!before?.accessToken) return result(account, 'skipped', { reason: 'not-signed-in' });
  const dead = await knownDeadLogin(account, before, options);
  if (dead) return dead;

  if (!options.claudeRunning && options.maintainedClaudeAccountId === account.id) {
    const maintained = await maintainIdleClaudeLogin(account.id, options);
    let usage = await getClaudeUsage(account.id, maintenanceUsageOptions(options));
    let revalidated = false;
    let details = maintained;
    if (usage?.requiresRevalidation) {
      details = await maintainIdleClaudeLogin(account.id, { ...options, forceRefresh: true });
      usage = await getClaudeUsage(account.id, maintenanceUsageOptions(options));
      revalidated = true;
    }
    return usageResult(account, usage, { ...details, revalidated });
  }

  const active = await isActiveClaudeAccount(account.id, options);
  const synchronizedActive = active ? await syncActiveClaudeAccount(account.id, options) : false;
  const synchronized = await readClaudeAuth(claudeHome(account.id, options), options);
  const expiresAt = Number(synchronized?.expiresAt);
  if (
    active &&
    options.claudeRunning &&
    Number.isFinite(expiresAt) &&
    expiresAt - CLAUDE_PROACTIVE_REFRESH_MS <= Date.now()
  ) {
    return result(account, 'deferred', {
      active: true,
      refreshed: false,
      synchronized: synchronizedActive && credentialChanged(before, synchronized),
      reason: 'claude-running'
    });
  }
  let usage = await getClaudeUsage(account.id, maintenanceUsageOptions(options));
  let revalidated = false;
  if (usage?.requiresRevalidation) {
    if (active && options.claudeRunning) {
      return result(account, 'deferred', {
        active: true,
        refreshed: false,
        synchronized: synchronizedActive && credentialChanged(before, synchronized),
        reason: 'claude-running'
      });
    }
    await ensureClaudeAccessToken(account.id, { ...options, forceRefresh: true });
    usage = await getClaudeUsage(account.id, maintenanceUsageOptions(options));
    revalidated = true;
  }
  const after = await readClaudeAuth(claudeHome(account.id, options), options);
  return usageResult(account, usage, {
    active,
    refreshed: credentialChanged(synchronized, after),
    synchronized: synchronizedActive && credentialChanged(before, synchronized),
    revalidated
  });
}

function maintenanceUsageOptions(options) {
  return {
    ...options,
    allowActiveRefresh: false,
    force: true,
    offline: false
  };
}

function credentialChanged(before, after) {
  return Boolean(
    before &&
      after &&
      (before.accessToken !== after.accessToken || before.refreshToken !== after.refreshToken)
  );
}

function usageResult(account, usage, details) {
  if (usage?.requiresSignIn) {
    return result(account, 'sign-in-required', {
      ...details,
      reason: usage.authenticationReason,
      error: usage.error || usage.staleReason
    });
  }
  if (usage?.error) return result(account, 'failed', { ...details, error: usage.error });
  if (usage?.staleReason) return result(account, 'stale', { ...details, error: usage.staleReason });
  return result(account, details.refreshed ? 'refreshed' : 'checked', details);
}

function result(account, status, details = {}) {
  return {
    accountId: account.id,
    provider: account.provider,
    status,
    ...details
  };
}
