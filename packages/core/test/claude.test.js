import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateClaudeAccount,
  activeClaudeAccountId,
  claudeAuthorizeUrl,
  claudeConfigPath,
  claudeCredentialsPath,
  claudeEnv,
  claudeHome,
  createAccount,
  createPkce,
  defaultClaudeHome,
  ensureClaudeAccessToken,
  exchangeClaudeCode,
  getClaudeUsage,
  headlineRemaining,
  importClaudeAuth,
  importClaudeAuthText,
  isActiveClaudeAccount,
  isClaudeSignedIn,
  normalizeClaudeProfile,
  normalizeClaudeUsage,
  parseAuthorizationCode,
  parseClaudeAuthText,
  readClaudeAuth,
  refreshClaudeToken,
  removeAccount,
  restoreClaudeBackup,
  writeClaudeCredential,
  CLAUDE_CLIENT_ID
} from '../src/index.js';

// The config-path rule reads this variable, so a value inherited from the shell
// running the tests would silently change what is under test.
delete process.env.CLAUDE_CONFIG_DIR;

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-claude-'));
  return { home, options: { home, agentProcesses: [] } };
}

function credential(overrides = {}) {
  return {
    claudeAiOauth: {
      accessToken: overrides.accessToken || 'sk-ant-oat01-access',
      refreshToken: overrides.refreshToken || 'sk-ant-ort01-refresh',
      // Far enough out that nothing tries to renew it mid-test.
      expiresAt: overrides.expiresAt ?? Date.now() + 8 * 3600 * 1000,
      scopes: ['user:inference'],
      subscriptionType: overrides.plan || 'pro'
    },
    organizationUuid: overrides.organizationUuid || 'org-uuid'
  };
}

async function signIn(accountId, options, overrides = {}) {
  const home = claudeHome(accountId, options);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(claudeCredentialsPath(home), JSON.stringify(credential(overrides)), 'utf8');
  await fs.writeFile(
    claudeConfigPath(home, options),
    JSON.stringify({ oauthAccount: { emailAddress: overrides.email || 'dev@example.com' } }),
    'utf8'
  );
  return home;
}

// --- layout ----------------------------------------------------------------

test('each Claude account gets its own CLAUDE_CONFIG_DIR', async () => {
  const { options } = await sandbox();
  const first = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  const second = await createAccount({ label: 'Work', provider: 'claude' }, options);

  assert.notEqual(claudeHome(first.id, options), claudeHome(second.id, options));
  // One environment variable is the entire isolation mechanism.
  assert.equal(claudeEnv(first.id, options).CLAUDE_CONFIG_DIR, claudeHome(first.id, options));
});

test('the config file sits beside the stock home but inside a custom one', async () => {
  const { home, options } = await sandbox();

  // Claude Code writes ~/.claude.json as a sibling of ~/.claude, but relocates
  // it *into* whatever CLAUDE_CONFIG_DIR names. Getting this backwards means
  // writing identity into a file nothing reads.
  assert.equal(claudeConfigPath(defaultClaudeHome(options), options), path.join(home, '.claude.json'));

  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  const accountHome = claudeHome(account.id, options);
  assert.equal(claudeConfigPath(accountHome, options), path.join(accountHome, '.claude.json'));
});

test('identity is read from the config, not the credential', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options, { email: 'someone@example.com', plan: 'max' });

  const auth = await readClaudeAuth(claudeHome(account.id, options), options);
  assert.equal(auth.email, 'someone@example.com');
  assert.equal(auth.plan, 'max');
  assert.equal(await isClaudeSignedIn(account.id, options), true);
});

// --- adopting credentials ---------------------------------------------------

test('a pasted credential is accepted whole or as the oauth object alone', async () => {
  const whole = parseClaudeAuthText(JSON.stringify(credential()));
  assert.equal(typeof whole.claudeAiOauth.accessToken, 'string');

  // People reasonably copy just the inner object out of the file.
  const inner = parseClaudeAuthText(JSON.stringify(credential().claudeAiOauth));
  assert.equal(inner.claudeAiOauth.accessToken, 'sk-ant-oat01-access');
});

test('a rejected paste says which mistake was made', async () => {
  const reason = (input) => {
    try {
      parseClaudeAuthText(input);
      return 'accepted';
    } catch (error) {
      return error.message;
    }
  };

  assert.match(reason(''), /Paste the contents/);
  assert.match(reason('{ nope'), /not valid JSON/);
  assert.match(reason('[1,2]'), /JSON object/);
  assert.match(reason(JSON.stringify({ hello: 'world' })), /no claudeAiOauth\.accessToken/);
  // The single most likely mix-up, and the one whose generic error explains least.
  assert.match(reason('sk-ant-oat01-abcdef'), /bare token/);
});

