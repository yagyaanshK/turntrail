import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, pathExists, readJson, writeFileAtomic, writeJson } from '../fs-utils.js';
import { accountDir, listAccounts, updateAccount } from './store.js';
import { fetchClaudeProfile, refreshClaudeToken } from './claude-oauth.js';
import { isProviderContractError, validateClaudeCredentialPayload } from './provider-contracts.js';
import { assertAgentStopped } from './processes.js';
import { carryClaudeRetention } from './claude-settings.js';

export const CLAUDE_PROVIDER = 'claude';
export const CLAUDE_PROACTIVE_REFRESH_MS = 4 * 60 * 60 * 1000;

// Same mechanism as Codex, different environment variable. Claude Code keeps
// its whole world - credential, config, project history - under
// CLAUDE_CONFIG_DIR, so one directory per account keeps every subscription
// signed in at once.
export function claudeHome(accountId, options = {}) {
  return path.join(accountDir(accountId, options), 'claude-home');
}

export function defaultClaudeHome(options = {}) {
  return (
    options.defaultClaudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(options.home || os.homedir(), '.claude')
  );
}

export function claudeCredentialsPath(home) {
  return path.join(home, '.credentials.json');
}

// Claude's config file is laid out asymmetrically, and getting this wrong means
// writing identity into a file nothing reads. With CLAUDE_CONFIG_DIR set, the
// config lives *inside* that directory. With the stock `~/.claude` home it sits
// beside it, at `~/.claude.json`. Verified on disk rather than assumed.
export function claudeConfigPath(home, options = {}) {
  const configured = options.defaultClaudeHome || process.env.CLAUDE_CONFIG_DIR;
  const stockHome = path.join(options.home || os.homedir(), '.claude');
  if (!configured && path.resolve(home) === path.resolve(stockHome)) {
    return path.join(options.home || os.homedir(), '.claude.json');
  }
  return path.join(home, '.claude.json');
}

export async function ensureClaudeHome(accountId, options = {}) {
  const home = claudeHome(accountId, options);
  await ensureDir(home);
  // Every launch as this account goes through here, and Claude reads its
  // settings from this directory alone. Carrying the user's chat retention in
  // keeps those chats from being swept after the 30-day default. It is a
  // protection, never a precondition, so a failure here blocks nothing.
  try {
    await carryClaudeRetention(accountId, options);
  } catch {
    // Retention is reported in the Accounts panel; the launch goes ahead.
  }
  return home;
}

// The environment a spawned `claude` needs to act as this account.
export function claudeEnv(accountId, options = {}) {
  return { CLAUDE_CONFIG_DIR: claudeHome(accountId, options) };
}

// Identity and credential live in two different files, so both are read. The
// credential alone cannot say who signed in: unlike Codex there is no JWT to
// decode, and the email is only ever recorded in the config.
export async function readClaudeAuth(home, options = {}) {
  const state = await readClaudeCredentialState(home);
  if (state.kind === 'missing') return null;
  const { file, raw } = state;

  const oauth = raw.claudeAiOauth || {};
  const profile = await readClaudeProfile(home, options);
  return {
    path: file,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    organizationUuid: raw.organizationUuid || profile?.organizationUuid,
    email: profile?.emailAddress,
    plan: claudePlan(oauth, profile),
    profile
  };
}

// Claude has shipped failure modes that leave the OAuth object present but its
// token strings blank. That state is repairable, unlike malformed JSON: no
// process can authenticate with it, and retaining it only forces another login.
async function readClaudeCredentialState(home) {
  const file = claudeCredentialsPath(home);
  if (!(await pathExists(file))) return { kind: 'missing', file };

  let raw;
  try {
    raw = await readJson(file);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }

  if (isBlankClaudeCredential(raw)) return { kind: 'blank', file, raw };
  validateClaudeCredentialPayload(raw);
  return { kind: raw.claudeAiOauth?.accessToken ? 'usable' : 'blank', file, raw };
}

function isBlankClaudeCredential(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.claudeAiOauth === undefined) return true;
  const oauth = raw.claudeAiOauth;
  return Boolean(
    oauth &&
      typeof oauth === 'object' &&
      !Array.isArray(oauth) &&
      !String(oauth.accessToken || '').trim() &&
      !String(oauth.refreshToken || '').trim()
  );
}

