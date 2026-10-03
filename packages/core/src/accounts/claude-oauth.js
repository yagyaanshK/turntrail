import crypto from 'node:crypto';
import http from 'node:http';
import { providerFetch } from './http.js';
import {
  ProviderContractError,
  PROVIDER_CONTRACTS,
  validateClaudeProfilePayload,
  validateTokenPayload
} from './provider-contracts.js';

// The Claude Code sign-in flow, performed by Turntrail.
//
// This is the one place Turntrail departs from "let the official binary do
// it". For Codex we spawn `codex login` and only read its output. That is not
// possible here: Claude Code's login is an Ink terminal UI that requires raw
// mode on stdin, so a piped child process dies before it prints anything, and
// `claude setup-token` deliberately writes no credential at all. The official
// VS Code extension avoids the problem by *being* the CLI - it bundles the
// runtime - which is not something an extension can borrow.
//
// So we run the same public PKCE flow the CLI runs, against the same client id.
// Two consequences worth stating plainly, because they are the cost of this
// choice: Turntrail performs the token exchange and therefore handles the
// tokens, and none of these endpoints are a published contract, so they can
// change without notice. Everything below is written to fail loudly rather than
// silently when that happens.
//
// Verified against the live endpoints: the token endpoint answers this exact
// body shape with a well-formed OAuth error, and /api/oauth/profile reports
// `application.uuid` equal to the client id below, named "Claude Code".

export const CLAUDE_CLIENT_ID = PROVIDER_CONTRACTS.claude.oauth.clientId;

// claude.ai signs in Pro/Max/Team subscriptions; platform.claude.com signs in
// Console (API-billed) accounts. The CLI offers both, and so do we.
export const CLAUDE_AUTHORIZE_URL = PROVIDER_CONTRACTS.claude.oauth.authorizeUrl;
export const CLAUDE_CONSOLE_AUTHORIZE_URL = PROVIDER_CONTRACTS.claude.oauth.consoleAuthorizeUrl;
export const CLAUDE_TOKEN_URL = PROVIDER_CONTRACTS.claude.oauth.tokenUrl;
export const CLAUDE_PROFILE_URL = PROVIDER_CONTRACTS.claude.oauth.profileUrl;

// Used by the paste-a-code flow: the authorization lands on a page that simply
// displays the code, so no local port and no browser on this machine are needed.
export const CLAUDE_MANUAL_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

export const CLAUDE_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference'];

// The CLI's own default. Nothing depends on the exact number - the port is part
// of the redirect_uri we send - but reusing it keeps any firewall rule a user
// already has working.
export const CLAUDE_DEFAULT_CALLBACK_PORT = 54545;
export const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

export const CLAUDE_OAUTH_MODES = ['browser', 'code'];

export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    state: crypto.randomBytes(32).toString('base64url')
  };
}

export function loopbackRedirectUri(port) {
  return `http://127.0.0.1:${port}/callback`;
}

export function claudeAuthorizeUrl(options = {}) {
  const url = new URL(options.console ? CLAUDE_CONSOLE_AUTHORIZE_URL : CLAUDE_AUTHORIZE_URL);
  // `code=true` is what makes the manual flow render the code on screen instead
  // of only redirecting.
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', options.clientId || CLAUDE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.redirectUri || CLAUDE_MANUAL_REDIRECT_URI);
  url.searchParams.set('scope', (options.scopes || CLAUDE_SCOPES).join(' '));
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', options.state);
  return url.toString();
}

// What the user pastes back is not one fixed thing. The console page shows
// `code#state`; some browsers hand over the whole callback URL; and a careful
// copy of just the code is common too. Accept all three rather than making the
// user work out which one we wanted.
export function parseAuthorizationCode(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Paste the code shown after you approved access.');

  if (/^https?:\/\//i.test(trimmed)) {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error('That looks like a URL but could not be parsed. Paste just the code instead.');
    }
    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error('That URL has no `code` parameter in it. Copy the code shown on the page instead.');
    }
    return { code, state: url.searchParams.get('state') || undefined };
  }

  const [code, state] = trimmed.split('#');
  if (!code) throw new Error('That is empty before the "#". Copy the whole value shown on the page.');
  // A pasted access token is a common mix-up and produces a baffling
  // `invalid_grant` three seconds later if it is allowed through.
  if (/^sk-ant-/.test(code)) {
    throw new Error('That is a token, not an authorization code. The code is shown on the page after you approve access.');
  }
  return { code, state: state || undefined };
}

