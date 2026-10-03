import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  activateCodexAccount,
  codexHome,
  createAccount,
  ensureCodexAccessToken,
  isActiveCodexAccount,
  readCodexAuth,
  refreshCodexToken,
  CODEX_CLIENT_ID,
  CODEX_TOKEN_URL
} from '../src/index.js';

// All fetch here is mocked. A real refresh rotates OpenAI's refresh token and
// would invalidate a live login, so these tests never touch the network or a
// real account - the whole reason this code needs to exist is that rotation.
function b64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function accessToken(expEpochSec, nonce) {
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expEpochSec, client_id: CODEX_CLIENT_ID, nonce })}.sig`;
}
const past = () => Math.floor(Date.now() / 1000) - 3600;
const future = () => Math.floor(Date.now() / 1000) + 3600;

function okFetch(payload, capture) {
  return async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) };
  };
}
function errFetch(status, payload) {
  return async () => ({ ok: false, status, statusText: 'Bad Request', text: async () => JSON.stringify(payload) });
}
const failIfCalled = () => {
  throw new Error('refresh must not be called');
};

async function sandbox() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-refresh-'));
  return { home, defaultCodexHome: path.join(home, 'live-codex'), agentProcesses: [] };
}
async function signIn(id, options, tokens) {
  const dir = codexHome(id, options);
  const providerAccountId = tokens.accountId || `acct_${id}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      auth_mode: 'oauth',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        id_token: `${b64url({ alg: 'none' })}.${b64url({ email: 'dev@example.com', sub: providerAccountId })}.sig`,
        account_id: providerAccountId
      },
      last_refresh: '2026-08-01T00:00:00.000Z'
    }),
    'utf8'
  );
  return dir;
}

test('refreshCodexToken posts the OpenAI refresh grant and reads rotated tokens', async () => {
  const capture = {};
  const result = await refreshCodexToken('rt.old', {
    fetch: okFetch({ access_token: 'at.new', refresh_token: 'rt.new', id_token: 'id.new', expires_in: 864000 }, capture)
  });
  assert.equal(capture.url, CODEX_TOKEN_URL);
  assert.equal(capture.init.method, 'POST');
  assert.equal(capture.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(capture.init.body), {
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: 'rt.old',
    scope: 'openid profile email'
  });
  assert.equal(result.accessToken, 'at.new');
  assert.equal(result.refreshToken, 'rt.new');
});

test('a response without a new refresh token keeps the one we sent', async () => {
  const result = await refreshCodexToken('rt.keep', { fetch: okFetch({ access_token: 'at.new' }) });
  assert.equal(result.refreshToken, 'rt.keep');
});

test('a reused or revoked refresh token asks for a fresh sign-in, not a retry', async () => {
  await assert.rejects(
    refreshCodexToken('rt.used', {
      fetch: errFetch(400, { error: 'invalid_grant', error_description: 'refresh token reused' })
    }),
    (error) => error.code === 'AUTH_EXPIRED' && /sign in again/i.test(error.message)
  );
});

test('the structured invalid-refresh-token response is a confirmed expired login', async () => {
  await assert.rejects(
    refreshCodexToken('rt.invalid', {
      fetch: errFetch(401, {
        error: {
          message: 'The refresh token is invalid.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_refresh_token'
        }
      })
    }),
    (error) => error.code === 'AUTH_EXPIRED' &&
      /sign in again/i.test(error.message) && !/objectObject/i.test(error.message)
  );
});

test('a missing Codex refresh token is a confirmed expired login', async () => {
  await assert.rejects(
    refreshCodexToken('', { fetch: failIfCalled }),
    (error) => error.code === 'AUTH_EXPIRED' && /sign in again/i.test(error.message)
  );
});

test('Codex OAuth errors never expose provider response details', async () => {
  const secret = 'sk-provider-secret-that-must-not-leak';
  await assert.rejects(
    refreshCodexToken('rt.old', {
      fetch: errFetch(500, { error: 'server_error', error_description: secret, diagnostic: secret })
    }),
    (error) => /server_error/.test(error.message) && !error.message.includes(secret)
  );
});