// The `oauthAccount` block Claude Code writes into its config: who is signed in,
// which organization, and on what plan.
export async function readClaudeProfile(home, options = {}) {
  const file = claudeConfigPath(home, options);
  if (!(await pathExists(file))) return undefined;
  try {
    const config = await readJson(file);
    return config?.oauthAccount;
  } catch {
    // A corrupt or half-written config must not make an account unreadable -
    // the credential is what actually matters.
    return undefined;
  }
}

function claudePlan(oauth, profile) {
  if (typeof oauth?.subscriptionType === 'string') return oauth.subscriptionType;
  const organizationType = profile?.organizationType;
  // `claude_pro` / `claude_max` name the plan with a redundant prefix.
  if (typeof organizationType === 'string') return organizationType.replace(/^claude[_-]/, '');
  return undefined;
}

export async function isClaudeSignedIn(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options);
  return Boolean(auth?.accessToken);
}

// Adopt the login already sitting in the stock config directory.
export async function importClaudeAuth(accountId, sourceHome, options = {}) {
  const source = claudeCredentialsPath(sourceHome);
  if (!(await pathExists(source))) {
    throw new Error(`No Claude login found at ${source}. Run \`claude\` and sign in first, or pick another directory.`);
  }
  const sourceAuth = await readClaudeAuth(sourceHome, options);
  if (!sourceAuth?.accessToken) throw new Error(`The Claude credential at ${source} has no usable login.`);

  const target = await ensureClaudeHome(accountId, options);
  await copyCredential(source, claudeCredentialsPath(target));

  // Carry the identity across too, otherwise the adopted account has a working
  // login that cannot be labelled with an email.
  const profile = await readClaudeProfile(sourceHome, options);
  if (profile) await writeClaudeProfile(claudeConfigPath(target, options), profile);

  return refreshClaudeAccountIdentity(accountId, options);
}

// Point the official Claude Code CLI and extension at this account.
//
// Two files, because Claude splits credential from identity: the token decides
// what works, the config decides which email the UI shows. Writing only the
// first leaves Claude Code displaying the previous account. Both are backed up
// before being replaced, and the config is patched at the `oauthAccount` key
// rather than overwritten - the rest of that file is project history and caches
// that have nothing to do with which account is in use.
export async function activateClaudeAccount(accountId, options = {}) {
  const source = claudeCredentialsPath(claudeHome(accountId, options));
  if (!(await pathExists(source))) {
    throw new Error(`Account "${accountId}" is not signed in yet.`);
  }

  const target = defaultClaudeHome(options);
  await ensureDir(target);
  const targetCredentials = claudeCredentialsPath(target);

  let outgoing;
  if (await pathExists(targetCredentials)) {
    const accounts = await listAccounts({ ...options, provider: CLAUDE_PROVIDER });
    outgoing = await activeClaudeAccountId(accounts, options);
  }

  if (outgoing === accountId) {
    await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
    return { target: targetCredentials, alreadyActive: true };
  }
  await assertAgentStopped(CLAUDE_PROVIDER, { ...options, allowGuarded: true });

  const profile = await readClaudeProfile(claudeHome(accountId, options), options);
  const config = claudeConfigPath(target, options);
  const preparedConfig = profile ? await claudeConfigWithProfile(config, profile) : undefined;

  // The official client refreshes the active credential in place. Capture that
  // live state before replacing it, otherwise switching away strands a stale
  // refresh token in the managed account.
  if (outgoing) {
    await copyCredential(targetCredentials, claudeCredentialsPath(claudeHome(outgoing, options)));
    const liveProfile = await readClaudeProfile(target, options);
    if (liveProfile) await writeClaudeProfile(claudeConfigPath(claudeHome(outgoing, options), options), liveProfile);
  }

  // Renew before touching the live home. If the incoming credential cannot be
  // renewed, leave the currently active account intact and ask for sign-in.
  const incoming = await ensureClaudeAccessToken(accountId, { ...options, allowActiveRefresh: true });
  if (!incoming?.accessToken) throw new Error(`Account "${accountId}" is not signed in yet.`);
  const expiresAt = Number(incoming.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS <= Date.now()) {
    throw new Error(`Account "${accountId}" has expired and cannot be renewed. Sign in again.`);
  }
  await assertAgentStopped(CLAUDE_PROVIDER, { ...options, allowGuarded: true });

  let backup;
  if (await pathExists(targetCredentials)) {
    backup = claudeCredentialsBackupPath(target);
    await fs.copyFile(targetCredentials, backup);
  }

  let configBackup;
  if (preparedConfig) {
    if (await pathExists(config)) {
      configBackup = claudeConfigBackupPath(config);
      await fs.copyFile(config, configBackup);
    }
  }
  await copyCredential(source, targetCredentials);
  if (preparedConfig) await writeJson(config, preparedConfig);

  await updateAccount(accountId, { lastUsedAt: new Date().toISOString() }, options);
  return { target: targetCredentials, backup, configBackup };
}

