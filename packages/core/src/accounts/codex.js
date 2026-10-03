import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, readJson, writeFileAtomic } from '../fs-utils.js';
import { accountDir, listAccounts, updateAccount } from './store.js';
import { refreshCodexToken } from './codex-oauth.js';
import { validateCodexCredentialPayload } from './provider-contracts.js';
import { assertAgentStopped } from './processes.js';

export const CODEX_PROVIDER = 'codex';

// Multi-account Codex is multi-directory Codex. The CLI keeps its identity in
// `auth.json` under whatever CODEX_HOME points at, so giving each account its
// own home lets every subscription stay signed in at once - no swapping, no
// re-login, and no risk of one switch interrupting another session's token
// refresh.
export function codexHome(accountId, options = {}) {
  return path.join(accountDir(accountId, options), 'codex-home');
}

export function defaultCodexHome(options = {}) {
  return options.defaultCodexHome || process.env.CODEX_HOME || path.join(options.home || os.homedir(), '.codex');
}

export function codexAuthPath(home) {
  return path.join(home, 'auth.json');
}

// `codex` refuses to start when CODEX_HOME names a directory that does not
// exist - it will not create one - so the directory has to be in place before
// any process is launched against it, including the login itself.
export async function ensureCodexHome(accountId, options = {}) {
  const home = codexHome(accountId, options);
  await ensureDir(home);
  return home;
}

// The environment a spawned `codex` process needs to act as this account.
export function codexEnv(accountId, options = {}) {
  return { CODEX_HOME: codexHome(accountId, options) };
}

export async function readCodexAuth(home) {
  const file = codexAuthPath(home);
  if (!(await pathExists(file))) return null;

  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }
  validateCodexCredentialPayload(raw);

  const tokens = raw.tokens || {};
  return {
    path: file,
    apiKey: raw.OPENAI_API_KEY || raw.openai_api_key,
    accessToken: tokens.access_token || tokens.accessToken,
    refreshToken: tokens.refresh_token || tokens.refreshToken,
    idToken: tokens.id_token || tokens.idToken,
    accountId: tokens.account_id || tokens.accountId,
    lastRefresh: raw.last_refresh || raw.lastRefresh,
    claims: decodeJwtClaims(tokens.id_token || tokens.idToken)
  };
}

export async function isSignedIn(accountId, options = {}) {
  const auth = await readCodexAuth(codexHome(accountId, options));
  return Boolean(auth?.accessToken || auth?.apiKey);
}

// Copy an existing login into an account home. Used for "I already ran
// `codex login`, adopt that" rather than making the user sign in again.
export async function importCodexAuth(accountId, sourceHome, options = {}) {
  const source = codexAuthPath(sourceHome);
  if (!(await pathExists(source))) {
    throw new Error(`No Codex login found at ${source}. Run \`codex login\` first, or pick another directory.`);
  }
  const sourceAuth = await readCodexAuth(sourceHome);
  if (!sourceAuth?.accessToken && !sourceAuth?.apiKey) {
    throw new Error(`The Codex credential at ${source} has no usable login.`);
  }
  const target = codexHome(accountId, options);
  await ensureDir(target);
  await copyCredential(source, codexAuthPath(target));

  const auth = await readCodexAuth(target);
  await updateAccount(
    accountId,
    { email: auth?.claims?.email, plan: auth?.claims?.plan, signedInAt: new Date().toISOString() },
    options
  );
  return auth;
}

// Sixty seconds of slack, matching the Claude path: a token that lapses while
// the request is in flight is indistinguishable from one already dead.
const EXPIRY_SKEW_MS = 60 * 1000;