export async function exchangeClaudeCode(options = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri || CLAUDE_MANUAL_REDIRECT_URI,
    client_id: options.clientId || CLAUDE_CLIENT_ID,
    code_verifier: options.verifier,
    // The endpoint wants `state` echoed back. When the authorize page returned
    // no state, the CLI sends the verifier in its place.
    state: options.state || options.verifier
  });
  return postToken(body, options);
}

export async function refreshClaudeToken(refreshToken, options = {}) {
  if (!refreshToken) {
    const error = new Error('This account has no refresh token, so its login cannot be renewed. Sign in again.');
    error.code = 'AUTH_EXPIRED';
    throw error;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: options.clientId || CLAUDE_CLIENT_ID
  });
  return postToken(body, { ...options, grant: 'refresh' });
}

async function postToken(body, options = {}) {
  const response = await providerFetch(options.tokenUrl || CLAUDE_TOKEN_URL, {
    method: 'POST',
    // Form encoding, not JSON. The endpoint rejects a JSON body outright.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body
  }, options);

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const error = new Error(oauthErrorMessage(payload, response.status, text, options.grant));
    if (options.grant === 'refresh' && payload?.error === 'invalid_grant') error.code = 'AUTH_EXPIRED';
    throw error;
  }
  validateTokenPayload('claude', payload);
  return normalizeTokens(payload);
}

// OAuth errors are terse and their meaning is not obvious from the wire. Say
// what the user can actually do about the ones that are common here.
function oauthErrorMessage(payload, status, raw, grant) {
  const code = payload?.error;
  const detail = payload?.error_description;

  if (code === 'invalid_grant') {
    // The same error code covers two very different failures. A refresh that is
    // rejected means the stored login is dead - usually rotated out by the
    // official client, which invalidates the copy we hold - and the advice
    // about single-use codes would be actively misleading.
    if (grant === 'refresh') {
      return 'This Claude login has expired or was renewed by Claude Code itself, so the saved token no longer works. Sign in again.';
    }
    return 'The authorization code was rejected. Codes are single-use and expire within minutes; start the sign-in again.';
  }
  if (code === 'invalid_client') {
    return 'Anthropic rejected the client id. Turntrail may need updating.';
  }
  if (code === 'invalid_request' && /code_verifier/i.test(detail || '')) {
    return 'The PKCE verifier did not match. Start the sign-in again rather than reusing an old code.';
  }
  if (status === 429) {
    return 'Anthropic is rate limiting sign-in attempts. Wait a minute and try again.';
  }
  return code ? `Token request failed: ${safeErrorCode(code)}.` : `Token request failed with HTTP ${status}.`;
}

function safeErrorCode(value) {
  const code = String(value || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 64);
  return code || 'provider_error';
}

function normalizeTokens(payload) {
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // Stored as an absolute epoch, which is the shape Claude Code's own
    // credential file uses. A relative lifetime is useless once written down.
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : CLAUDE_SCOPES,
    tokenType: payload.token_type
  };
}

