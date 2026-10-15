import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, withFileLock, writeJson } from '../fs-utils.js';
import { accountDir } from './store.js';

// Every renewal of a saved login goes through here.
//
// Both providers rotate the refresh token on each renewal and treat the one
// presented as spent, so a login dies the moment two things renew it from the
// same token, or a renewal is sent and its answer never saved. Turntrail runs
// in several places at once - every editor window, VS Code beside Kiro or
// Cursor, the CLI, a scheduler - and each can decide on its own that an idle
// account is due. So a renewal takes a per-account lock that all of them share,
// re-reads the login once it holds it, and renews only if nobody else just did.
//
// Each attempt is also written down: when it started, how it ended, and short
// fingerprints of the refresh token it spent and the one it got. Never a token.
// The record answers "why did this login die" after the fact, and it lets a
// refresh token the provider already refused never be sent again.

const JOURNAL = 'renewals.json';
const LOCK = 'renewal';
const KEEP = 50;
// Another process's renewal of the same login within this long is reused, not
// repeated.
export const RECENT_RENEWAL_MS = 2 * 60 * 1000;
// Long enough to sit out one renewal request in another window, including its
// own timeout, so a panel read waits for it rather than racing it.
const LOCK_TIMEOUT_MS = 75 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;
// Renewals are sent with their own, longer timeout: abandoning one that the
// provider may already have honoured spends the refresh token for nothing.
export const RENEWAL_TIMEOUT_MS = 60 * 1000;

export function renewalJournalPath(accountId, options = {}) {
  return path.join(accountDir(accountId, options), JOURNAL);
}

export function tokenFingerprint(token) {
  if (!token) return undefined;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

export async function readRenewals(accountId, options = {}) {
  try {
    const journal = await readJson(renewalJournalPath(accountId, options));
    return Array.isArray(journal?.renewals) ? journal.renewals : [];
  } catch {
    return [];
  }
}

// The provider's refusal of this exact refresh token, if one is on record. A
// new sign-in brings a new token, so it is never mistaken for the dead one.
export async function deadLogin(accountId, refreshToken, options = {}) {
  const fingerprint = tokenFingerprint(refreshToken);
  if (!fingerprint) return undefined;
  const renewals = await readRenewals(accountId, options);
  const entry = renewals.findLast((item) => item.from === fingerprint && item.outcome === 'dead');
  return entry ? { at: entry.finishedAt || entry.at, reason: entry.reason, message: entry.message } : undefined;
}

export function deadLoginError(dead) {
  const error = new Error(dead.message || 'This login can no longer be renewed. Sign in again.');
  error.code = 'AUTH_EXPIRED';
  if (dead.reason) error.reason = dead.reason;
  return error;
}

// Renew `seen`, the login the caller read and found due, unless someone else
// already has. `read` returns the login as it is on disk now; `renew` spends
// its refresh token and saves the result, returning the saved login.
export async function renewLogin(accountId, steps, options = {}) {
  const { provider, seen, read, renew } = steps;
  return withFileLock(
    path.join(accountDir(accountId, options), LOCK),
    async () => {
      const current = (await read()) || seen;
      // Renewed, or signed in again, while this caller waited or since it read.
      if (current?.refreshToken && seen?.refreshToken && current.refreshToken !== seen.refreshToken) return current;

      const renewals = await readRenewals(accountId, options);
      const from = tokenFingerprint(current?.refreshToken);
      const dead = renewals.findLast((item) => item.from === from && item.outcome === 'dead');
      if (dead) throw deadLoginError({ reason: dead.reason, message: dead.message });

      // Someone renewed to exactly this token moments ago; whatever made this
      // caller want another renewal, the login is as new as it gets.
      const recent = renewals.findLast((item) => item.to === from && item.outcome === 'renewed');
      const now = (options.now || Date.now)();
      if (recent && now - Date.parse(recent.finishedAt) < RECENT_RENEWAL_MS) return current;

      const entry = {
        at: new Date(now).toISOString(),
        provider,
        source: options.renewalSource || 'turntrail',
        pid: process.pid,
        // Which program asked: Code.exe, Kiro.exe, node for the CLI.
        app: path.basename(process.execPath),
        from,
        outcome: 'started'
      };
      await writeRenewals(accountId, [...settle(renewals, now), entry], options);
      try {
        const renewed = await renew(current, {
          ...options,
          // A closing window must not abandon a renewal halfway (see above).
          signal: undefined,
          requestTimeoutMs: options.renewalTimeoutMs ?? RENEWAL_TIMEOUT_MS
        });
        Object.assign(entry, { outcome: 'renewed', to: tokenFingerprint(renewed?.refreshToken), finishedAt: new Date().toISOString() });
        return renewed;
      } catch (error) {
        Object.assign(entry, failure(error), { finishedAt: new Date().toISOString() });
        throw error;
      } finally {
        await writeRenewals(accountId, [...settle(renewals, now), entry], options).catch(() => {});
      }
    },
    { lockTimeoutMs: options.renewalLockTimeoutMs ?? LOCK_TIMEOUT_MS, lockStaleMs: LOCK_STALE_MS }
  );
}

function failure(error) {
  if (error?.code === 'AUTH_EXPIRED') {
    return { outcome: 'dead', reason: safeCode(error.reason) || 'AUTH_EXPIRED', message: error.message };
  }
  // The request may have reached the provider; whether it rotated the token
  // is unknown, which is worth knowing if the next renewal is refused.
  if (error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') {
    return { outcome: 'interrupted', reason: error.code || 'aborted' };
  }
  return { outcome: 'failed', reason: safeCode(error?.code) || 'error' };
}

// A renewal still marked as started long after its lock went stale belongs to
// a process that exited before the answer arrived.
function settle(renewals, now) {
  return renewals.map((item) =>
    item.outcome === 'started' && now - Date.parse(item.at) > LOCK_STALE_MS
      ? { ...item, outcome: 'interrupted', reason: 'process-exited' }
      : item
  );
}

async function writeRenewals(accountId, renewals, options) {
  await writeJson(renewalJournalPath(accountId, options), { renewals: renewals.slice(-KEEP) });
}

function safeCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}
