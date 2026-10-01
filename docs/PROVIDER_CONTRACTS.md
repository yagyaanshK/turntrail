# Provider Contracts

Turntrail's handoff path is provider-neutral and offline. The optional account panel is different:
it reads provider credential files and usage services, and its Claude sign-in performs an OAuth exchange.

These interfaces are **observed private contracts**, not stable APIs promised to Turntrail. Their URLs,
client identifiers, request formats, credential layouts, and response fields may change when Codex or Claude
changes. The current assumptions are centralized and versioned in
`packages/core/src/accounts/provider-contracts.js`.

## Failure behavior

Every successful token, profile, credential, and quota boundary is validated before its data is used. A
response that no longer has a recognized shape fails with:

```text
PROVIDER_CONTRACT_CHANGED
```

The error names the provider, operation, and local contract version. It never includes the response body or
credential value. Quota reads keep a previous valid cache as stale data; without a prior reading, the account
panel reports the compatibility error. Unrecognized successful responses are not cached as zero usage.

The pure usage normalizers remain tolerant so captured fixtures can be inspected during maintenance. Network
fetch functions apply the strict boundary check.

## Updating a contract

1. Reproduce the failure without sharing credentials or provider response bodies.
2. Update only the affected entry and validator in `provider-contracts.js`.
3. Increment that provider's observed contract version.
4. Add sanitized synthetic fixtures for the old failure and accepted new shape.
5. Run `npm test`, `npm run lint`, and the extension-host suite.

Do not test refresh flows with live tokens. Both providers rotate refresh tokens, so an exploratory request can
invalidate the login used by an official client. Prefer delegating new sign-in integrations to the provider's
official CLI whenever it exposes a non-interactive flow.

## Candidate: native Codex OAuth

The official open-source Codex client publishes enough implementation detail to reproduce its PKCE
loopback and device-code flows without launching the CLI. This is technically viable and would
remove the binary prerequisite from subscription sign-in. It is not a drop-in refactor: Turntrail
would begin handling Codex authorization codes, access tokens, rotating refresh tokens, callback
state, scopes, and credential serialization itself.

Before implementing it, require synthetic tests for PKCE and state validation, loopback binding and
expiry, single-use code exchange, cancellation, token-response validation, refresh-token rotation,
atomic `auth.json` writes, rollback, and upstream contract drift. Keep the existing auth-file import
as the no-network, CLI-free fallback.