test('a rejected paste leaves an existing login untouched', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options, { accessToken: 'sk-ant-oat01-original' });

  await assert.rejects(() => importClaudeAuthText(account.id, '{ not json', options));

  const auth = await readClaudeAuth(claudeHome(account.id, options), options);
  assert.equal(auth.accessToken, 'sk-ant-oat01-original', 'validation must happen before anything is written');
});

test('importing the current login copies it and leaves the original in place', async () => {
  const { options } = await sandbox();
  const source = defaultClaudeHome(options);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(claudeCredentialsPath(source), JSON.stringify(credential({ accessToken: 'sk-ant-oat01-live' })), 'utf8');
  await fs.writeFile(
    claudeConfigPath(source, options),
    JSON.stringify({ oauthAccount: { emailAddress: 'live@example.com' }, projects: { keep: true } }),
    'utf8'
  );

  const account = await createAccount({ label: 'Adopted', provider: 'claude' }, options);
  const auth = await importClaudeAuth(account.id, source, options);

  assert.equal(auth.accessToken, 'sk-ant-oat01-live');
  // The email lives in a second file, so adopting has to carry both across.
  assert.equal(auth.email, 'live@example.com');

  const original = JSON.parse(await fs.readFile(claudeCredentialsPath(source), 'utf8'));
  assert.equal(original.claudeAiOauth.accessToken, 'sk-ant-oat01-live', 'import copies, never moves');
});

// --- switching --------------------------------------------------------------

test('switching writes the credential and patches only oauthAccount', async () => {
  const { options } = await sandbox();
  const target = defaultClaudeHome(options);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(claudeCredentialsPath(target), JSON.stringify(credential({ accessToken: 'sk-ant-oat01-was-here' })), 'utf8');
  // Claude's real config is ~50KB of project history and caches. None of it has
  // anything to do with which account is in use, so none of it may be lost.
  await fs.writeFile(
    claudeConfigPath(target, options),
    JSON.stringify({
      oauthAccount: { emailAddress: 'old@example.com' },
      projects: { '/some/repo': { history: [1, 2, 3] } },
      machineID: 'abc123'
    }),
    'utf8'
  );

  const account = await createAccount({ label: 'Work', provider: 'claude' }, options);
  await signIn(account.id, options, {
    accessToken: 'sk-ant-oat01-work',
    refreshToken: 'sk-ant-ort01-work',
    email: 'work@example.com'
  });

  await activateClaudeAccount(account.id, options);

  const written = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  assert.equal(written.claudeAiOauth.accessToken, 'sk-ant-oat01-work');

  const config = JSON.parse(await fs.readFile(claudeConfigPath(target, options), 'utf8'));
  assert.equal(config.oauthAccount.emailAddress, 'work@example.com', 'the displayed account must follow the credential');
  assert.equal(config.machineID, 'abc123', 'unrelated keys must survive the patch');
  assert.deepEqual(config.projects['/some/repo'].history, [1, 2, 3]);
});

test('switching leaves malformed live Claude configuration and credentials unchanged', async () => {
  const { options } = await sandbox();
  const target = defaultClaudeHome(options);
  const liveCredential = JSON.stringify(credential({
    accessToken: 'sk-ant-oat01-live',
    refreshToken: 'sk-ant-ort01-live'
  }));
  const malformedConfig = '{ "projects": { "keep": true },';
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(claudeCredentialsPath(target), liveCredential, 'utf8');
  await fs.writeFile(claudeConfigPath(target, options), malformedConfig, 'utf8');

  const incoming = await createAccount({ label: 'Incoming', provider: 'claude' }, options);
  await signIn(incoming.id, options, {
    accessToken: 'sk-ant-oat01-incoming',
    refreshToken: 'sk-ant-ort01-incoming',
    email: 'incoming@example.com'
  });

  await assert.rejects(() => activateClaudeAccount(incoming.id, options), /left it unchanged/i);
  assert.equal(await fs.readFile(claudeCredentialsPath(target), 'utf8'), liveCredential);
  assert.equal(await fs.readFile(claudeConfigPath(target, options), 'utf8'), malformedConfig);
});