export async function purgeActiveClaudeAccount(accountId, options = {}) {
  if (!(await isActiveClaudeAccount(accountId, options))) return false;
  await assertAgentStopped(CLAUDE_PROVIDER, options);
  const target = defaultClaudeHome(options);
  const configPath = claudeConfigPath(target, options);
  const config = (await pathExists(configPath)) ? await readClaudeConfig(configPath) : undefined;
  if (config) delete config.oauthAccount;
  await fs.rm(claudeCredentialsPath(target), { force: true });
  if (config) await writeJson(configPath, config);
  return true;
}

export async function restoreClaudeBackup(options = {}) {
  const target = defaultClaudeHome(options);
  const backup = await firstExistingPath([
    claudeCredentialsBackupPath(target),
    legacyClaudeCredentialsBackupPath(target)
  ]);
  if (!backup) throw new Error('No Turntrail backup to restore.');
  await assertAgentStopped(CLAUDE_PROVIDER, { ...options, allowGuarded: true });
  await copyCredential(backup, claudeCredentialsPath(target));

  const config = claudeConfigPath(target, options);
  const configBackup = await firstExistingPath([
    claudeConfigBackupPath(config),
    legacyClaudeConfigBackupPath(config)
  ]);
  if (configBackup) await fs.copyFile(configBackup, config);

  return { restored: claudeCredentialsPath(target) };
}

function claudeCredentialsBackupPath(home) {
  return path.join(home, '.credentials.turntrail-backup.json');
}

function claudeConfigBackupPath(config) {
  return `${config}.turntrail-backup`;
}

function legacyClaudeCredentialsBackupPath(home) {
  return path.join(home, '.credentials.context-bridge-backup.json');
}