// Read the expiry out of an access token. It is a JWT whose payload carries a
// standard `exp` in seconds; we decode, never verify, since this only decides
// whether to refresh.
export function codexAccessTokenExpiry(accessToken) {
  const part = String(accessToken || '').split('.')[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// Is this account the one the live Codex is using right now?
//
// It matters because that account's refresh token is also sitting in the default
// home, where the real Codex CLI will rotate it on its own next use. If Context
// Bridge refreshed it too, one of the two would present an already-used token
// and the server would revoke the pair. So the active account is left alone; the
// live tooling keeps it fresh, and only genuinely idle accounts are renewed here.
export async function isActiveCodexAccount(accountId, options = {}) {
  const live = await readCodexAuth(defaultCodexHome(options));
  if (!live?.refreshToken && !live?.accessToken && !live?.apiKey) return false;
  const auth = await readCodexAuth(codexHome(accountId, options));
  return sameCodexIdentity(live, auth);
}

// Copy the credential owned by the live Codex process back into Turntrail's
// managed snapshot. This does not refresh anything: it only preserves token
// rotations Codex has already completed, so a later switch does not reinstall
// an older refresh token.
export async function syncActiveCodexAccount(accountId, options = {}) {
  if (!(await isActiveCodexAccount(accountId, options))) return false;

  const source = codexAuthPath(defaultCodexHome(options));
  const contents = await fs.readFile(source, 'utf8');
  let credential;
  try {
    credential = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${source}: ${error.message}`);
  }
  validateCodexCredentialPayload(credential);
  const tokens = credential.tokens || {};
  const exact = {
    apiKey: credential.OPENAI_API_KEY || credential.openai_api_key,
    accessToken: tokens.access_token || tokens.accessToken,
    refreshToken: tokens.refresh_token || tokens.refreshToken,
    accountId: tokens.account_id || tokens.accountId,
    claims: decodeJwtClaims(tokens.id_token || tokens.idToken)
  };
  const managed = await readCodexAuth(codexHome(accountId, options));
  if (!sameCodexIdentity(exact, managed)) return false;
  await writeFileAtomic(codexAuthPath(codexHome(accountId, options)), contents, { mode: 0o600 });
  return true;
}

// Access and refresh tokens both rotate. Prefer identifiers that survive those
// rotations, and use token equality only for older credentials that carry no
// stable identity fields.
function sameCodexIdentity(left, right) {
  if (!left || !right) return false;
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (left.claims?.sub && right.claims?.sub) return left.claims.sub === right.claims.sub;
  if (left.refreshToken && right.refreshToken) return left.refreshToken === right.refreshToken;
  if (left.apiKey && right.apiKey) return left.apiKey === right.apiKey;
  return Boolean(left.accessToken && right.accessToken && left.accessToken === right.accessToken);
}

// Merge refreshed tokens back into an account's stored auth.json, preserving the
// on-disk shape Codex expects and everything we are not replacing.
export async function writeCodexTokens(home, tokens, options = {}) {
  const file = codexAuthPath(home);
  let current = {};
  if (await pathExists(file)) {
    try {
      current = await readJson(file);
    } catch {
      current = {};
    }
  }
  const merged = {
    ...current,
    tokens: {
      ...(current.tokens || {}),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      ...(tokens.idToken ? { id_token: tokens.idToken } : {})
    },
    last_refresh: new Date().toISOString()
  };
  validateCodexCredentialPayload(merged);
  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // POSIX modes are a no-op on Windows.
  }
  return readCodexAuth(home);
}

// A usable access token for an account, renewed if it has expired.
//
// Mirrors ensureClaudeAccessToken so the panel can show quota for every
// subscription, not just the active one - the whole point of listing them. The
// one difference is the guard above: the account the live Codex owns is never
// refreshed here, because the two refreshing the same rotating token would
// revoke it. That account stays fresh through normal Codex use instead.
export async function ensureCodexAccessToken(accountId, options = {}) {
  const home = codexHome(accountId, options);
  const auth = await readCodexAuth(home);
  if (!auth?.accessToken) return auth;

  const expiresAt = codexAccessTokenExpiry(auth.accessToken);
  const skew = Number.isFinite(options.refreshSkewMs) ? options.refreshSkewMs : EXPIRY_SKEW_MS;
  const fresh = !Number.isFinite(expiresAt) || expiresAt - skew > Date.now();
  if ((fresh && !options.forceRefresh) || options.offline) return auth;
  if (!auth.refreshToken) {
    if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= Date.now()) {
      const error = new Error('This Codex login has expired and has no refresh token. Sign in again.');
      error.code = 'AUTH_EXPIRED';
      throw error;
    }
    return auth;
  }

  // Refreshing the live account would race Codex for its rotating token.
  if (!options.allowActiveRefresh && (await isActiveCodexAccount(accountId, options))) return auth;

  const tokens = await refreshCodexToken(auth.refreshToken, options);
  const updated = await writeCodexTokens(home, tokens, options);
  await updateAccount(accountId, { lastRefreshedAt: new Date().toISOString() }, options).catch(() => {});
  return updated;
}

// Point the *official* Codex CLI and VS Code extension at this account by
// writing its credential into the default home. This is the one operation that
// is machine-global rather than per-session: the official tooling reads only
// the default directory, so making an account "default" is the only way to
// reach it. The previous credential is kept beside it so the swap is reversible.
export async function activateCodexAccount(accountId, options = {}) {
  if (!(await pathExists(codexAuthPath(codexHome(accountId, options))))) {
    throw new Error(`Account "${accountId}" is not signed in yet.`);
  }

  const target = defaultCodexHome(options);
  await ensureDir(target);
  const targetAuth = codexAuthPath(target);

  const accounts = await listAccounts({ ...options, provider: CODEX_PROVIDER });
  const outgoing = await activeCodexAccountId(accounts, options);
  const alreadyActive = outgoing === accountId;
  await assertAgentStopped(CODEX_PROVIDER, options);

  // Capture whatever the live Codex has been refreshing back into its own
  // account's snapshot before we overwrite it. Without this, every token Codex
  // rotated while the account was active is lost the moment you switch away,
  // and switching back later installs a stale credential - which is exactly the
  // failure that made a just-switched account come up expired.
  if (await pathExists(targetAuth)) {
    if (outgoing && outgoing !== accountId) {
      await copyCredential(targetAuth, codexAuthPath(codexHome(outgoing, options)));
    }
  }

  // Renew the incoming account before installing it, so a switch never lands on
  // an expired token. Safe to refresh here: the account is not active yet, so
  // nothing else is rotating its refresh token. If renewal is impossible - the
  // saved login has lapsed past recovery - report it rather than silently
  // installing a dead credential.
  let incoming = await readCodexAuth(codexHome(accountId, options));
  const incomingExpiry = codexAccessTokenExpiry(incoming?.accessToken);
  const canVerifyOauth = Boolean(
    incoming?.accessToken && incoming?.refreshToken && Number.isFinite(incomingExpiry)
  );
  incoming = await ensureCodexAccessToken(accountId, {
    ...options,
    // A JWT can remain locally unexpired after OpenAI has revoked its login.
    // Rotating an inactive account's refresh token proves the saved session is
    // still accepted before it replaces the live Codex credential.
    forceRefresh: canVerifyOauth,
    // Reapplying an account after signing in again is safe only after the
    // process guard above confirms Codex has stopped owning this token.
    allowActiveRefresh: alreadyActive
  });
  if (!incoming?.accessToken && !incoming?.apiKey) throw new Error(`Account "${accountId}" is not signed in yet.`);
  const expiresAt = codexAccessTokenExpiry(incoming.accessToken);
  if (incoming.accessToken && Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= Date.now()) {
    throw new Error(`Account "${accountId}" has expired and cannot be renewed. Sign in again.`);
  }

  let backup;
  if (await pathExists(targetAuth)) {
    backup = path.join(target, 'auth.turntrail-backup.json');
    await fs.copyFile(targetAuth, backup);
  }

  await assertAgentStopped(CODEX_PROVIDER, options);
  await copyCredential(codexAuthPath(codexHome(accountId, options)), targetAuth);
  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
  return { target: targetAuth, backup, alreadyActive };
}

export async function purgeActiveCodexAccount(accountId, options = {}) {
  if (!(await isActiveCodexAccount(accountId, options))) return false;
  await assertAgentStopped(CODEX_PROVIDER, options);
  await fs.rm(codexAuthPath(defaultCodexHome(options)), { force: true });
  return true;
}

// auth.json is a live credential. Write it 0600 so activating an account does
// not quietly widen its permissions; on Windows the mode is ignored, which is
// why this is best-effort rather than load-bearing.
async function copyCredential(source, target) {
  const contents = await fs.readFile(source, 'utf8');
  await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
}

// Adopt a login copied from another machine.
//
// The official docs list this as the way to authenticate a host that cannot run
// any of the interactive flows: sign in somewhere with a browser, then bring
// the credential across. Validation is strict about the shape but says exactly
// what is wrong, because the usual mistakes - pasting the wrong file, pasting a
// fragment, pasting a bare token - are all indistinguishable from "it failed".
export function parseCodexAuthText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Paste the contents of an auth.json file.');

  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    const hint = /^[A-Za-z0-9._-]+$/.test(trimmed)
      ? ' That looks like a bare token: use the access-token option instead, or paste the whole auth.json file.'
      : '';
    throw new Error(`That is not valid JSON.${hint}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('An auth.json holds a JSON object.');
  }

  const tokens = value.tokens || {};
  const hasOauth = typeof (tokens.access_token || tokens.accessToken) === 'string';
  const hasApiKey = typeof (value.OPENAI_API_KEY || value.openai_api_key) === 'string';
  if (!hasOauth && !hasApiKey) {
    throw new Error('This is JSON, but not a Codex auth.json: it has no tokens.access_token and no OPENAI_API_KEY.');
  }
  return value;
}

export async function importCodexAuthText(accountId, text, options = {}) {
  const value = parseCodexAuthText(text);
  const home = await ensureCodexHome(accountId, options);
  // Same 0600 treatment the credential gets everywhere else.
  await fs.writeFile(codexAuthPath(home), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(codexAuthPath(home), 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
  return refreshCodexAccountIdentity(accountId, options);
}

// After a login completes, read back who signed in so the panel can label the
// subscription without asking. Returns null when no credential was written,
// which is how a cancelled or failed login is detected.
export async function refreshCodexAccountIdentity(accountId, options = {}) {
  const auth = await readCodexAuth(codexHome(accountId, options));
  if (!auth?.accessToken) return null;
  await updateAccount(
    accountId,
    { email: auth.claims?.email, plan: auth.claims?.plan, signedInAt: new Date().toISOString() },
    options
  );
  return auth;
}

// Which registered account the official Codex CLI and VS Code extension are
// currently using. They read only the default home, so "active" means "the
// credential sitting in that directory matches this account's".
//
// Prefer the provider account id because both access and refresh tokens rotate.
// Older auth files without a stable identity still fall back to token equality.
export async function activeCodexAccountId(accounts, options = {}) {
  const current = await readCodexAuth(defaultCodexHome(options));
  if (!current) return undefined;

  for (const account of accounts) {
    const auth = await readCodexAuth(codexHome(account.id, options));
    if (sameCodexIdentity(current, auth)) return account.id;
  }
  return undefined;
}

// Put back whatever `activateCodexAccount` displaced.
export async function restoreCodexBackup(options = {}) {
  const target = defaultCodexHome(options);
  const canonical = path.join(target, 'auth.turntrail-backup.json');
  const legacy = path.join(target, 'auth.context-bridge-backup.json');
  const backup = (await pathExists(canonical)) ? canonical : (await pathExists(legacy)) ? legacy : undefined;
  if (!backup) throw new Error('No Turntrail backup to restore.');
  await assertAgentStopped(CODEX_PROVIDER, options);
  await copyCredential(backup, codexAuthPath(target));
  return { restored: codexAuthPath(target) };
}

// The id_token is a JWT. We read its payload purely to label the account in the
// UI - never to make a trust decision - so it is decoded, not verified.
export function decodeJwtClaims(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const auth = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || payload.preferred_username,
      plan: auth.chatgpt_plan_type || auth.chatgptPlanType,
      accountId: auth.chatgpt_account_id || auth.chatgptAccountId
    };
  } catch {
    return undefined;
  }
}