test('purging an active Claude account removes its live login without erasing unrelated config', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'claude' }, options);
  await signIn(account.id, options, { email: 'active@example.com' });
  await activateClaudeAccount(account.id, options);

  const target = defaultClaudeHome(options);
  const configPath = claudeConfigPath(target, options);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.projects = { '/keep/me': { history: [1, 2] } };
  config.machineID = 'keep-me';
  await fs.writeFile(configPath, JSON.stringify(config), 'utf8');

  const result = await removeAccount(account.id, { ...options, purge: true });
  assert.equal(result.purged, true);
  assert.equal(result.livePurged, true);
  assert.equal(await readClaudeAuth(target, options), null);
  assert.equal(await readClaudeAuth(claudeHome(account.id, options), options), null);
  const remaining = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(remaining.oauthAccount, undefined);
  assert.equal(remaining.machineID, 'keep-me');
  assert.deepEqual(remaining.projects['/keep/me'].history, [1, 2]);
});

test('an undone switch restores both files', async () => {
  const { options } = await sandbox();
  const target = defaultClaudeHome(options);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(claudeCredentialsPath(target), JSON.stringify(credential({ accessToken: 'sk-ant-oat01-before' })), 'utf8');
  await fs.writeFile(
    claudeConfigPath(target, options),
    JSON.stringify({ oauthAccount: { emailAddress: 'before@example.com' } }),
    'utf8'
  );

  const account = await createAccount({ label: 'Work', provider: 'claude' }, options);
  await signIn(account.id, options, {
    accessToken: 'sk-ant-oat01-after',
    refreshToken: 'sk-ant-ort01-after',
    email: 'after@example.com'
  });
  await activateClaudeAccount(account.id, options);

  await assert.rejects(
    () => restoreClaudeBackup({ ...options, agentProcesses: [{ name: 'claude.exe', pid: 4343 }] }),
    /Claude is still running/
  );
  const stillActive = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  assert.equal(stillActive.claudeAiOauth.accessToken, 'sk-ant-oat01-after', 'a blocked undo must not replace the live credential');

  await restoreClaudeBackup(options);

  const credentials = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  const config = JSON.parse(await fs.readFile(claudeConfigPath(target, options), 'utf8'));
  assert.equal(credentials.claudeAiOauth.accessToken, 'sk-ant-oat01-before');
  assert.equal(config.oauthAccount.emailAddress, 'before@example.com');
});

test('Claude undo recognizes credential and config backups from before the rename', async () => {
  const { options } = await sandbox();
  const target = defaultClaudeHome(options);
  const config = claudeConfigPath(target, options);
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(
    path.join(target, '.credentials.context-bridge-backup.json'),
    JSON.stringify(credential({ accessToken: 'sk-ant-oat01-legacy' })),
    'utf8'
  );
  await fs.writeFile(`${config}.context-bridge-backup`, JSON.stringify({ oauthAccount: { emailAddress: 'legacy@example.com' } }), 'utf8');

  await restoreClaudeBackup(options);
  const restored = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  const restoredConfig = JSON.parse(await fs.readFile(config, 'utf8'));
  assert.equal(restored.claudeAiOauth.accessToken, 'sk-ant-oat01-legacy');
  assert.equal(restoredConfig.oauthAccount.emailAddress, 'legacy@example.com');
});

test('the account in use is matched on the refresh token', async () => {
  const { options } = await sandbox();
  const first = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  const second = await createAccount({ label: 'Work', provider: 'claude' }, options);
  await signIn(first.id, options, {
    accessToken: 'access-personal',
    refreshToken: 'refresh-personal',
    email: 'personal@example.com',
    organizationUuid: 'org-personal'
  });
  await signIn(second.id, options, {
    accessToken: 'access-work',
    refreshToken: 'refresh-work',
    email: 'work@example.com',
    organizationUuid: 'org-work'
  });

  await activateClaudeAccount(second.id, options);

  // Claude rotates the access token in place as it expires; matching on that
  // would report no active account within the hour.
  const target = defaultClaudeHome(options);
  const live = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  live.claudeAiOauth.accessToken = 'sk-ant-oat01-rotated';
  await fs.writeFile(claudeCredentialsPath(target), JSON.stringify(live), 'utf8');

  const accounts = [
    { id: first.id, provider: 'claude' },
    { id: second.id, provider: 'claude' }
  ];
  assert.equal(await activeClaudeAccountId(accounts, options), second.id);
});

