# Architecture

Turntrail has one durable idea: the continuity layer should live in the project, not inside a single vendor chat.

## Packages

```text
packages/core
  schema normalization
  native transcript adapters
  unified native + ledger session index
  context store filesystem layout
  importers
  workspace snapshots
  deterministic handoff generation
  accounts/            multi-account isolation, sign-in, quota

packages/cli
  command-line interface around core

packages/vscode
  extension host: sessions panel, managed CLI terminals, handoff commands, accounts panel, sign-in panel
```

Future wrappers should call `packages/core` instead of reimplementing ledger logic.

The two halves are independent. The **handoff** half is local-only and never touches the network.
The **accounts** half is optional, is the only part that makes network calls, and is not involved in
producing a handoff. Neither depends on the other.

## Data Flow

```text
Claude / Codex / Gemini / Cursor transcript
        |
        v
import adapter
        |
        v
normalized JSONL session
        |
        +--> workspace snapshot
        |
        v
deterministic handoff markdown
        |
        v
next agent session
```

## Shared Turn Schema

Each normalized turn is written as one JSON object per line:

```json
{
  "id": "turn_...",
  "provider": "anthropic",
  "surface": "cli",
  "sessionId": "optional-source-session-id",
  "role": "user",
  "timestamp": "2026-06-08T10:15:30.000Z",
  "content": "exact user message",
  "metadata": {
    "sourcePath": "claude-transcript.jsonl"
  }
}
```

## Native Adapters

Native adapters are read-only scanners for local agent transcript stores.

Claude Code:

```text
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

Codex:

```text
~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl
~/.codex/archived_sessions/rollout-*.jsonl
```

Codex names its threads but keeps the name out of the transcript, in an append-only index read
alongside the rollout files and joined on the thread id:

```text
~/.codex/session_index.jsonl   {"id", "thread_name", "updated_at"}
```

Codex mirrors these names into a `threads` table in `~/.codex/state_5.sqlite`, which is deliberately
not read. Measured against a real install of 64 threads, the table named nothing the index had not
already named and its `name` column was empty throughout, so reading it would buy a SQLite
dependency, locked-database handling and exposure to the drift between the two stores for nothing.

Gemini CLI:

```text
~/.gemini/tmp/<project-id>/chats/session-*.jsonl
~/.gemini/tmp/<legacy-project-hash>/chats/session-*.json
```

Current JSONL recordings are append-only. The adapter applies `$set` metadata updates and
`$rewindTo` records using Gemini's native semantics, so abandoned branches do not reappear in a
handoff. Legacy JSON recordings remain readable during Gemini's format migration. Project matching
uses the recording hash, the current `.project_root` marker, or Gemini's `projects.json` registry.

Cursor Agent:

```text
~/.cursor/projects/<encoded-project>/agent-transcripts/<session-id>/<session-id>.jsonl
```

Turntrail reads Cursor's dedicated Agent transcript files and does not open Cursor's live
`state.vscdb` or conversation-search databases. Main sessions are discovered by default; nested
`subagents/` recordings are optional at the core API and excluded from normal UI/CLI discovery.

Adapters should:

- parse JSONL line by line (and bound legacy whole-file JSON reads)
- preserve original content exactly where practical
- preserve local image paths instead of embedding base64 images
- filter by recorded `cwd` when available
- never rewrite native session files
- store source path and line number in metadata

Project matching canonicalizes existing paths through `realpath`, compares path segments rather than
string prefixes, and folds case only on Windows. This lets symlinked or junction-backed workspaces
match their native transcript while preserving case-sensitive behavior on Linux and macOS.

## Unified Session Index

`packages/core/src/session-index.js` presents native Claude, Codex, Gemini, and Cursor discovery plus
the current project ledger as one deterministic list. Rows are deduplicated by normalized source
path or native session id, retain provider-specific metadata in the core process, and expose stable
opaque ids for callers. Provider failures are isolated: a malformed transcript or unavailable store
does not erase rows discovered from other files or providers.

The VS Code Sessions webview is an untrusted presentation boundary. It receives only an opaque id
and display fields such as provider, title, timestamp, surface, size, and import state. Absolute
native paths and import descriptors stay in an extension-host map. Import, preview, and handoff
messages must resolve an id through that map; arbitrary paths from the webview are never accepted.

Ledger previews use `readSessionPreview` and `renderSessionPreview`. Manifest paths are validated to
remain inside the ledger sessions directory, content is read with explicit turn and byte ceilings,
and Markdown fences expand to contain any backtick run in transcript content. A clipped preview is
labelled rather than silently presented as complete.

## Managed CLI Terminals

`packages/vscode/src/managed-terminals.cjs` owns Claude and Codex terminals created from the
Sessions view. A managed terminal runs the provider executable as its direct terminal process. New
sessions receive the handoff as the initial prompt argument; resumed sessions use the provider's
native resume arguments plus that prompt. On Windows, executable discovery honors `PATH` order,
launches `.exe`/`.com` directly, and permits a sibling PowerShell npm shim only as a structured
argument vector. A bare `.cmd`/`.bat` shim is rejected rather than interpolating transcript-derived
text into a shell command.

Each terminal carries a random id, provider, workspace, native session id, and sanitized title in
its process environment. Those markers let a reactivated extension reattach to a terminal preserved
by VS Code. Only validated markers are accepted, and the Sessions webview receives only the random
id and display metadata. Terminal objects, executable paths, and workspace roots remain in the
extension host.

Live delivery checks that the direct agent process has not exited and requires user confirmation
because VS Code exposes no provider-neutral ready/busy/permission state for terminal TUIs. A known
destination native session id must match exactly; Turntrail will not inject into another active
session merely because it is the only terminal. After the provider exits there is no child shell to
interpret delayed text, and further injection is rejected.

## Workspace Snapshots

Snapshots include staged, unstaged, and untracked work, including repositories that do not yet have
a first commit. Git subprocess output, the untracked file count, and the rendered diff all have hard
bounds before they enter memory or a handoff. Credential-bearing remote URLs are redacted in the
snapshot; binary untracked content is identified but not embedded.

## Deterministic Packaging

The exporter never asks an AI to summarize. It builds a markdown handoff from:

- project manifest
- latest workspace snapshot
- selected transcript turns
- raw transcript references

If a budget is provided, the exporter includes turns by a deterministic priority order:

1. user turns, newest first; an oversized latest request is truncated into the budget rather than dropped
2. most recent assistant/tool/system turns
3. older assistant/tool/system turns while budget remains

Raw sessions remain available on disk even when not fully embedded.

### Reversible export attachments

Role caps and snapshot-diff caps keep a handoff readable, but their omission markers are reversible.
Before truncation, Turntrail sanitizes the complete block and stores that sanitized text under
`.turntrail/attachments/<sha256>.txt`. The marker in the handoff names the project-relative path and
the expected SHA-256 digest. Identical content shares one file.

Attachment hashes are recorded on the export manifest entry. When export retention removes an old
handoff, an attachment is removed only if no retained export references its hash. Attachment reads
validate the hash, enforce a byte ceiling, and resolve the path inside the ledger attachment
directory. Raw, unredacted transcript content is never copied into an attachment.

JSONL parsing is streaming and line-bounded. Discovery retains a bounded newest candidate set, and import/export enforce explicit turn and content ceilings. These limits bound memory without modifying the native source or the complete sessions already stored in the ledger; callers can deliberately raise them for unusually large workspaces. Core loops accept an abort signal, which the VS Code progress notification wires to its Cancel action.

Inline media handling:

- local image paths are shown as references when available
- inline `data:image/...;base64` payloads are replaced with compact omission markers
- long bare base64 blobs are replaced with compact omission markers
- raw native transcript files remain referenced for auditability

## Round Trips

A ledger that only flows one way needs none of this. One that ping-pongs does, and
`packages/core/src/roundtrip.js` holds the three mechanics involved.

**Plumbing removal.** Pasting a handoff puts the prompt into the receiving agent's transcript, and
the prompt tells that agent to read the handoff file — so re-importing it captures both. Left alone,
the next handoff carries a user turn that is really Turntrail's prompt, plus a whole handoff
document nested inside itself and truncated mid-page. `stripHandoffPlumbing` drops both. Detection
requires the reserved opening phrase, an exported handoff path, and the generated follow-up
instruction within the first 4000 characters. A user request that merely begins with the reserved
phrase is therefore kept.

**Per-agent watermarks.** `lastSeenBy` answers how far an agent has already seen: the later of the
last handoff aimed at it and its own last turn in the ledger. Both halves matter. Using the newest
export of any target loses work — hand off to Claude, refresh Claude again, return to Codex, and
everything Claude did before the refresh falls outside the window. Ignoring the agent's own turns
breaks the first return trip, where the agent has been sent no handoff at all but wrote half the
ledger itself.

Watermark comparisons parse timestamps as instants, so equivalent offsets compare correctly. Invalid
manifest timestamps are ignored; turns with missing or malformed timestamps remain in scoped exports
because Turntrail cannot prove that the receiving agent has already seen them.

**Origin chats.** `writeSession` records the native session id and the agent's own name for it, so
`originChat` can say which chat a handoff should be continued in, and the VS Code session picker can
offer it first. Only agent-assigned names are used; an unnamed session's opening request is not a
name, and for a session started from a handoff it is Turntrail's own prompt.

## Accounts

An optional subsystem for running several Codex subscriptions and Claude accounts on one machine.
It shares nothing with the ledger: its state lives in the home directory, because the same accounts
are the same accounts in every repo you open.

```text
~/.turntrail/
  accounts.json                    # registry: id, provider, label, email, plan
  accounts/<id>/
    codex-home/     or  claude-home/   # whatever that agent's CLI treats as its world
    quota.json                          # cached usage reading
