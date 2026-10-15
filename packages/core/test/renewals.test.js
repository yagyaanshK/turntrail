import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeConfigPath,
  claudeCredentialsPath,
  claudeHome,
  codexHome,
  createAccount,
  ensureClaudeAccessToken,
  getCodexUsage,
  maintainAccounts,
  readClaudeAuth,
  readCodexAuth,
  readRenewals,
  renewalJournalPath,
  tokenFingerprint
} from '../src/index.js';

// Both providers spend a refresh token each time it is used. These are the
// ways Turntrail could spend one twice, or spend one and lose the answer, and
// the record it keeps so a refused token is never sent again.

delete process.env.CLAUDE_CONFIG_DIR;

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-renewals-'));
  return {
    home,
    defaultCodexHome: path.join(home, 'live-codex'),
    defaultClaudeHome: path.join(home, 'live-claude'),
    agentProcesses: []
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function idleClaude(options, refreshToken = 'sk-ant-ort01-idle-refresh') {
  const account = await createAccount({ label: 'Idle', provider: 'claude' }, options);
  await signInClaude(account.id, options, refreshToken);
  return account;
}

async function signInClaude(accountId, options, refreshToken) {
  const home = claudeHome(accountId, options);
  await writeJson(claudeCredentialsPath(home), {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-expired',
      refreshToken,
      expiresAt: Date.now() - 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max'
    }
  });
  await writeJson(claudeConfigPath(home, options), { oauthAccount: { emailAddress: 'idle@example.com' } });
}

const renewedClaude = (accessToken = 'sk-ant-oat01-renewed', refreshToken = 'sk-ant-ort01-renewed') => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 28800, scope: 'user:inference' })
});

const refusedClaude = () => ({
  ok: false,
  status: 400,
  text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token not found or invalid' })
});

test('two windows renewing the same idle login send one renewal between them', async () => {
  const options = await sandbox();
  const account = await idleClaude(options);
  let renewals = 0;
  const fetch = async () => {
    renewals++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return renewedClaude();
  };

  const [vscode, kiro] = await Promise.all([
    ensureClaudeAccessToken(account.id, { ...options, fetch }),
    ensureClaudeAccessToken(account.id, { ...options, fetch })
  ]);
  assert.equal(renewals, 1, 'the second window waits and uses the first one\'s renewal');
  assert.equal(vscode.accessToken, 'sk-ant-oat01-renewed');
  assert.equal(kiro.accessToken, 'sk-ant-oat01-renewed');
});

test('a forced renewal moments after another one reuses it', async () => {
  const options = await sandbox();
  const account = await idleClaude(options);
  await ensureClaudeAccessToken(account.id, { ...options, fetch: async () => renewedClaude() });
  const again = await ensureClaudeAccessToken(account.id, {
    ...options,
    forceRefresh: true,
    fetch: () => assert.fail('a login renewed seconds ago is not renewed again')
  });
  assert.equal(again.accessToken, 'sk-ant-oat01-renewed');
});

test('a refresh token the provider refused is never sent again, until a new sign-in', async () => {
  const options = await sandbox();
  const account = await idleClaude(options, 'sk-ant-ort01-dead');

  await assert.rejects(ensureClaudeAccessToken(account.id, { ...options, fetch: async () => refusedClaude() }), { code: 'AUTH_EXPIRED' });
  await assert.rejects(
    ensureClaudeAccessToken(account.id, { ...options, fetch: () => assert.fail('a refused token is not sent twice') }),
    (error) => error.code === 'AUTH_EXPIRED' && error.reason === 'invalid_grant'
  );

  await signInClaude(account.id, options, 'sk-ant-ort01-new-sign-in');
  const renewed = await ensureClaudeAccessToken(account.id, { ...options, fetch: async () => renewedClaude() });
  assert.equal(renewed.accessToken, 'sk-ant-oat01-renewed');
});

test('the renewal log says what happened to each attempt, and holds no token', async () => {
  const options = await sandbox();
  const account = await idleClaude(options, 'sk-ant-ort01-first');
  await ensureClaudeAccessToken(account.id, { ...options, renewalSource: 'panel', fetch: async () => renewedClaude() });

  const renewals = await readRenewals(account.id, options);
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].outcome, 'renewed');
  assert.equal(renewals[0].provider, 'claude');
  assert.equal(renewals[0].source, 'panel');
  assert.equal(renewals[0].from, tokenFingerprint('sk-ant-ort01-first'));
  assert.equal(renewals[0].to, tokenFingerprint('sk-ant-ort01-renewed'));
  const raw = await fs.readFile(renewalJournalPath(account.id, options), 'utf8');
  assert.doesNotMatch(raw, /sk-ant-/, 'fingerprints only, never a token');
});

test('a renewal whose process died is recorded as interrupted', async () => {
  const options = await sandbox();
  const account = await idleClaude(options);
  const lost = { at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), provider: 'claude', from: 'abc', outcome: 'started' };
  await writeJson(renewalJournalPath(account.id, options), { renewals: [lost] });

  await ensureClaudeAccessToken(account.id, { ...options, fetch: async () => renewedClaude() });
  const [interrupted, renewed] = await readRenewals(account.id, options);
  assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(interrupted.reason, 'process-exited');
  assert.equal(renewed.outcome, 'renewed');
});