function legacyClaudeConfigBackupPath(config) {
  return `${config}.context-bridge-backup`;
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

// Which registered account the official Claude tooling is using. Tokens rotate,
// so profile identity is the fallback after direct token matches.
export async function activeClaudeAccountId(accounts, options = {}) {
  const current = await readClaudeAuth(defaultClaudeHome(options), options);
  if (!current?.accessToken) return undefined;

  for (const account of accounts) {
    const auth = await readClaudeAuth(claudeHome(account.id, options), options);
    if (sameClaudeIdentity(current, auth)) return account.id;
  }
  return undefined;
}

// Determine which managed account may safely own the live Claude credential
// during maintenance. A usable live token wins. If Claude has erased or blanked
// it, a retained live profile can still identify the account. With no identity
// at all, repair is safe only when exactly one managed Claude login exists.
export async function claudeMaintenanceAccountId(accounts, options = {}) {
  const claudeAccounts = (accounts || []).filter((account) => account.provider === CLAUDE_PROVIDER);
  const liveState = await readClaudeCredentialState(defaultClaudeHome(options));

  if (liveState.kind === 'usable') return activeClaudeAccountId(claudeAccounts, options);

  const signedIn = [];
  for (const account of claudeAccounts) {
    const auth = await readClaudeAuth(claudeHome(account.id, options), options);
    if (auth?.accessToken && auth?.refreshToken) signedIn.push({ account, auth });
  }

  const liveProfile = await readClaudeProfile(defaultClaudeHome(options), options);
  if (liveProfile) {
    const matches = signedIn.filter(({ auth }) => sameClaudeProfile(liveProfile, auth.profile));
    if (matches.length === 1) return matches[0].account.id;
    if (matches.length > 1) return undefined;
  }

  return signedIn.length === 1 ? signedIn[0].account.id : undefined;
}

// Keep the official Claude Code credential and Turntrail's managed copy on the
// same refresh-token generation while Claude is stopped. The live file is
// written first after a refresh because Anthropic invalidates the old refresh
// token; a failure between writes must leave the official client usable.
export async function maintainIdleClaudeLogin(accountId, options = {}) {
  await assertAgentStopped(CLAUDE_PROVIDER, options);

  const managedHome = claudeHome(accountId, options);
  const managedState = await readClaudeCredentialState(managedHome);
  const managed = await readClaudeAuth(managedHome, options);
  if (managedState.kind !== 'usable' || !managed?.accessToken || !managed?.refreshToken) {
    return { active: false, refreshed: false, repaired: false, synchronized: false };
  }

  const liveHome = defaultClaudeHome(options);
  const liveState = await readClaudeCredentialState(liveHome);
  const live = liveState.kind === 'usable' ? await readClaudeAuth(liveHome, options) : null;
  if (live && !sameClaudeIdentity(live, managed)) {
    return { active: false, refreshed: false, repaired: false, synchronized: false };
  }

  // A failed Claude refresh can leave the live file one generation behind
  // while Turntrail still holds a newer credential. Prefer the copy with the
  // later access-token expiry; ties remain owned by the official live file.
  const managedIsNewer = Boolean(
    live &&
      credentialsDiffer(liveState.raw, managedState.raw) &&
      credentialExpiry(managed) > credentialExpiry(live)
  );
  const sourceState = !live || managedIsNewer ? managedState : liveState;
  const source = !live || managedIsNewer ? managed : live;
  const refreshSkewMs = Number.isFinite(options.claudeRefreshSkewMs)
    ? Math.max(0, options.claudeRefreshSkewMs)
    : CLAUDE_PROACTIVE_REFRESH_MS;
  const expiresAt = Number(source.expiresAt);
  const due = options.forceRefresh || (Number.isFinite(expiresAt) && expiresAt - refreshSkewMs <= Date.now());
  let credential = sourceState.raw;
  let refreshed = false;

  if (due) {
    // Re-check immediately before consuming a single-use refresh token. This
    // narrows the unavoidable gap between OS process inspection and the token
    // request without ever racing a Claude process that is already visible.
    await assertAgentStopped(CLAUDE_PROVIDER, options);
    const tokens = await refreshClaudeToken(source.refreshToken, options);
    credential = claudeCredentialWithTokens(credential, tokens);
    refreshed = true;
  }

  const repaired = !live;
  await writeClaudeCredentialFile(liveHome, credential);

  const profile = managed.profile;
  if (repaired && profile) {
    await writeClaudeProfile(claudeConfigPath(liveHome, options), profile);
  }

  // A crash here is recoverable: the live credential is authoritative and the
  // next maintenance pass copies it back into the managed account.
  await writeClaudeCredentialFile(managedHome, credential);
  return {
    active: true,
    refreshed,
    repaired,
    synchronized: credentialsDiffer(managedState.raw, credential)
  };
}

function sameClaudeProfile(left, right) {
  if (!left || !right) return false;
  const leftEmail = String(left.emailAddress || '').trim().toLowerCase();
  const rightEmail = String(right.emailAddress || '').trim().toLowerCase();
  if (!leftEmail || leftEmail !== rightEmail) return false;
  const leftOrganization = left.organizationUuid;
  const rightOrganization = right.organizationUuid;
  return !leftOrganization || !rightOrganization || leftOrganization === rightOrganization;
}

function claudeCredentialWithTokens(credential, tokens) {
  const oauth = credential?.claudeAiOauth || {};
  return removeUndefined({
    ...credential,
    claudeAiOauth: removeUndefined({
      ...oauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      tokenType: tokens.tokenType || oauth.tokenType
    })
  });
}

function credentialsDiffer(left, right) {
  const leftOauth = left?.claudeAiOauth || {};
  const rightOauth = right?.claudeAiOauth || {};
  return leftOauth.accessToken !== rightOauth.accessToken || leftOauth.refreshToken !== rightOauth.refreshToken;
}

function credentialExpiry(auth) {
  const expiresAt = Number(auth?.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}

async function writeClaudeCredentialFile(home, credential) {
  const file = claudeCredentialsPath(home);
  validateClaudeCredentialPayload(credential);
  await writeFileAtomic(file, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
}

export async function refreshClaudeAccountIdentity(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options);
  if (!auth?.accessToken) return null;
  await updateAccount(
    accountId,
    { email: auth.email, plan: auth.plan, signedInAt: new Date().toISOString() },
    options
  );
  return auth;
}

// Adopt a login copied from another machine.
//
// Accepts the whole `.credentials.json` or just the `claudeAiOauth` object
// inside it, because both are things people reasonably copy. As with Codex, the
// rejection message names the actual problem: pasting the wrong file, a
// fragment, or a bare token are otherwise indistinguishable from "it failed".
export function parseClaudeAuthText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Paste the contents of a .credentials.json file.');

  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const hint = /^[A-Za-z0-9._-]+$/.test(trimmed)
      ? ' That looks like a bare token, but Claude needs the refresh token too: paste the whole .credentials.json file.'
      : '';
    throw new Error(`That is not valid JSON.${hint}`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A .credentials.json holds a JSON object.');
  }

  // The bare `claudeAiOauth` object, lifted out of the file.
  if (!value.claudeAiOauth && typeof value.accessToken === 'string') {
    return { claudeAiOauth: value };
  }
  if (typeof value.claudeAiOauth?.accessToken !== 'string') {
    throw new Error(
      'This is JSON, but not a Claude credential: it has no claudeAiOauth.accessToken. ' +
        'On the signed-in machine the file is ~/.claude/.credentials.json.'
    );
  }
  return value;
}

export async function importClaudeAuthText(accountId, text, options = {}) {
  const value = parseClaudeAuthText(text);
  const home = await ensureClaudeHome(accountId, options);
  const file = claudeCredentialsPath(home);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }

  // A pasted credential carries no email - that lives in the config file, which
  // is not what was pasted - so record what the credential does say about the
  // plan and leave the account labelled by its name until Claude fills the rest
  // in on first use.
  if (typeof options.profile === 'object' && options.profile) {
    await writeClaudeProfile(claudeConfigPath(home, options), options.profile);
  }
  return refreshClaudeAccountIdentity(accountId, options);
}