```

### Isolation

Multi-account is multi-directory. Each CLI keeps its identity under one environment variable, so
pointing that variable at a per-account directory lets every account stay signed in at once:

| Agent | Variable | Credential file |
|-------|----------|-----------------|
| Codex | `CODEX_HOME` | `auth.json` |
| Claude | `CLAUDE_CONFIG_DIR` | `.credentials.json` |

Claude splits credential from identity. `.credentials.json` holds the tokens; the email and
organization live under the `oauthAccount` key of a separate config file. That file sits *beside*
the stock `~/.claude` home, at `~/.claude.json`, but moves *inside* any custom
`CLAUDE_CONFIG_DIR`. Both facts were verified on disk; getting either backwards means writing
identity into a file nothing reads.

### Credential sources, and what Turntrail does not touch

`~/.codex` is shared by more than one program, and they do not all authenticate the same way. This
matters because it bounds what switching an account can and cannot affect.

- The **Codex CLI** and the **Codex IDE extension** (VS Code, Cursor, and forks) read the OAuth
  credential at `~/.codex/auth.json`. This is the only credential Turntrail reads, renews, or
  rewrites when you switch a Codex account. Per OpenAI's own docs, all local Codex clients — CLI, IDE
  extension, and the desktop app — share this one cached login under `CODEX_HOME`, so signing in
  through any of them is reused by the others. Where it is stored is a setting,
  `cli_auth_credentials_store`: `file` (the default, `auth.json` in plaintext) or `keyring` (the OS
  credential store). Turntrail's per-account isolation assumes the `file` store; a `keyring`
  install keeps the token in the OS keystore instead, which is why no plaintext token is found there.
- The **Codex desktop app** keeps its *working data* in `~/.codex` too — a thread database
  (`state_5.sqlite`), a session index (`session_index.jsonl`), logs, and an Electron state file
  (`.codex-global-state.json`, which records the selected account by id). For its Codex credential it
  reads the same `auth.json`, but only at **startup**: a running process then holds that credential
  in memory and refreshes it in place against OpenAI, and does not re-read the file mid-session.

So a switch Turntrail makes by rewriting `auth.json` is invisible to an already-running desktop
app until it restarts, at which point it re-reads the file and adopts the new account. This was
observed end to end on a real install: with `auth.json` switched underneath it, the running app kept
serving the previous account and kept working *past that account's on-disk token expiry* — the live
token was the in-memory copy, refreshed in-process — and only moved to the file's account after a
restart. There is no second on-disk credential store for it: no plaintext token, OS
credential-manager entry, or browser session store could be found. `auth.json` is the single source,
  read once per launch.
  On Windows the installed `OpenAI.Codex` package declares `app/ChatGPT.exe` as its desktop host.
  Process guards identify that host using the package-qualified executable path rather than the
  ambiguous filename, and classify its matched Codex descendants as part of the same desktop client.

The practical consequence is the "a live process holds its own token" rule stated under Switching,
seen from the outside: rewriting `auth.json` moves the CLI and IDE extension at once, but any Codex
process already running — desktop app included — keeps the account it started with until its next
launch. Turntrail never needs to reach into a running app's memory or a second store, because
there isn't one.

### Sign-in

The two agents are handled differently, and the difference is forced by what their CLIs are:

- **Codex** — `codex login` prints plain text to stdout. Turntrail spawns it with
  `CODEX_HOME` set, parses the output to drive its own progress UI, and never performs the OAuth
  exchange. The credential is written by `codex`.
- **Claude** — `claude` and `claude setup-token` render an Ink terminal UI that requires raw mode
  on stdin, so a piped child process dies before printing anything; `setup-token` also writes no
  credential by design. The official VS Code extension avoids this by bundling the CLI runtime, which
  an extension cannot borrow. So Turntrail runs the same public PKCE flow the CLI runs and
  writes the credential itself.

**Consequence to state plainly:** for Claude, Turntrail performs the token exchange and handles
the tokens. It does not for Codex. The Claude endpoints are not a published contract, so
`accounts/claude-oauth.js` is written to fail loudly — every error path names what the user can do
about it — rather than degrade silently when they change.

Invariants for both:

- secrets are passed on stdin, never argv, so they never appear in a process listing
- provider HTTP calls have a 20-second default timeout and accept caller cancellation
- provider error response bodies are never copied into user-facing errors
- credentials are written `0600` (best-effort; Windows ignores POSIX modes)
- an existing login at `~/.codex` or `~/.claude` is never touched by adding an account
- failed or cancelled new-account attempts remove their provisional registry row and managed directory
- switching backs up what it replaces, and is undoable
- validation happens before any write, so a rejected paste cannot damage a working login

The Claude browser callback binds and advertises `127.0.0.1`, accepts only `GET /callback`, requires
the exact PKCE state, and closes on success, rejection, cancellation, or a five-minute timeout. The
login webview retains no DOM while hidden, clears secret fields as they are submitted, serializes
operations, and bounds captured child-process output.

### Switching

The official CLIs and extensions read one credential path each, so making an account "current" is
necessarily machine-wide. Codex is a single file copy. Claude is two writes: the credential, plus a
**patch** of the `oauthAccount` key in the config — the rest of that file is project history and
caches and must survive byte-identical.

The credential file is read at process start, not per request. An agent already running — a CLI
session, an IDE extension host, the Codex desktop app — has its token in memory and refreshes it
there, so a switch reaches it only when it next launches. The switch takes effect immediately for
anything started afterward; a live session keeps the account it began with until restart. This is
why the notification after a switch offers **Reload Window**.

### Quota

One cache path and one staleness policy for both providers, so they cannot drift apart:

- readings are cached five minutes per account; `force` overrides, `offline` never touches the network
- manual refresh cancellation propagates to the in-flight provider request
- a cached reading with **zero windows** never satisfies a read — that is a parse miss, not a fact,
  and would otherwise survive the upgrade that fixed it
- a failed refresh keeps the previous reading with its age, rather than blanking the display
- the Raw Response command makes one request and normalizes that same payload instead of polling twice
- Codex banked-reset counts come from `/wham/usage`; when non-zero, a best-effort details read adds
  individual expiry dates without making normal quota dependent on that second endpoint
- redemption uses the official Codex `/wham/rate-limit-reset-credits/consume` contract, a fresh UUID
  idempotency key, one non-retried POST, cache invalidation, and a forced usage refresh
- the headline number is the account's **tightest** window, because that is the one that stops you
- `resumesAt()` answers "when does this start working again", which is deliberately not the next
  reset: a window with room can reset sooner than the one blocking you, and several exhausted
  windows clear you only when the last of them resets. `nextResetAt()` is the plain earliest reset
  and must never be used to answer the first question

The two payloads are read differently on purpose. Codex's shape is undocumented and shifts, so the
normalizer walks the whole payload collecting anything that looks like a usage window. Claude's
response carries a curated `limits` array, so that is read directly — walking it generically invents
windows out of codenamed buckets sitting at 100% remaining and inflates the headline.

Claude access tokens expire every eight hours and the official client renews only the account it is
using, so Turntrail renews the others before reading their quota.

`accounts/maintenance.js` orchestrates periodic maintenance across both providers. It serializes
accounts behind a machine-wide lock under `~/.turntrail/`, skips API-key and unsigned accounts,
and inspects the process list before touching Claude's rotating refresh token. While Claude is
running, its live credential remains provider-owned and is only synchronized into the managed
snapshot. While Claude is stopped, Turntrail proactively refreshes a due active credential and
writes the live copy before the managed copy. A missing or blank live credential is repaired only
when a single account or retained live profile identifies its owner; ambiguity leaves it untouched.
Due maintenance is deferred without a provider request while Claude is running and retried after
15 minutes.
If a quota request returns `401` before the recorded access-token expiry, maintenance performs one
refresh-and-retry for an inactive account. It may also repair the selected machine-default account
when no provider process is running; a live owner causes the repair to be deferred.
The VS Code scheduler is application-scoped, disabled by default, and jittered around a five-hour
interval; `turntrail account maintain` exposes the same operation to OS schedulers.

## Privacy Model

`.turntrail/` is gitignored because it may contain:

- private conversations
- shell output
- changed file paths
- local branch names
- issue descriptions or client data
- proprietary code snippets

Publishing a project that uses Turntrail should not publish its local ledger by accident.

Account credentials are deliberately kept **out** of the project: they live in `~/.turntrail/`,
never in `.turntrail/`, so a repository can never carry a token even if the ledger is committed
by mistake.