test('switching preserves the rotated outgoing login and renews the incoming login', async () => {
  const { options } = await sandbox();
  const outgoing = await createAccount({ label: 'Outgoing', provider: 'claude' }, options);
  const incoming = await createAccount({ label: 'Incoming', provider: 'claude' }, options);
  await signIn(outgoing.id, options, {
    accessToken: 'out-snapshot-access',
    refreshToken: 'out-snapshot-refresh',
    email: 'outgoing@example.com',
    organizationUuid: 'org-outgoing'
  });
  await signIn(incoming.id, options, {
    accessToken: 'incoming-expired-access',
    refreshToken: 'incoming-old-refresh',
    expiresAt: Date.now() - 1000,
    email: 'incoming@example.com',
    organizationUuid: 'org-incoming'
  });

  await activateClaudeAccount(outgoing.id, options);
  const target = defaultClaudeHome(options);
  const live = JSON.parse(await fs.readFile(claudeCredentialsPath(target), 'utf8'));
  live.claudeAiOauth.accessToken = 'out-live-access';
  live.claudeAiOauth.refreshToken = 'out-live-refresh';
  await fs.writeFile(claudeCredentialsPath(target), JSON.stringify(live), 'utf8');

  const result = await activateClaudeAccount(incoming.id, {
    ...options,
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'incoming-renewed-access',
        refresh_token: 'incoming-renewed-refresh',
        expires_in: 28800,
        scope: 'user:inference'
      })
    })
  });
  assert.equal(result.alreadyActive, undefined);

  const outgoingSnapshot = await readClaudeAuth(claudeHome(outgoing.id, options), options);
  assert.equal(outgoingSnapshot.refreshToken, 'out-live-refresh');
  const installed = await readClaudeAuth(target, options);
  assert.equal(installed.refreshToken, 'incoming-renewed-refresh');
});

test('switching leaves the live Claude login untouched when the incoming login cannot be renewed', async () => {
  const { options } = await sandbox();
  const active = await createAccount({ label: 'Active', provider: 'claude' }, options);
  const dead = await createAccount({ label: 'Dead', provider: 'claude' }, options);
  await signIn(active.id, options, { accessToken: 'active-access', refreshToken: 'active-refresh', email: 'active@example.com' });
  await signIn(dead.id, options, {
    accessToken: 'dead-access',
    refreshToken: 'dead-refresh',
    expiresAt: Date.now() - 1000,
    email: 'dead@example.com'
  });
  await activateClaudeAccount(active.id, options);

  await assert.rejects(
    activateClaudeAccount(dead.id, {
      ...options,
      fetch: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant' })
      })
    }),
    /sign in again/i
  );

  const stillActive = await readClaudeAuth(defaultClaudeHome(options), options);
  assert.equal(stillActive.accessToken, 'active-access');
});

test('switching Claude accounts is blocked while Claude is running', async () => {
  const { options } = await sandbox();
  const active = await createAccount({ label: 'Active', provider: 'claude' }, options);
  const incoming = await createAccount({ label: 'Incoming', provider: 'claude' }, options);
  await signIn(active.id, options, {
    accessToken: 'active-access',
    refreshToken: 'active-refresh',
    email: 'active@example.com'
  });
  await signIn(incoming.id, options, {
    accessToken: 'incoming-access',
    refreshToken: 'incoming-refresh',
    email: 'incoming@example.com'
  });
  await activateClaudeAccount(active.id, options);

  await assert.rejects(
    activateClaudeAccount(incoming.id, {
      ...options,
      agentProcesses: [{ pid: 43, name: 'claude.exe' }]
    }),
    /Claude is still running/i
  );
  const live = await readClaudeAuth(defaultClaudeHome(options), options);
  assert.equal(live.accessToken, 'active-access');
});

// --- the OAuth flow ---------------------------------------------------------

test('PKCE produces a real S256 challenge', () => {
  const pkce = createPkce();
  const expected = crypto.createHash('sha256').update(pkce.verifier).digest('base64url');
  assert.equal(pkce.challenge, expected);
  assert.notEqual(pkce.state, pkce.verifier, 'state must not be the verifier');
});

test('the authorize URL carries what the flow needs', () => {
  const pkce = createPkce();
  const url = new URL(claudeAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state, redirectUri: 'http://localhost:54545/callback' }));

  assert.equal(url.searchParams.get('client_id'), CLAUDE_CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('response_type'), 'code');
  // Without this the page redirects instead of showing a code, which breaks the
  // no-localhost path entirely.
  assert.equal(url.searchParams.get('code'), 'true');
  assert.match(url.searchParams.get('scope'), /user:inference/);
  // The verifier is the one value that must never leave this machine.
  assert.equal(url.toString().includes(pkce.verifier), false);
});