// Store the result of a completed OAuth sign-in.
//
// Written in exactly the shape Claude Code writes, so that activating this
// account later produces a credential the official CLI and extension accept
// without knowing Turntrail was involved.
export async function writeClaudeCredential(accountId, tokens, profile, options = {}) {
  if (!tokens?.accessToken) throw new Error('Sign-in returned no access token.');
  const home = await ensureClaudeHome(accountId, options);

  const credential = {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: profile?.plan,
      rateLimitTier: profile?.organizationRateLimitTier
    },
    organizationUuid: profile?.organizationUuid
  };

  const file = claudeCredentialsPath(home);
  await fs.writeFile(file, `${JSON.stringify(removeUndefined(credential), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }

  if (profile) await writeClaudeProfile(claudeConfigPath(home, options), claudeProfileRecord(profile));
  return refreshClaudeAccountIdentity(accountId, options);
}

// `plan` is ours, for labelling; everything else mirrors what Claude Code puts
// in `oauthAccount`, so the file stays recognisable to the official client.
function claudeProfileRecord(profile) {
  const { plan, ...record } = profile;
  return removeUndefined(record);
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        key,
        item && typeof item === 'object' && !Array.isArray(item) ? removeUndefined(item) : item
      ])
  );
}

// Sixty seconds of slack: a token that expires while the request is in flight
// is indistinguishable from one that was already dead.
const EXPIRY_SKEW_MS = 60 * 1000;

// Is this account the one Claude Code is currently signed in as?
//
// It matters for the same reason it does on the Codex side: the active account's
// token lives in the default home, where the official client refreshes it and
// Anthropic rotates the refresh token on each use. If Turntrail refreshed
// its own copy too, one of the two would then hold a rotated-out token and get
// "invalid_grant". Tokens drift precisely in that case, so the match falls back
// to identity - email and organization, which do not rotate.
export async function isActiveClaudeAccount(accountId, options = {}) {
  const live = await readClaudeAuth(defaultClaudeHome(options), options);
  if (!live?.accessToken && !live?.refreshToken) return false;
  const auth = await readClaudeAuth(claudeHome(accountId, options), options);
  return sameClaudeIdentity(live, auth);
}

// Preserve refresh-token rotations performed by the live Claude Code process
// without competing with it for the same rotating token.
export async function syncActiveClaudeAccount(accountId, options = {}) {
  if (!(await isActiveClaudeAccount(accountId, options))) return false;

  const source = claudeCredentialsPath(defaultClaudeHome(options));
  const contents = await fs.readFile(source, 'utf8');
  let credential;
  try {
    credential = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${source}: ${error.message}`);
  }
  validateClaudeCredentialPayload(credential);
  const oauth = credential.claudeAiOauth || {};
  const live = await readClaudeAuth(defaultClaudeHome(options), options);
  const managed = await readClaudeAuth(claudeHome(accountId, options), options);
  if (live?.accessToken !== oauth.accessToken || !sameClaudeIdentity(live, managed)) return false;
  await writeFileAtomic(claudeCredentialsPath(claudeHome(accountId, options)), contents, { mode: 0o600 });
  return true;
}

