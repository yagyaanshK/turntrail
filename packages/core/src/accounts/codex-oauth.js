import { providerFetch } from './http.js';
import { PROVIDER_CONTRACTS, validateTokenPayload } from './provider-contracts.js';

// Renewing a Codex login without the browser.
//
// Codex signs in with OpenAI's OAuth. The access token is a JWT with its own
// expiry. The stored `refresh_token` mints a new one against the endpoint below
// - the same call the Codex CLI makes lazily when renewal is due.
//
// One property of this endpoint dictates how the rest of the account code has to
// behave: the refresh token is ROTATED on every use. A successful refresh
// returns a new refresh token and invalidates the one presented; presenting an
// already-used refresh token returns `refresh_token_reused` and can revoke the
// whole chain. So exactly one actor may ever refresh a given account. Context
// Bridge therefore refreshes only accounts the live Codex is not currently
// using, and writes the rotated token straight back so the next refresh has the
// current one to present.

export const CODEX_TOKEN_URL = PROVIDER_CONTRACTS.codex.oauth.tokenUrl;

// The public client id the Codex CLI itself uses. Verified against the `aud` of
// a real id_token and the `client_id` of a real access token on this machine.
export const CODEX_CLIENT_ID = PROVIDER_CONTRACTS.codex.oauth.clientId;

export async function refreshCodexToken(refreshToken, options = {}) {
  if (!refreshToken) {
    const error = new Error('This account has no refresh token, so its login cannot be renewed. Sign in again.');
    error.code = 'AUTH_EXPIRED';
    throw error;
  }
  // The endpoint takes a JSON body, unlike Anthropic's form-encoded one.
  const response = await providerFetch(options.tokenUrl || CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: options.clientId || CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email'
    })
  }, options);

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const error = new Error(codexOauthError(payload, response.status, text));
    if (isExpiredLogin(payload, text)) error.code = 'AUTH_EXPIRED';
    throw error;
  }
  validateTokenPayload('codex', payload);

  return {
    accessToken: payload.access_token,
    // Rotation: the response usually carries a fresh refresh token. If it does
    // not, the one we sent is still current and must be kept, not dropped.
    refreshToken: payload.refresh_token || refreshToken,
    idToken: payload.id_token,
    expiresIn: payload.expires_in
  };
}

// A reused refresh token is the one failure worth naming precisely, because the
// fix is different: not "try again" but "sign in again", and it is usually the
// symptom of two things having refreshed the same account.
function codexOauthError(payload, status, text) {
  const { code } = codexErrorFields(payload);
  if (isExpiredLogin(payload, text)) {
    return 'This login has expired or was renewed elsewhere and cannot be refreshed. Sign in again.';
  }
  if (code) return `Token refresh failed: ${safeErrorCode(code)}.`;
  return `Token refresh failed with HTTP ${status}.`;
}

function isExpiredLogin(payload, text) {
  const { code, detail } = codexErrorFields(payload);
  return code === 'invalid_grant' || code === 'invalid_refresh_token' || code === 'refresh_token_reused' ||
    /reuse|already been used|revoked|expired|invalid refresh token/i.test(`${code} ${detail} ${text}`);
}

function codexErrorFields(payload) {
  const nested = payload?.error && typeof payload.error === 'object' ? payload.error : undefined;
  return {
    code: nested?.code || nested?.type || payload?.error || payload?.code,
    detail: nested?.message || payload?.error_description || payload?.message || ''
  };
}

function safeErrorCode(value) {
  const code = String(value || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 64);
  return code || 'provider_error';
}