test('the pasted code is accepted in every form a user can produce', () => {
  assert.deepEqual(parseAuthorizationCode('abc123#state456'), { code: 'abc123', state: 'state456' });
  assert.deepEqual(parseAuthorizationCode('  abc123  '), { code: 'abc123', state: undefined });
  assert.deepEqual(parseAuthorizationCode('http://localhost:54545/callback?code=abc123&state=state456'), {
    code: 'abc123',
    state: 'state456'
  });

  // Pasting a token instead of a code otherwise fails three seconds later with
  // an opaque invalid_grant.
  assert.throws(() => parseAuthorizationCode('sk-ant-oat01-nope'), /token, not an authorization code/);
  assert.throws(() => parseAuthorizationCode(''), /Paste the code/);
});

test('the token exchange sends a form body and stores an absolute expiry', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: Object.fromEntries(new URLSearchParams(init.body)) };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'sk-ant-oat01-new',
          refresh_token: 'sk-ant-ort01-new',
          expires_in: 28800,
          scope: 'user:inference user:profile',
          token_type: 'Bearer'
        })
    };
  };

  const before = Date.now();
  const tokens = await exchangeClaudeCode({
    code: 'abc123',
    state: 'state456',
    verifier: 'verifier-value',
    redirectUri: 'http://localhost:54545/callback',
    fetch: fetchImpl
  });

  // The endpoint rejects a JSON body outright.
  assert.equal(seen.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(seen.body.grant_type, 'authorization_code');
  assert.equal(seen.body.code_verifier, 'verifier-value');
  assert.equal(seen.body.client_id, CLAUDE_CLIENT_ID);

  assert.equal(tokens.accessToken, 'sk-ant-oat01-new');
  // A relative lifetime is useless once written to disk.
  assert.ok(tokens.expiresAt >= before + 28800 * 1000);
  assert.deepEqual(tokens.scopes, ['user:inference', 'user:profile']);
});

test('a rejected code explains that codes are single-use', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: 'invalid_grant', error_description: "Invalid 'code' in request." })
  });

  await assert.rejects(
    () => exchangeClaudeCode({ code: 'stale', verifier: 'v', fetch: fetchImpl }),
    /single-use and expire/
  );
});

test('a rejected refresh says to sign in again, not that a code is single-use', async () => {
  // Anthropic answers a dead refresh token with the same invalid_grant code as
  // a stale authorization code, but the advice must be different: nothing here
  // involves a single-use code.
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })
  });
  await assert.rejects(
    () => refreshClaudeToken('rt.dead', { fetch: fetchImpl }),
    (error) => error.code === 'AUTH_EXPIRED' &&
      /sign in again/i.test(error.message) && !/single-use/i.test(error.message)
  );
});

test('a missing Claude refresh token is a confirmed authentication failure', async () => {
  await assert.rejects(
    () => refreshClaudeToken('', { fetch: async () => { throw new Error('must not fetch'); } }),
    (error) => error.code === 'AUTH_EXPIRED' && /sign in again/i.test(error.message)
  );
});

test('Claude OAuth errors never expose provider response details', async () => {
  const secret = 'sk-ant-provider-secret-that-must-not-leak';
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: 'server_error', error_description: secret, diagnostic: secret })
  });
  await assert.rejects(
    exchangeClaudeCode({ code: 'code', verifier: 'verifier', fetch: fetchImpl }),
    (error) => /server_error/.test(error.message) && !error.message.includes(secret)
  );
});

test('a completed sign-in is written in the shape Claude Code reads', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);

  const profile = normalizeClaudeProfile({
    account: { uuid: 'acct', email: 'dev@example.com', display_name: 'Dev', has_claude_pro: true },
    organization: { uuid: 'org', name: 'Dev Org', organization_type: 'claude_pro', rate_limit_tier: 'default_claude_ai' }
  });
  assert.equal(profile.plan, 'pro');

  await writeClaudeCredential(
    account.id,
    { accessToken: 'sk-ant-oat01-new', refreshToken: 'sk-ant-ort01-new', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] },
    profile,
    options
  );

  const raw = JSON.parse(await fs.readFile(claudeCredentialsPath(claudeHome(account.id, options)), 'utf8'));
  assert.equal(raw.claudeAiOauth.accessToken, 'sk-ant-oat01-new');
  assert.equal(raw.claudeAiOauth.subscriptionType, 'pro');
  assert.equal(raw.organizationUuid, 'org');

  const auth = await readClaudeAuth(claudeHome(account.id, options), options);
  assert.equal(auth.email, 'dev@example.com');
  // `plan` is ours for labelling and must not leak into the file Claude reads.
  const config = JSON.parse(await fs.readFile(claudeConfigPath(claudeHome(account.id, options), options), 'utf8'));
  assert.equal(config.oauthAccount.plan, undefined);
  assert.equal(config.oauthAccount.emailAddress, 'dev@example.com');
});

