# How Turntrail Keeps Logins Alive

This page explains when Turntrail renews a saved Codex or Claude Code login, what a limits refresh
does and does not do, what a card's **Repair login** button does, how background maintenance behaves,
and what changed in 0.18.23. It reflects Turntrail 0.18.25.

## Terms

- **Renewal** is a single request. Turntrail sends the login's saved refresh token and gets back a
  new access token plus a **new refresh token**. Both providers rotate the refresh token, so the one
  that was sent is spent. There is no separate "get a new refresh token" request: renewing is the
  only way to get one.
- **Inactive account**: an account added to Turntrail that the official client is not currently
  signed in as.
- **Active account**: the one Codex or Claude Code is currently signed in as, in `~/.codex` or
  `~/.claude`. Its renewal belongs to that client.
- **Needs repair**: the provider turned away the access token (a `401` on the limits request), but
  the refresh token has not been refused. A renewal may still fix it. The card's badge reads
  **Repair required**. Turntrail used to call this state "verify"; the providers themselves send only
  the `401`.
- **Sign in again**: the provider refused the refresh token itself. Only a new sign-in fixes it.

## Refreshing limits on a card or in the panel

Reading limits renews a login only when its access token is due, judged by the token's own expiry.
This behaviour is the same before and after 0.18.23.

| | Codex | Claude Code |
|---|---|---|
| Inactive account | Renews first if the access token expires within 3 days, then reads limits | Renews first if the access token has already expired, then reads limits |
| Active account | Never renews; Codex owns it | Never renews; reads the token Claude Code keeps fresh |
| Limits request rejected (`401`) | Card shows **Repair required**. No renewal is tried | Card shows **Repair required**. No renewal is tried |

A card's refresh button therefore does not usually fix an account that needs repair. Its access token is
usually not yet expired, so the refresh decides "not due", sends the same token, and is turned away
again. The exception is a Codex access token within 3 days of expiry: then the refresh does renew,
which can fix it. The refresh button only reads limits; renewing a login that needs repair is the job
of the card's **Repair login** button.

## Repair login

A card that needs repair shows **Repair login**. A card whose refresh token was refused shows
**Sign in again** instead. Repair login runs the same steps maintenance runs for a rejected login, for
that one account only:

1. Read limits again.
2. If they are still rejected, force one renewal:
   - Inactive account: renewed right away.
   - Active account while its client (Codex or Claude Code) is running: not renewed. Turntrail
     says the client is using the login and renews it itself; close the client to have Turntrail
     try.
   - Active account while its client is stopped: renewed and reinstalled (Codex), or renewed and
     written to Claude's own file first (Claude).
3. Read limits with the renewed login.

It goes through the same per-account lock and renewal log as every other renewal, so pressing it
repeatedly never spends a token twice, and never resends a refused one. The outcome is one of:

- **The login works again**, and the card shows its limits.
- **Sign in again**: the provider refused the refresh token. The card switches to **Sign in again**
  with the reason, and the message offers to start the sign-in.
- **Still rejected** after a successful renewal, or a network error: the card stays on **Repair required**,
  and the message gives the error.

Repair login works whether background maintenance is on or off.

While Claude Code is running, an active Claude login that has just expired is shown as **Waiting for
Claude Code to renew this login**, with the last reading kept. Claude Code renews it itself; nothing
about it is saved as a login failure (0.18.22).

## Background maintenance

Maintenance is off by default. When enabled, it runs about every 5 hours while an editor is open.
The 15-minute retry described below is a full maintenance run too, not a request for a new token.

Each run reads limits for every account. On the way it renews any account that is due under the
rules in the table above, plus:

- **Limits request rejected (`401`)**: this is the only place Turntrail forces a renewal on a token
  that is not yet due.
  - Inactive account: renewed right away.
  - Active account: waits ("deferred") if Codex or Claude is running; otherwise renewed and
    reinstalled.
- **Active Claude login while Claude is stopped**: renewed when within 4 hours of expiry, written to
  Claude's own file first and then to Turntrail's copy.