test('a fresh token is used as-is, with no refresh call', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Fresh', provider: 'codex' }, options);
  await signIn(account.id, options, { access: accessToken(future()), refresh: 'rt.fresh' });
  const auth = await ensureCodexAccessToken(account.id, { ...options, fetch: failIfCalled });
  assert.equal(auth.refreshToken, 'rt.fresh');
});

test('an expired idle account is refreshed and its rotated token written back', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Idle', provider: 'codex' }, options);
  await signIn(account.id, options, { access: accessToken(past()), refresh: 'rt.old' });

  const auth = await ensureCodexAccessToken(account.id, {
    ...options,
    fetch: okFetch({ access_token: accessToken(future()), refresh_token: 'rt.rotated', id_token: 'id.new' })
  });

  assert.equal(auth.refreshToken, 'rt.rotated', 'the rotated token must replace the old one on disk');
  const onDisk = await readCodexAuth(codexHome(account.id, options));
  assert.equal(onDisk.refreshToken, 'rt.rotated', 'and it must be persisted, not only returned');
});

test('an expired access token with no refresh token requires sign-in again', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Expired', provider: 'codex' }, options);
  await signIn(account.id, options, { access: accessToken(past()), refresh: undefined });

  await assert.rejects(
    ensureCodexAccessToken(account.id, { ...options, fetch: failIfCalled }),
    (error) => error.code === 'AUTH_EXPIRED' && /sign in again/i.test(error.message)
  );
});

test('the active account is never refreshed here - Codex owns its rotating token', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Active', provider: 'codex' }, options);
  const home = await signIn(account.id, options, { access: accessToken(past()), refresh: 'rt.shared' });

  // Make it the live account: the same credential in the default Codex home.
  await fs.mkdir(options.defaultCodexHome, { recursive: true });
  await fs.copyFile(path.join(home, 'auth.json'), path.join(options.defaultCodexHome, 'auth.json'));

  assert.equal(await isActiveCodexAccount(account.id, options), true);
  // Even expired, refreshing it would race the live Codex for the shared token.
  const auth = await ensureCodexAccessToken(account.id, { ...options, fetch: failIfCalled });
  assert.equal(auth.refreshToken, 'rt.shared');
});

test('the active account remains identifiable after both live tokens rotate', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Rotated active', provider: 'codex' }, options);
  const home = await signIn(account.id, options, {
    access: accessToken(past(), 'stored'),
    refresh: 'rt.stored'
  });

  await fs.mkdir(options.defaultCodexHome, { recursive: true });
  const live = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
  live.tokens.access_token = accessToken(past(), 'live');
  live.tokens.refresh_token = 'rt.live';
  await fs.writeFile(path.join(options.defaultCodexHome, 'auth.json'), JSON.stringify(live), 'utf8');

  assert.equal(await isActiveCodexAccount(account.id, options), true);
  const auth = await ensureCodexAccessToken(account.id, { ...options, fetch: failIfCalled });
  assert.equal(auth.refreshToken, 'rt.stored', 'Turntrail must leave the active snapshot untouched');
});

test('switching syncs the outgoing login and renews the incoming one', async () => {
  const options = await sandbox();
  const outgoing = await createAccount({ label: 'Outgoing', provider: 'codex' }, options);
  const incoming = await createAccount({ label: 'Incoming', provider: 'codex' }, options);
  const outHome = await signIn(outgoing.id, options, { access: accessToken(future(), 'out-snapshot'), refresh: 'rt.out' });
  await signIn(incoming.id, options, { access: accessToken(past(), 'incoming'), refresh: 'rt.in-old' });

  // The live home is the outgoing account, but freshly rotated by Codex since we
  // last snapshotted it - a newer token than the snapshot holds.
  await fs.mkdir(options.defaultCodexHome, { recursive: true });
  const live = JSON.parse(await fs.readFile(path.join(outHome, 'auth.json'), 'utf8'));
  live.tokens.access_token = accessToken(future(), 'out-live');
  live.tokens.refresh_token = 'rt.out-live';
  await fs.writeFile(path.join(options.defaultCodexHome, 'auth.json'), JSON.stringify(live), 'utf8');

  const result = await activateCodexAccount(incoming.id, {
    ...options,
    fetch: okFetch({ access_token: accessToken(future(), 'incoming-refreshed'), refresh_token: 'rt.in-new' })
  });
  assert.ok(result.target);

  // The outgoing snapshot captured the newer live token instead of losing it.
  const outSnap = await readCodexAuth(codexHome(outgoing.id, options));
  assert.equal(outSnap.refreshToken, 'rt.out-live');
  // The incoming account was renewed before install, so the live home is fresh.
  const installed = await readCodexAuth(options.defaultCodexHome);
  assert.equal(installed.refreshToken, 'rt.in-new');
});