test('an expired token is renewed before it is used', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options, { expiresAt: Date.now() - 1000, refreshToken: 'sk-ant-ort01-old' });

  let refreshed;
  const fetchImpl = async (url, init) => {
    refreshed = Object.fromEntries(new URLSearchParams(init.body));
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ access_token: 'sk-ant-oat01-renewed', refresh_token: 'sk-ant-ort01-new', expires_in: 28800 })
    };
  };

  const auth = await ensureClaudeAccessToken(account.id, { ...options, fetch: fetchImpl });

  assert.equal(refreshed.grant_type, 'refresh_token');
  assert.equal(refreshed.refresh_token, 'sk-ant-ort01-old');
  assert.equal(auth.accessToken, 'sk-ant-oat01-renewed');
  // Claude Code renews only the account it is using, so every other account's
  // quota would be unreadable without this - and the identity must survive it.
  assert.equal(auth.email, 'dev@example.com');
});

test('an expired token is left alone when offline', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options, { expiresAt: Date.now() - 1000 });

  const auth = await ensureClaudeAccessToken(account.id, {
    ...options,
    offline: true,
    fetch: () => assert.fail('offline must not reach the network')
  });
  assert.equal(auth.accessToken, 'sk-ant-oat01-access');
});

// --- usage ------------------------------------------------------------------

const LIVE_USAGE = {
  five_hour: { utilization: 89, resets_at: '2026-08-17T23:40:00.286229+00:00' },
  seven_day: { utilization: 56, resets_at: '2026-08-18T22:00:00.286250+00:00' },
  seven_day_opus: null,
  // A codenamed bucket that is not a limit this account has.
  nimbus_quill: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: false, spend_limit_reached: false },
  limits: [
    { kind: 'session', group: 'session', percent: 89, severity: 'warning', resets_at: '2026-08-17T23:40:00.286229+00:00' },
    { kind: 'weekly_all', group: 'weekly', percent: 56, severity: 'normal', resets_at: '2026-08-18T22:00:00.286250+00:00' }
  ],
  spend: { percent: 0, enabled: false, balance: null }
};

test('usage is read from the curated limits list, tightest window first', () => {
  const usage = normalizeClaudeUsage(LIVE_USAGE);

  assert.deepEqual(
    usage.windows.map((window) => window.label),
    ['5h', 'weekly'],
    'the window that will actually stop you comes first'
  );
  assert.equal(usage.windows[0].remainingPercent, 11);
  assert.equal(usage.windows[1].remainingPercent, 44);
  // Reading the payload generically invents a window at 100% remaining out of
  // `nimbus_quill` and drags the headline number up with it.
  assert.equal(usage.windows.length, 2);
  assert.equal(headlineRemaining(usage), 11);
  assert.equal(usage.limitReached, false);
});

test('usage falls back to the named windows when limits is absent', () => {
  const { limits, ...withoutLimits } = LIVE_USAGE;
  const usage = normalizeClaudeUsage(withoutLimits);

  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.remainingPercent]),
    [
      ['5h', 11],
      ['weekly', 44]
    ]
  );
});

test('a reached limit is taken from the provider, not inferred', () => {
  const usage = normalizeClaudeUsage({
    limits: [{ kind: 'session', percent: 100, severity: 'exceeded', resets_at: null }]
  });
  assert.equal(usage.limitReached, true);
  assert.equal(usage.windows[0].remainingPercent, 0);
});

test('quota is cached, and a forced read goes back to the network', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options);

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => LIVE_USAGE };
  };
  const withFetch = { ...options, fetch: fetchImpl };

  const first = await getClaudeUsage(account.id, withFetch);
  assert.equal(first.windows.length, 2);
  assert.equal(calls, 1);

  await getClaudeUsage(account.id, withFetch);
  assert.equal(calls, 1, 'a panel that refreshes on every render is how tools end up 429d');

  await getClaudeUsage(account.id, { ...withFetch, force: true });
  assert.equal(calls, 2);
});