// Who just signed in. The token response says nothing about the person, so the
// panel would have an unlabelled card without this.
export async function fetchClaudeProfile(accessToken, options = {}) {
  const response = await providerFetch(options.profileUrl || CLAUDE_PROFILE_URL, {
    headers: claudeApiHeaders(accessToken, options)
  }, options);
  if (!response.ok) throw new Error(`Profile request failed: ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderContractError('claude', 'profile response');
  }
  return normalizeClaudeProfile(validateClaudeProfilePayload(payload));
}

// Claude Code records identity in its config under `oauthAccount`. Writing the
// same shape means the official extension reads a switched account correctly
// rather than showing the previous email.
export function normalizeClaudeProfile(payload) {
  const account = payload?.account || {};
  const organization = payload?.organization || {};
  return {
    accountUuid: account.uuid,
    emailAddress: account.email,
    displayName: account.display_name || account.full_name,
    organizationUuid: organization.uuid,
    organizationName: organization.name,
    organizationType: organization.organization_type,
    billingType: organization.billing_type,
    organizationRateLimitTier: organization.rate_limit_tier,
    hasExtraUsageEnabled: organization.has_extra_usage_enabled,
    accountCreatedAt: account.created_at,
    subscriptionCreatedAt: organization.subscription_created_at,
    // `has_claude_max` / `has_claude_pro` are the plain answer to "what plan is
    // this", which the organization type only implies.
    plan: account.has_claude_max ? 'max' : account.has_claude_pro ? 'pro' : planFromOrganization(organization)
  };
}

function planFromOrganization(organization) {
  const type = organization?.organization_type;
  if (typeof type !== 'string') return undefined;
  return type.replace(/^claude[_-]/, '') || undefined;
}

// Every OAuth-authenticated Anthropic call needs the beta header, and a
// `claude-code/<version>` user agent. Without the latter the endpoints answer
// 429 indefinitely rather than 401, which is a genuinely confusing failure to
// debug (claude-code issues #31021, #31637).
export function claudeApiHeaders(accessToken, options = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': options.userAgent || DEFAULT_CLAUDE_USER_AGENT,
    Accept: 'application/json'
  };
}

export const DEFAULT_CLAUDE_USER_AGENT = 'claude-code/2.0.1';

// The loopback half of the browser flow. Bound to 127.0.0.1 so nothing off the
// machine can reach it, and closed the moment it has an answer.
export function startLoopbackServer(options = {}) {
  const port = options.port || CLAUDE_DEFAULT_CALLBACK_PORT;
  const expectedState = String(options.state || '');
  if (!expectedState) throw new Error('A PKCE state value is required before starting the callback server.');
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_LOOPBACK_TIMEOUT_MS;
  let settle;
  let settled = false;
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller does not await this immediately - it opens a browser first - so a
  // callback that arrives in the meantime would reject with nothing listening.
  // In the extension host an unhandled rejection is not a warning, it is a
  // crash. Marking it handled here is safe: awaiting `result` still receives it.
  result.catch(() => {});

  let timer;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, loopbackRedirectUri(port));
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const valid = Boolean(code && state && state === expectedState);
    response.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(callbackPage(valid));

    if (error) finish(new Error(`Claude sign-in was rejected by the provider (${safeErrorCode(error)}).`));
    else if (!code) finish(new Error('No authorization code was returned.'));
    else if (!state || state !== expectedState) finish(new Error('The sign-in response did not match this request. Start again.'));
    else finish(undefined, { code, state });
  });

  const closeServer = () => {
    try {
      server.close();
    } catch {
      // Already closing.
    }
  };

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeServer();
    if (error) settle.reject(error);
    else settle.resolve(value);
  };

  const close = (reason = new Error('Sign-in cancelled.')) => finish(reason);

  const listening = new Promise((resolve, reject) => {
    server.once('error', (error) => {
      const reported = error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use, so the browser has nowhere to return to. Use the code flow instead.`)
        : error;
      finish(reported);
      reject(reported);
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });

  timer = setTimeout(
    () => finish(new Error(`Claude sign-in timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Start again.`)),
    timeoutMs
  );
  timer.unref?.();

  return { port, redirectUri: loopbackRedirectUri(port), listening, result, close };
}

function callbackPage(ok) {
  const message = ok ? 'Signed in. You can close this tab and return to VS Code.' : 'Sign-in did not complete.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Turntrail</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#1a1a19;color:#f5f4ef}
p{font-size:1.1rem}</style></head><body><p>${message}</p></body></html>`;
}