test('switching rejects a server-revoked login even while its access token looks fresh', async () => {
  const options = await sandbox();
  const active = await createAccount({ label: 'Active', provider: 'codex' }, options);
  const incoming = await createAccount({ label: 'Dead', provider: 'codex' }, options);
  await signIn(active.id, options, { access: accessToken(future()), refresh: 'rt.active' });
  await signIn(incoming.id, options, { access: accessToken(future()), refresh: 'rt.dead' });
  await activateCodexAccount(active.id, {
    ...options,
    fetch: okFetch({ access_token: accessToken(future(), 'active-verified'), refresh_token: 'rt.active' })
  });

  await assert.rejects(
    activateCodexAccount(incoming.id, {
      ...options,
      fetch: errFetch(400, { error: 'invalid_grant', error_description: 'refresh token reused' })
    }),
    (error) => error.code === 'AUTH_EXPIRED' && /sign in again/i.test(error.message)
  );
  const installed = await readCodexAuth(options.defaultCodexHome);
  assert.equal(installed.refreshToken, 'rt.active');
  assert.equal((await readCodexAuth(codexHome(incoming.id, options))).refreshToken, 'rt.dead');
});

test('reapplying an active account installs credentials created by a fresh sign-in', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Recovered', provider: 'codex' }, options);
  await signIn(account.id, options, { access: accessToken(future(), 'old'), refresh: 'rt.old' });
  await activateCodexAccount(account.id, {
    ...options,
    fetch: okFetch({ access_token: accessToken(future(), 'first'), refresh_token: 'rt.first' })
  });

  // The managed home receives a new browser login while the live default home
  // still contains the rejected credential from the previous session.
  await signIn(account.id, options, { access: accessToken(future(), 'reauth'), refresh: 'rt.reauth' });
  const reapplied = await activateCodexAccount(account.id, {
    ...options,
    fetch: okFetch({ access_token: accessToken(future(), 'verified'), refresh_token: 'rt.verified' })
  });

  assert.equal(reapplied.alreadyActive, true);
  assert.equal((await readCodexAuth(options.defaultCodexHome)).refreshToken, 'rt.verified');
});

test('the proactive window renews a token that has not expired yet', async () => {
  const options = await sandbox();
  const account = await createAccount({ label: 'Soon', provider: 'codex' }, options);
  // Two days of life left - not expired, but inside a three-day proactive window.
  const twoDays = Math.floor(Date.now() / 1000) + 2 * 24 * 3600;
  await signIn(account.id, options, { access: accessToken(twoDays), refresh: 'rt.soon' });

  // With the default 60s slack it is still fresh and untouched...
  const untouched = await ensureCodexAccessToken(account.id, { ...options, fetch: failIfCalled });
  assert.equal(untouched.refreshToken, 'rt.soon');

  // ...but the usage path passes a wider window, which renews it early.
  const renewed = await ensureCodexAccessToken(account.id, {
    ...options,
    refreshSkewMs: 3 * 24 * 60 * 60 * 1000,
    fetch: okFetch({ access_token: accessToken(future()), refresh_token: 'rt.soon-new' })
  });
  assert.equal(renewed.refreshToken, 'rt.soon-new');
});