test('a failed read keeps the previous number rather than showing nothing', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options);

  await getClaudeUsage(account.id, { ...options, fetch: async () => ({ ok: true, status: 200, json: async () => LIVE_USAGE }) });

  const stale = await getClaudeUsage(account.id, {
    ...options,
    force: true,
    fetch: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
  });

  assert.equal(stale.windows.length, 2, 'a stale number with its age beats no number');
  assert.match(stale.staleReason, /503/);
});

test('a Claude 401 marks the login as requiring revalidation', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Personal', provider: 'claude' }, options);
  await signIn(account.id, options);

  const rejected = await getClaudeUsage(account.id, {
    ...options,
    force: true,
    fetch: async () => ({ ok: false, status: 401, statusText: 'Unauthorized' })
  });

  assert.equal(rejected.authenticationFailure, 'AUTH_REJECTED');
  assert.equal(rejected.requiresSignIn, false);
  assert.equal(rejected.requiresRevalidation, true);
  assert.match(rejected.error, /saved refresh token/i);
});

// --- the loopback callback --------------------------------------------------

async function freeLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('the loopback server returns the code the browser brings back', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  const server = startLoopbackServer({ port: await freeLoopbackPort(), state: 'state456' });
  await server.listening;

  const page = await fetch(`${server.redirectUri}?code=abc123&state=state456`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /close this tab/);
  assert.deepEqual(await server.result, { code: 'abc123', state: 'state456' });
});

test('a refused sign-in rejects, even when nothing is awaiting it yet', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  const server = startLoopbackServer({ port: await freeLoopbackPort(), state: 'state456' });
  await server.listening;

  await fetch(`${server.redirectUri}?error=access_denied&error_description=User+refused`);
  // The panel opens a browser before it awaits this, so the rejection lands
  // with no handler attached. In the extension host that is a crash, not a
  // warning.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(() => server.result, /rejected by the provider \(access_denied\)/);
});

test('a taken port fails with the alternative named', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  const port = await freeLoopbackPort();
  const held = startLoopbackServer({ port, state: 'held-state' });
  await held.listening;

  const clash = startLoopbackServer({ port, state: 'clash-state' });
  await assert.rejects(() => clash.listening, /already in use.*code flow/s);
  held.close();
});

test('the loopback callback requires exact path and matching non-empty state', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  const server = startLoopbackServer({ port: await freeLoopbackPort(), state: 'expected-state' });
  await server.listening;

  assert.equal((await fetch(`${server.redirectUri}-extra?code=wrong&state=expected-state`)).status, 404);
  const missing = await fetch(`${server.redirectUri}?code=abc123`);
  assert.equal(missing.status, 400);
  await assert.rejects(() => server.result, /did not match this request/i);
});

test('the loopback callback expires and close cancels a pending wait', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  const expiring = startLoopbackServer({ port: await freeLoopbackPort(), state: 'expiring', timeoutMs: 20 });
  await expiring.listening;
  await assert.rejects(() => expiring.result, /timed out/i);

  const cancelled = startLoopbackServer({ port: await freeLoopbackPort(), state: 'cancelled' });
  await cancelled.listening;
  cancelled.close();
  await assert.rejects(() => cancelled.result, /cancelled/i);
});

test('the loopback server cannot start without PKCE state', async () => {
  const { startLoopbackServer } = await import('../src/index.js');
  assert.throws(() => startLoopbackServer({ port: 54327 }), /state value is required/i);
});

// --- when a blocked account resumes ----------------------------------------

const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

test('a blocked account reports when it actually resumes, not the next reset', async () => {
  const { resumesAt, nextResetAt } = await import('../src/index.js');

  // The weekly allowance is gone; the 5h window is fine and resets tonight.
  // "Next reset" is two hours away, but you stay blocked for three days.
  const usage = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 40, severity: 'normal', resets_at: hoursFromNow(2) },
      { kind: 'weekly_all', percent: 100, severity: 'exceeded', resets_at: hoursFromNow(72) }
    ]
  });

  assert.equal(nextResetAt(usage), new Date(Date.parse(usage.windows[0].resetsAt)).toISOString());
  assert.equal(
    resumesAt(usage),
    usage.windows[1].resetsAt,
    'showing the sooner reset of a window that is not blocking would be a lie'
  );
});

