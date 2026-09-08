# Security Model

Turntrail is a local developer tool. The handoff path does not upload transcripts, snapshots, or exports. The optional account and quota features communicate only with the configured provider endpoints.

## Private data

The `.turntrail/` ledger is a verbatim working record. Native transcripts, command output, paths, and workspace snapshots can contain sensitive information. Keep the directory excluded from version control and do not share it as an archive.

Generated handoff Markdown applies deterministic redaction to common credential assignments, authorization headers, private keys, JWTs, provider token formats, and credentials embedded in HTTP Git remotes. It also removes inline base64 media. Pattern-based redaction cannot recognize every private value, so review an export before posting it publicly.

When Turntrail truncates a transcript turn or workspace diff, it stores the complete **sanitized**
text in `.turntrail/attachments/` and links it from the omission marker. Attachments are named by
their SHA-256 digest, deduplicated, integrity-checked on read, and garbage-collected when no retained
export references them. They never contain the pre-redaction block, but they can still contain
private source text that no pattern recognized. Treat them with the same care as handoff exports.

## Filesystem boundaries

Account and session identifiers are restricted to safe filename segments. Manifest paths are resolved and verified inside their expected ledger directory before being read. Registry and manifest updates use atomic replacement plus a bounded cross-process lock so concurrent editor windows cannot silently discard each other's updates.

## Provider compatibility

The optional account panel depends on observed private provider interfaces. Successful token, profile,
credential, and quota payloads are validated before use; incompatible shapes produce a redacted, versioned
compatibility error instead of being accepted or cached. See [Provider Contracts](PROVIDER_CONTRACTS.md) for
the contract inventory, failure behavior, and maintenance procedure.

## Account switch isolation

Turntrail never replaces a live provider credential while that provider has a running process. IDE
background services count because they retain authentication state and can refresh persisted tokens.
The Windows Codex app is hosted by `ChatGPT.exe`; Turntrail classifies that executable as Codex only
when its resolved path is inside an `OpenAI.Codex` application package. A separately installed
ChatGPT client is neither blocked nor terminated based on its process name alone.
When the extension queues a switch, a detached local helper waits for three consecutive process-free
polls and then calls the same fail-closed switch routine used by the CLI. The routine checks the
process list again before its final atomic credential copy.

The extension can terminate matching provider processes only after a modal confirmation that active
runs may be interrupted. It re-enumerates immediately before termination rather than trusting PIDs
captured by the earlier prompt, targets only processes that still match the selected provider, and
reports any process that remains or restarts. Credential activation still performs its own process
checks afterward, so termination does not weaken the fail-closed switch boundary.

Queued request files live in the extension's global storage, are written `0600` where supported, and
contain an account id, a bounded blocker description, a deadline, and editor relaunch metadata. They
never contain access tokens, refresh tokens, API keys, or credential contents. Requests expire after
15 minutes; malformed, expired, raced, or failed requests do not modify the live provider login.

## Background account maintenance

Background maintenance is disabled by default and can be enabled only through an application-level
user setting. A workspace cannot opt the user in. When enabled, the editor contacts only the
configured OpenAI and Anthropic token and usage endpoints on a jittered interval. It sends no
transcript content, telemetry, or model/inference request. API-key accounts are skipped.

A machine-wide lock serializes editor windows, VS Code forks, and CLI schedulers. Inactive OAuth
accounts are refreshed only when their access-token expiry says renewal is due. Turntrail never
refreshes a Claude credential while a Claude process is detected; it validates and synchronizes
that client's rotated credential back into the managed snapshot instead. When Claude is stopped,
Turntrail may refresh the active credential and writes the official live copy before its managed
copy to minimize the chance of stranding the official client with the invalidated refresh token. Missing
or blank live credentials are restored only when account identity is unambiguous. Process detection
cannot provide a cross-vendor lock: starting Claude during the short refresh request remains an
inherent race, so malformed credentials and unknown or ambiguous identities fail closed. Provider
calls retain the same bounded timeout, cancellation, payload validation, and redacted error
handling as manual quota reads.

An unexpected provider `401` can trigger one refresh-and-retry. Turntrail performs that repair only
for an inactive account, or for the selected account after confirming that no provider process is
running. A selected credential owned by a live provider process is deferred, never refreshed in
parallel.

Maintenance is not represented as a guaranteed keep-alive. It makes no synthetic inference request,
cannot prevent provider-side revocation, and runs from the extension only while an editor is open.
API-key accounts have no rotating OAuth credential and are skipped. The CLI maintenance command is
available for users who deliberately configure an operating-system scheduler.

A Codex OAuth account is verified with a refresh-token rotation before activation, including when
its access-token JWT still appears locally valid. Verification runs only after the process guard
confirms Codex is stopped; rejection or network failure leaves the live default credential
unchanged. This avoids reporting a successful switch based only on copying an `auth.json` whose
session has already been revoked server-side.

## Untrusted metadata

Transcript content is intentionally passed to the receiving agent as historical conversation. Paths, branch names, session labels, media references, and other metadata are separately flattened and escaped so they cannot add Markdown sections or close a fenced block. Handoffs explicitly tell the receiving agent to treat metadata as data, never instructions.

## Managed terminals

Managed Claude and Codex terminals launch the provider as the direct terminal process and pass a
handoff prompt as one argument. Turntrail does not concatenate prompt or transcript data into a
shell command. Windows command resolution honors `PATH` order, directly launches native
executables, and accepts only a structured PowerShell script invocation when an npm shim has a
sibling `.ps1`; unsafe bare command shims fail.

Session identifiers reject control characters, transcript-derived terminal titles are flattened and
stripped of terminal control bytes, and prompts have a 16 KiB ceiling. Live injection resolves an
opaque random terminal id in the extension host, verifies that the provider process has not exited,
and asks the user to confirm that the TUI is ready for ordinary input. A closed agent cannot expose
an underlying shell because the agent itself, rather than a shell, owns the terminal process.

## Reporting

Do not include credentials, private transcripts, or a populated `.turntrail/` directory in a report. Open a GitHub security advisory for vulnerabilities that would expose data or modify files outside the documented boundaries.