test('closing a window does not abandon a renewal that is already on its way', async () => {
  const options = await sandbox();
  const account = await idleClaude(options);
  const closing = new AbortController();
  const renewed = await ensureClaudeAccessToken(account.id, {
    ...options,
    signal: closing.signal,
    fetch: async (url, init) => {
      closing.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(init.signal.aborted, false, 'the request outlives the window that sent it');
      return renewedClaude();
    }
  });
  assert.equal(renewed.accessToken, 'sk-ant-oat01-renewed');
  assert.equal((await readClaudeAuth(claudeHome(account.id, options), options)).refreshToken, 'sk-ant-ort01-renewed');
});

// --- Codex -------------------------------------------------------------------

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

const hoursFromNow = (hours) => Math.floor(Date.now() / 1000) + hours * 3600;

async function codexAccount(options, label, accessExpiry, refreshToken) {
  const account = await createAccount({ label, provider: 'codex' }, options);
  await writeJson(path.join(codexHome(account.id, options), 'auth.json'), {
    auth_mode: 'oauth',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ exp: accessExpiry, nonce: label }),
      refresh_token: refreshToken,
      id_token: jwt({ sub: label, email: `${label}@example.com` }),
      account_id: label
    },
    last_refresh: '2026-10-01T00:00:00.000Z'
  });
  return account;
}

const json = (status, payload) => ({
  ok: status < 400,
  status,
  statusText: String(status),
  text: async () => JSON.stringify(payload),
  json: async () => payload
});

const invalidated = () => json(401, {
  error: { code: 'refresh_token_invalidated', message: 'Your refresh token has been invalidated.' }
});

const codexUsage = () => json(200, {
  rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: hoursFromNow(1) } }
});

test('Codex\'s reasons a login cannot be renewed are told apart, and all say sign in again', async () => {
  const options = await sandbox();
  const account = await codexAccount(options, 'ended', hoursFromNow(-1), 'rt.ended');

  const usage = await getCodexUsage(account.id, { ...options, force: true, fetch: async () => invalidated() });
  assert.equal(usage.requiresSignIn, true);
  assert.equal(usage.requiresRevalidation, false);
  assert.equal(usage.authenticationReason, 'refresh_token_invalidated');
  assert.match(usage.error, /signed out, or signed in again elsewhere/);

  // Its access token still being accepted somewhere would not change that.
  const auth = JSON.parse(await fs.readFile(path.join(codexHome(account.id, options), 'auth.json'), 'utf8'));
  auth.tokens.access_token = jwt({ exp: hoursFromNow(5), nonce: 'still-unexpired' });
  await writeJson(path.join(codexHome(account.id, options), 'auth.json'), auth);
  const rejected = await getCodexUsage(account.id, {
    ...options,
    force: true,
    fetch: async (url) => {
      assert.ok(!url.includes('/oauth/token'), 'the refused refresh token is not sent again');
      return json(401, {});
    }
  });
  assert.equal(rejected.requiresSignIn, true, 'a dead login is "sign in again", not "verify"');
  assert.equal(rejected.requiresRevalidation, false);
  assert.equal(rejected.authenticationReason, 'refresh_token_invalidated');
});

test('one dead login does not stop maintenance of every account after it', async () => {
  const options = await sandbox();
  // Signed out elsewhere: its access token is turned away, and so is the
  // renewal maintenance tries next. That error used to end the whole run.
  const deadExpiry = hoursFromNow(5);
  const dead = await codexAccount(options, 'dead', deadExpiry, 'rt.dead');
  const idle = await codexAccount(options, 'idle', hoursFromNow(-1), 'rt.idle');

  const sent = [];
  const fetch = async (url, init) => {
    const body = String(init?.body || '');
    const headers = JSON.stringify(init?.headers || {});
    if (url.includes('/oauth/token')) {
      sent.push(JSON.parse(body).refresh_token);
      if (body.includes('rt.dead')) return invalidated();
      return json(200, {
        access_token: jwt({ exp: hoursFromNow(240), nonce: 'idle-new' }),
        refresh_token: 'rt.idle.new',
        id_token: jwt({ sub: 'idle', email: 'idle@example.com' })
      });
    }
    return headers.includes(jwt({ exp: deadExpiry, nonce: 'dead' })) ? json(401, {}) : codexUsage();
  };

  const first = await maintainAccounts({ ...options, fetch });
  const byId = Object.fromEntries(first.results.map((item) => [item.accountId, item]));
  assert.equal(byId[dead.id].status, 'sign-in-required');
  assert.equal(byId[dead.id].reason, 'refresh_token_invalidated');
  assert.equal(byId[idle.id].status, 'refreshed', 'the account after the dead one is still renewed');
  assert.equal((await readCodexAuth(codexHome(idle.id, options))).refreshToken, 'rt.idle.new');

  sent.length = 0;
  const second = await maintainAccounts({ ...options, fetch });
  assert.equal(second.results.find((item) => item.accountId === dead.id).status, 'sign-in-required');
  assert.ok(!sent.includes('rt.dead'), 'the next run does not send the dead login again');
  const offline = await getCodexUsage(dead.id, { ...options, offline: true });
  assert.equal(offline.requiresSignIn, true);
});