test('with several windows exhausted, the last one to clear wins', async () => {
  const { resumesAt } = await import('../src/index.js');
  const usage = normalizeClaudeUsage({
    limits: [
      { kind: 'session', percent: 100, severity: 'exceeded', resets_at: hoursFromNow(3) },
      { kind: 'weekly_all', percent: 100, severity: 'exceeded', resets_at: hoursFromNow(50) }
    ]
  });
  // Clearing the 5h window alone does not unblock you.
  assert.equal(resumesAt(usage), usage.windows[1].resetsAt);
});

test('a provider-reported limit with no exhausted window falls back to the tightest', async () => {
  const { resumesAt } = await import('../src/index.js');
  // Codex states `limit_reached` outright, and it can disagree with the
  // percentages at the boundary.
  const usage = {
    limitReached: true,
    windows: [
      { key: '5h', remainingPercent: 0.4, usedPercent: 99.6, resetsAt: hoursFromNow(1), windowSeconds: 18000 },
      { key: 'weekly', remainingPercent: 60, usedPercent: 40, resetsAt: hoursFromNow(80), windowSeconds: 604800 }
    ]
  };
  assert.equal(resumesAt(usage), usage.windows[0].resetsAt);
});

test('an account with room to spare reports no resume time', async () => {
  const { resumesAt } = await import('../src/index.js');
  assert.equal(resumesAt(normalizeClaudeUsage(LIVE_USAGE)), undefined);
});

test('a blocked window with no reset time reports nothing rather than guessing', async () => {
  const { resumesAt } = await import('../src/index.js');
  const usage = normalizeClaudeUsage({ limits: [{ kind: 'session', percent: 100, severity: 'exceeded', resets_at: null }] });
  assert.equal(usage.limitReached, true);
  assert.equal(resumesAt(usage), undefined);
});

// --- the active account is read live, not refreshed --------------------------

// Make an account the active one by copying its credential into the default
// home, then let its snapshot drift so only identity still matches - which is
// exactly the state that produced "invalid_grant" on the account in use.
async function makeActiveWithDriftedSnapshot(accountId, options, liveOverrides = {}) {
  const live = defaultClaudeHome(options);
  await fs.mkdir(live, { recursive: true });
  await fs.writeFile(
    claudeCredentialsPath(live),
    JSON.stringify(credential({ accessToken: 'live-fresh-access', refreshToken: 'live-rotated-refresh', ...liveOverrides })),
    'utf8'
  );
  await fs.writeFile(
    claudeConfigPath(live, options),
    JSON.stringify({ oauthAccount: { emailAddress: liveOverrides.email || 'dev@example.com' } }),
    'utf8'
  );
}

test('the active account is read from the live home, not refreshed', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'claude' }, options);
  // Snapshot: an expired token whose refresh token the app has since rotated.
  await signIn(account.id, options, { accessToken: 'snapshot-stale', refreshToken: 'snapshot-old', expiresAt: Date.now() - 1000 });
  await makeActiveWithDriftedSnapshot(account.id, options);

  assert.equal(await isActiveClaudeAccount(account.id, options), true, 'identity should match even though tokens drifted');

  // A refresh here would race Claude Code and is exactly what we must not do.
  const failIfCalled = () => {
    throw new Error('must not refresh the active account');
  };
  const auth = await ensureClaudeAccessToken(account.id, { ...options, fetch: failIfCalled });
  assert.equal(auth.accessToken, 'live-fresh-access', 'the fresh live token is used, so quota works without a refresh');
});

test('an idle expired account is still refreshed', async () => {
  const { options } = await sandbox();
  const account = await createAccount({ label: 'Idle', provider: 'claude' }, options);
  await signIn(account.id, options, { accessToken: 'stale', refreshToken: 'rt-old', expiresAt: Date.now() - 1000, email: 'idle@example.com' });
  // A different account is active, so this one is not read live.
  await makeActiveWithDriftedSnapshot('someone-else', options, { email: 'active@example.com' });

  let sawRefresh = false;
  const fetchImpl = async () => {
    sawRefresh = true;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ access_token: 'renewed', refresh_token: 'rt-new', expires_in: 28800, scope: 'user:inference' })
    };
  };
  const auth = await ensureClaudeAccessToken(account.id, { ...options, fetch: fetchImpl });
  assert.equal(sawRefresh, true, 'an idle account with no live copy is renewed the old way');
  assert.equal(auth.accessToken, 'renewed');
});