- **Active Claude login while Claude is running**: Turntrail copies Claude's latest token into its
  saved copy. If the login is within 4 hours of expiry, the run is marked **deferred** and retried in
  15 minutes, so it can be renewed once Claude exits.

A run is retried after 15 minutes when it was deferred, when another window already held the
maintenance lock, or when the whole run failed. Otherwise the next run is 5 hours later.

## What changed in 0.18.23

0.18.23 did not change *when* Turntrail renews. It changed *how* it renews.

| | Before | Now |
|---|---|---|
| A forced renewal on a `401` fails | The error ended the whole run, no later account was maintained, and every window retried every 15 minutes | Only that account is marked **sign in again**; the run continues and counts as done |
| Codex `refresh_token_invalidated` | Not recognised, so the card stayed on "verify" and the dead token was resent every run | Recognised: "Signed out or signed in elsewhere · sign in again", and the token is not sent again |
| Two windows renew the same login | Possible from a panel refresh, because only maintenance had a lock | One at a time per account; the second window reuses the first one's result |
| A window closes during a renewal | The request was cancelled, and the new token could be lost | The request finishes and the token is saved; 60-second timeout instead of 20 |
| Record of renewals | None | `renewals.json` per account, with outcome and fingerprints only |

### Sign in again, with the reason

When the refresh token is refused, the card says why, following the distinctions Codex itself makes:

| Provider code | Card shows |
|---|---|
| Codex `refresh_token_expired` | Login expired · sign in again |
| Codex `refresh_token_reused` | Login renewed by another copy · sign in again |
| Codex `refresh_token_invalidated` | Signed out or signed in elsewhere · sign in again |
| Claude `invalid_grant` | Login expired or renewed elsewhere · sign in again |

A `401` on a login whose refresh token is already on record as refused is also shown as **sign in
again**, not **Repair required**.

### One renewal at a time

Every renewal, whether from maintenance, a panel refresh or a switch, goes through one path:

1. Take a per-account lock, shared by every editor window (VS Code, Kiro, Cursor) and the CLI.
2. Re-read the login and the renewal log.
3. Use the login as it is now, without renewing, if another window renewed it meanwhile or within
   the last two minutes.
4. Never send a refresh token the provider has already refused.
5. Otherwise renew, save the result, record the outcome, and release the lock.

A log without the lock would not be enough. VS Code and Kiro could both read "no recent renewal" at
the same moment and both spend the same token, which is how a login gets killed.

### The renewal log

Each account has `~/.turntrail/accounts/<id>/renewals.json` (`~/.context-bridge/...` on older
installs), keeping the last 50 attempts. Each entry records:

- when it started and finished;
- the provider and what asked for it (`maintenance`, `panel`, or `turntrail` for other callers);
- which program sent it (for example `Code.exe`, `Kiro.exe`, or `node` for the CLI);
- the outcome: `renewed`, `dead` (the refresh token was refused), `failed`, or `interrupted`;
- 12-character SHA-256 fingerprints of the refresh token spent and the one received.

It never contains a token, and a fingerprint cannot be used as one. An attempt still marked as
started after its lock went stale is recorded as `interrupted`, because its process exited before
the answer arrived. That case is worth knowing about if the next renewal is refused.

## Where it lives in the code

- `packages/core/src/accounts/renewals.js`: the per-account lock, re-read, refused-token check,
  renewal log, and the renewal's own timeout.
- `packages/core/src/accounts/quota.js`: limits reads, and the decision between **needs repair**,
  **sign in again** and **waiting for Claude Code**.
- `packages/core/src/accounts/maintenance.js`: maintenance runs, each account kept separate.
- `packages/core/src/accounts/codex.js` and `claude.js`: when a login is due
  (`ensureCodexAccessToken`, `ensureClaudeAccessToken`, `maintainIdleClaudeLogin`).
- `packages/core/src/accounts/codex-oauth.js` and `claude-oauth.js`: the renewal requests and how
  refusals are read.
- `packages/vscode/src/account-maintenance.cjs`: the 5-hour schedule and the 15-minute retry.
- `repairAccountLogin` in `packages/vscode/src/extension.cjs`: the card's **Repair login**, which runs
  maintenance for one account (`maintainAccounts({ accountIds })`).
