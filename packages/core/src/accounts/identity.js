import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock, writeJson } from '../fs-utils.js';
import { accountsRoot, listAccounts, readRegistry, registryPath, writeRegistry } from './store.js';

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// Email alone is not an account key: one person may belong to several workspaces.
export function sameAccountIdentity(provider, left, right) {
  if (!left || !right) return false;
  if (provider === 'codex') {
    if (nonempty(left.apiKey) || nonempty(right.apiKey)) {
      return Boolean(nonempty(left.apiKey) && left.apiKey === right.apiKey);
    }
    const a = nonempty(left.accountId) || nonempty(left.claims?.accountId);
    const b = nonempty(right.accountId) || nonempty(right.claims?.accountId);
    const userA = nonempty(left.claims?.sub);
    const userB = nonempty(right.claims?.sub);
    if (a && b && a !== b) return false;
    if (userA && userB && userA !== userB) return false;
    if (a && b) return true;
  } else if (provider === 'claude') {
    const orgA = nonempty(left.organizationUuid);
    const orgB = nonempty(right.organizationUuid);
    const userA = nonempty(left.profile?.accountUuid);
    const userB = nonempty(right.profile?.accountUuid);
    if (orgA && orgB && orgA !== orgB) return false;
    if (userA && userB && userA !== userB) return false;
    const emailA = nonempty(left.email)?.toLowerCase();
    const emailB = nonempty(right.email)?.toLowerCase();
    if (emailA && emailB && emailA !== emailB && !(userA && userB)) return false;
    if (orgA && orgB && ((userA && userB) || (emailA && emailB && emailA === emailB))) return true;
  } else {
    return false;
  }
  return ['refreshToken', 'accessToken', 'apiKey'].some((key) =>
    nonempty(left[key]) && left[key] === right[key]
  );
}

async function readAccountAuth(account, options) {
  if (account.provider === 'codex') {
    const { readCodexAuth, codexHome } = await import('./codex.js');
    return readCodexAuth(codexHome(account.id, options));
  }
  if (account.provider === 'claude') {
    const { readClaudeAuth, claudeHome } = await import('./claude.js');
    return readClaudeAuth(claudeHome(account.id, options), options);
  }
  throw new Error('Duplicate-account checks support Codex and Claude only.');
}

// All managed sign-in writers share this lock, including imports in another window.
export async function withUniqueAccountIdentity(id, provider, auth, save, options = {}) {
  return withFileLock(path.join(accountsRoot(options), 'account-sign-in'), async () => {
    const accounts = await listAccounts(options);
    if (!accounts.some((account) => account.id === id && account.provider === provider)) {
      throw new Error('The sign-in target does not match a registered provider account.');
    }
    for (const account of accounts) {
      if (account.id === id || account.provider !== provider) continue;
      let other;
      try {
        other = await readAccountAuth(account, options);
      } catch {
        throw new Error(`Could not check stored ${provider} accounts for duplicates. Repair or remove the unreadable account before adding another login.`);
      }
      if (!sameAccountIdentity(provider, auth, other)) continue;
      const error = new Error(
        `This ${provider === 'codex' ? 'Codex' : 'Claude'} account is already connected as "${account.label}". ` +
        'Use its existing card, or choose "Sign in to existing account" to renew its login. The existing login was not changed.'
      );
      error.code = 'DUPLICATE_ACCOUNT';
      error.existingAccountId = account.id;
      throw error;
    }
    return save();
  }, options);
}

// Explicit repair only: retain both credential trees and back up the registry.
// Different OAuth sessions need a user decision, never an automatic token merge.
export async function consolidateDuplicateAccount(keepId, duplicateId, options = {}) {
  if (keepId === duplicateId) throw new Error('Choose two different accounts to consolidate.');
  return withFileLock(path.join(accountsRoot(options), 'account-maintenance'), () =>
    withFileLock(path.join(accountsRoot(options), 'account-sign-in'), () =>
      withFileLock(registryPath(options), async () => {
        const registry = await readRegistry(options);
        const keep = registry.accounts.find((a) => a.id === keepId);
        const duplicate = registry.accounts.find((a) => a.id === duplicateId);
        if (!keep || !duplicate || keep.provider !== duplicate.provider) {
          throw new Error('Both accounts must exist and use the same provider.');
        }
        const left = await readAccountAuth(keep, options);
        const right = await readAccountAuth(duplicate, options);
        if (!sameAccountIdentity(keep.provider, left, right)) {
          throw new Error('These accounts do not have the same confirmed provider identity.');
        }
        const leftBytes = await fs.readFile(left.path);
        const rightBytes = await fs.readFile(right.path);
        if (!leftBytes.equals(rightBytes)) {
          throw new Error('The stored credentials differ. Keep both entries until you choose which login to retain.');
        }
        const backup = path.join(accountsRoot(options), 'account-backups', randomUUID(), 'accounts.json');
        await writeJson(backup, registry);
        registry.accounts = registry.accounts.filter((a) => a.id !== duplicateId);
        await writeRegistry(registry, options);
        return { keptId: keepId, removedId: duplicateId, backup, credentialsPreserved: true };
      }, options), options), options);
}