function sameClaudeIdentity(left, right) {
  if (!left || !right) return false;
  if (left.refreshToken && right.refreshToken && left.refreshToken === right.refreshToken) return true;
  if (left.accessToken && right.accessToken && left.accessToken === right.accessToken) return true;
  const sameEmail = left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase();
  if (!sameEmail) return false;
  // When both know their org, require it to match too; otherwise the email is
  // the best identity we have.
  if (left.organizationUuid && right.organizationUuid) return left.organizationUuid === right.organizationUuid;
  return true;
}

// A usable access token for this account, renewed if it has expired.
//
// Claude Code refreshes its own credential in place, but only for the account
// it is currently using. Every other account's token would simply go stale -
// and a stale token means the panel can never show that subscription's quota,
// which is most of the point of listing it. So Turntrail renews them.
export async function ensureClaudeAccessToken(accountId, options = {}) {
  const auth = await readClaudeAuth(claudeHome(accountId, options), options);
  if (!auth?.accessToken) return null;

  // For the active account, read the credential the official client keeps fresh
  // in the default home instead of refreshing our snapshot. Refreshing it here
  // would race Claude Code for the rotating refresh token and leave one side
  // holding a dead one - the cause of "invalid_grant" on the account in use.
  if (!options.offline && !options.allowActiveRefresh && (await isActiveClaudeAccount(accountId, options))) {
    const live = await readClaudeAuth(defaultClaudeHome(options), options);
    if (live?.accessToken) return live;
  }

  const expiresAt = Number(auth.expiresAt);
  const fresh = !Number.isFinite(expiresAt) || expiresAt - EXPIRY_SKEW_MS > Date.now();
  if ((fresh && !options.forceRefresh) || options.offline) return auth;
  if (!auth.refreshToken) return auth;

  const tokens = await refreshClaudeToken(auth.refreshToken, options);
  // A refresh returns no profile, so keep the one already on disk rather than
  // wiping the account's identity every eight hours.
  const profile = await readClaudeProfile(claudeHome(accountId, options), options);
  await writeClaudeCredential(
    accountId,
    tokens,
    profile ? { ...profile, plan: auth.plan, organizationRateLimitTier: auth.rateLimitTier } : undefined,
    options
  );
  return readClaudeAuth(claudeHome(accountId, options), options);
}

// Fill in an account's identity from the API when the credential arrived
// without one - a pasted credential carries tokens but no email.
export async function backfillClaudeProfile(accountId, options = {}) {
  const auth = await ensureClaudeAccessToken(accountId, options);
  if (!auth?.accessToken) return null;
  if (auth.email) return auth;

  let profile;
  try {
    profile = await fetchClaudeProfile(auth.accessToken, options);
  } catch (error) {
    if (isProviderContractError(error)) throw error;
  }
  if (!profile) return auth;
  await writeClaudeProfile(claudeConfigPath(claudeHome(accountId, options), options), claudeProfileRecord(profile));
  return refreshClaudeAccountIdentity(accountId, options);
}

// Patch a single key. Claude's config carries project history and caches that
// have nothing to do with which account is in use, so the file is read, one key
// replaced, and written back rather than rewritten from scratch.
async function writeClaudeProfile(file, profile) {
  const config = await claudeConfigWithProfile(file, profile);
  await ensureDir(path.dirname(file));
  await writeJson(file, config);
}

async function claudeConfigWithProfile(file, profile) {
  const config = (await pathExists(file)) ? await readClaudeConfig(file) : {};
  config.oauthAccount = profile;
  return config;
}

async function readClaudeConfig(file) {
  let config;
  try {
    config = await readJson(file);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}. Turntrail left it unchanged.`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Could not update ${file}: the Claude config must be a JSON object. Turntrail left it unchanged.`);
  }
  return config;
}

// The credential is live. Write it 0600 so activating an account does not
// quietly widen its permissions; on Windows the mode is ignored, which is why
// this is best-effort rather than load-bearing.
async function copyCredential(source, target) {
  const contents = await fs.readFile(source, 'utf8');
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // Windows and some network filesystems do not support POSIX modes.
  }
}
