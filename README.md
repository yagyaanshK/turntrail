# Turntrail

**Continue the same coding session across different AI agents — without asking one AI to summarize another.**

Turntrail is a local, vendor-neutral handoff layer for developers who switch between agentic coding tools such as **Claude Code**, **Codex**, **Gemini CLI**, and **Cursor Agent**. It captures native transcript content and a workspace snapshot, then generates a clean handoff you paste into the next tool.

[**Install Turntrail from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=turntrail.turntrail)

- 🔒 **Local handoffs** — transcripts and snapshots stay under `.turntrail/`; the handoff path has no telemetry or network calls.
- 🧾 **Lossless** — native transcripts are imported verbatim as JSONL. No AI summary in the core flow.
- ✂️ **Lean handoffs** — duplicate turns are collapsed, noisy tool output is trimmed, inline screenshots are stripped, and common credential formats are redacted before export.
- 🧰 **Two ways to use it** — a `turntrail` CLI and a VS Code extension (works in forks like Cursor, Windsurf, and Google Antigravity).
- 👥 **Many accounts, one panel** — keep several Codex subscriptions and Claude accounts signed in at once, see what each has left, and switch the official tools between them.

---

## See Turntrail in action

Find the exact conversation and continue it in another agent:

![Turntrail Sessions view with Claude, Codex, Gemini, and Cursor conversations and cross-agent handoff controls](packages/vscode/media/marketplace/01-cross-agent-handoff.png)

See quota across Codex subscriptions, switch the active login, and use banked resets:

![Turntrail Accounts view showing three Codex subscriptions, quota windows, and a banked reset](packages/vscode/media/marketplace/02-account-quotas.png)

Keep multiple Claude Code accounts signed in and ready to use:

![Turntrail Accounts view showing two Claude Code accounts and their usage windows](packages/vscode/media/marketplace/03-claude-accounts.png)

Review the deterministic local handoff before the next agent reads it:

![A Turntrail handoff document open beside the unified Sessions view](packages/vscode/media/marketplace/04-local-handoff.png)

---

## The problem

You use more than one coding agent in the same project — one is better at refactors, another at UI, another at review. The pain is **continuity**: after a real session in one tool, the next tool starts with partial context, stale assumptions, or a lossy summary.

Turntrail treats continuity as a **local project artifact**, not a feature of any one vendor.

---

## Install

**VS Code Marketplace (recommended):**

[Open Turntrail in the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=turntrail.turntrail),
then choose **Install**. You can also search for `Turntrail` in the Extensions view inside VS Code.

**VSIX for compatible editors:**

Download the VSIX from the
[latest GitHub release](https://github.com/yagyaanshK/turntrail/releases/latest). In your editor,
run **“Extensions: Install from VSIX…”** and select the downloaded file. This works in VS Code and
compatible forks such as Cursor, Windsurf, and Google Antigravity.

**From source (CLI + extension):**

```bash
git clone https://github.com/yagyaanshK/turntrail.git
cd turntrail
npm install
npm test
```

Run the CLI:

```bash
node packages/cli/bin/turntrail.js --help
```

To build the extension locally:

```bash
npm run package:vscode
```

Install `dist/turntrail-<version>.vsix` using **“Extensions: Install from VSIX…”**. Generated VSIX
files are release artifacts and are not committed to the source tree.

## Quick start (CLI)

```bash
turntrail init                                  # create the .turntrail/ ledger
turntrail discover --provider claude            # find native Claude Code sessions
turntrail import-native --provider claude --last # import the most recent one
turntrail import-native --provider gemini --last # Gemini CLI also works
turntrail import-native --provider cursor --last # as does Cursor Agent
turntrail snapshot                              # capture git + file state
turntrail export --to codex                     # write a handoff for Codex
```

The handoff markdown lands in `.turntrail/exports/`. Paste it (or point the receiving tool at the file) and keep working.

### Choosing which session

When more than one agent session was started in the same folder, Turntrail asks which one to
hand off rather than taking the most recently touched. Sessions in one folder are not
interchangeable — a long-running chat, a quick one-off and an abandoned experiment all look the same
to a timestamp — and the last one you happened to focus is often not the one worth continuing. The picker calls each
session by the name the agent itself gave it. Claude Code writes that name into the transcript; Codex
keeps its thread name — the one in the app sidebar, and whatever `/rename` was given — outside the
transcript in `~/.codex/session_index.jsonl`, which Turntrail reads and joins on the thread id.

What is left unnamed is mostly machinery: forks and subagent runs, which the agent never names and
which the app does not list. For those the opening request is a poor stand-in, because sessions
forked from a common parent share it word for word and would render as identical rows, so the most
recent substantive request leads instead — that is where they diverge. Trailing replies like "yes" or
"continue" are skipped when choosing it. Every row also carries age, surface, size and whether the
session was forked, and subagent transcripts are labelled as such.

Set `turntrail.alwaysUseLatestSession` to skip the question and always take the newest.

## Quick start (VS Code)

Open the Turntrail activity-bar icon and use **Sessions** to see Claude, Codex, Gemini, and Cursor
conversations together. Search or filter the list, then import, preview, or hand off the exact
session you want. The default workspace scope hides unrelated conversations; switch to
**Everywhere** when you deliberately need another project.

For a direct handoff, choose Claude or Codex and new or existing beside the session. Turntrail
imports that session when needed, snapshots the workspace, and writes the handoff. Choose
**Clipboard** to paste its short prompt yourself, or **Managed CLI** to launch/resume the official
Claude or Codex CLI with the prompt already supplied. The **Handoff** card and command palette remain
available for the latest-session workflow:

1. Run **`Turntrail: Handoff to New Claude Session`** (or Codex / “Existing”).
2. It imports the latest session from the *other* tool, snapshots the workspace, and writes the handoff.
3. A short prompt is **copied to your clipboard** (the notification tells you the word count).
4. Paste it into the target agent.

---

## How a handoff stays small and faithful

A raw multi-tool session can be megabytes. Turntrail shrinks the **export** deterministically while leaving the on-disk transcript complete:

| Step | What it does |
|------|--------------|
| **Collapse duplicates** | Native logs record one message under several event types; consecutive identical turns are merged (legitimately-repeated output is kept). |
| **Trim tool/system noise** | Oversized tool outputs (git diffs, dir listings) and repeated system blobs are middle-truncated, keeping head + tail. The complete sanitized content is stored as a SHA-256-addressed local attachment and linked from the exact marker. |
| **Strip inline media** | Base64 screenshots are replaced with compact placeholders. |
| **Redact secrets** | Common tokens, authorization headers, credential assignments, private keys, JWTs, and authenticated Git URLs are replaced deterministically. |
| **Never summarize** | User and assistant prose is preserved verbatim. |

The ledger header of every export reports exactly what was collapsed and truncated.

JSONL sources are streamed rather than loaded as one string. Discovery, individual lines, imported turn counts, and the ledger window used by one export have explicit safety limits with actionable errors instead of consuming unbounded extension-host memory. VS Code discovery/import/handoff notifications are cancellable. If the newest user request alone is larger than the export budget, Turntrail includes a head-and-tail truncation of that request rather than dropping it behind assistant output.

---

## CLI reference

| Command | Purpose |
|---------|---------|
| `init` | Create the `.turntrail/` ledger. |
| `import --provider <name> [--surface <name>] <file>` | Import a JSON / JSONL / Markdown / text transcript. |
| `discover --provider claude\|codex\|gemini\|cursor [--all]` | List native sessions for this workspace. |
| `import-native --provider claude\|codex\|gemini\|cursor [--last\|--session <id>]` | Import a native agent session. |
| `run claude\|codex\|gemini\|cursor [-- <native args>]` | Launch the agent and import the session it changed. |
| `snapshot` | Capture a git + file-metadata workspace snapshot. |
| `export --to <target> [options]` | Generate a handoff markdown file. |
| `status` | Print ledger counts. |
| `accounts [--refresh]` | List Codex subscriptions with remaining quota. |
| `account add <label> [--import]` | Register a subscription; `--import` adopts your current login. |
| `account use <id>` | Make a subscription the machine default for the official CLI. |
| `account remove <id> [--purge]` | Forget a subscription; `--purge` deletes managed credentials and its live default login when active. |

> **The `account` commands are Codex-only.** Claude accounts are managed from the VS Code panel;
> the CLI's `--provider claude` flag reads Codex paths and will misreport them. See
> [docs/CLI.md](docs/CLI.md#accounts).

**Export options:** `--max-chars <n>` (budget, default 120000, 0 = off) · `--no-dedupe` · `--since-last-export` (per target) · `--tool-max-chars <n>` (default 2000) · `--system-max-chars <n>` (default 800) · `--snapshot-diff-max-chars <n>` (default 4000) · `--keep-exports <n>` (default 10) · `--no-summary`. All flags accept kebab- or camelCase.

### Handing work back and forth

Work rarely goes one way. You make progress in Codex, hand off to Claude, and later want the original
Codex chat to pick it up again — with what Claude did, not with its own history read back to it.

The ledger accumulates: each import adds a session file, and a handoff merges all of them in timestamp
order, so the document going back to Codex carries both agents' turns, provider-tagged. Three things
make the return trip work rather than merely function.

**It names the chat to return to.** The ledger records which native chat each session came from, so a
handoff back to Codex says *this work started in your codex chat named "job apply"* and the session
picker offers that chat first, marked `already in this workspace ledger`. Only chats the agent named
itself are quoted; an unnamed one is left unnamed rather than described by an opening request that,
for a session started from a handoff, is Turntrail's own prompt.

**It leads with what changed.** A returning agent wrote most of the history below; what it does not
know is what happened while it was away. **Since You Last Saw This Session** states when it last
worked on the session, how many turns each agent has recorded since, what the user asked in the
meantime, what the other agent claims it did, and which files it wrote.

**It drops its own plumbing.** Pasting a handoff puts the prompt into the receiving agent's
transcript, and the agent then reads the handoff file — so without care the next handoff carries a
user turn that is really Turntrail's prompt, and a whole handoff document nested inside itself,
truncated mid-page into noise. Both are recognized and dropped, and the count is reported in the
Ledger section. A turn that merely mentions a handoff is left alone.

Turn on `sinceLastExport` to send only what the receiving agent has not seen. Its watermark is its own
last turn or the last handoff aimed at it, whichever is later — so an agent is never re-sent its own
history, and work never falls between two handoffs aimed at the same agent.

### What a handoff contains

| Section | Purpose |
|---------|---------|
| Rules for the receiving agent | Treat the transcript as history, verify before editing. |
| **Since You Last Saw This Session** | Only on a return trip: when this agent last worked on the session, what each agent recorded since, what the user asked meanwhile, what the other agent claims it did, files it wrote, and which chat to continue in. |
| **Where This Left Off** | The last real user request and the last assistant message, verbatim; files written and recent commands, derived from recorded tool-call arguments. Extractive only — nothing is generated. |
| Ledger | Counts, plus exactly what was collapsed, truncated, dropped for budget, or removed as handoff plumbing. |
| Latest Workspace Snapshot | Branch, HEAD, remote, top-level entries, `git status`, the uncommitted diff, and a `git log -1` check so the receiver can tell whether the workspace moved on. |
| Transcript Turns | The budgeted transcript, newest activity prioritized, user turns reserved first. |

---

## VS Code commands & settings

The extension contributes **Sessions** and **Accounts** panels in the activity bar plus
command-palette entries. Sessions provides one searchable index across native and imported
Claude, Codex, Gemini, and Cursor conversations. Its previews are bounded and generated from the
normalized local ledger; native transcript paths are not sent into the webview.

**Commands** (Command Palette → “Turntrail: …”): Discover / Import Latest (Claude·Codex), Handoff to New/Existing (Claude·Codex), Open Latest Handoff, Copy Latest Handoff Prompt, Add / Import Account, Switch Account, Refresh Account Quota, Rename Account, Remove Account, Show Raw Response.

**Settings** (`turntrail.*`):

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (0 = off). |
| `systemMaxChars` | `800` | Truncate long system turns (0 = off). |
| `maxExportChars` | `120000` | Character budget for the transcript (0 = off). User turns are reserved first, then the most recent turns fill the budget. |
| `sinceLastExport` | `false` | Send only what the receiving agent has not seen — its own last turn, or the last handoff aimed at it, whichever is later. |
| `snapshotDiffMaxChars` | `4000` | How much uncommitted diff to embed (0 = stat only). |
| `keepExports` | `10` | Past handoff files to keep; older ones are deleted (0 = keep all). |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow opening `vscode://` links (keep off in forks). |
| `alwaysUseLatestSession` | `false` | Skip the picker when several sessions match this workspace and take the newest. |
| `claudeUri` | `vscode://anthropic.claude-code/open` | URI used to open Claude, when the setting above is on. |
| `claudeOpenCommand` | `""` | Exact command id to open Claude. Empty means auto-detect. |
| `codexOpenCommand` | `""` | Exact command id to open Codex. Empty means auto-detect. |
| `accountMaintenance.enabled` | `false` | Opt into background OAuth maintenance and quota reads while the editor is open. |
| `accountMaintenance.intervalHours` | `5` | Hours between background runs, with timing jitter (1-24). |

---

## Multiple accounts

If you hold more than one Codex subscription or Claude account, Turntrail keeps them all
signed in at once and shows what each has left. The **Accounts** panel in the activity bar lists
them in two labelled sections — Codex and Claude Code — each with its own cards, usage bars and
pooled total. Nothing is pooled *across* the two: the quotas are not the same currency and switching
one has no effect on the other.

Each limit window gets **its own labelled bar** — a Claude account shows one for the five-hour
window and one for the weekly, a Codex subscription shows whichever its API reports. Each bar is
coloured by its own state and carries its own reset, so a healthy weekly allowance is not painted
red because the short window beside it is spent. The percentage beside the account name stays the
tightest window, since that is the one that will actually stop you. Codex reports a second window
only sometimes: when an account is sitting on its weekly cap it sends `secondary_window: null` and
there is genuinely one limit to show. **Raw Response** shows what arrived.

### The mechanism is one environment variable

Each CLI keeps its identity under whatever its config variable points at, so every account gets its
own directory and nothing has to be swapped:

| Agent | Variable | Per-account directory |
|-------|----------|----------------------|
| Codex | `CODEX_HOME` | `~/.turntrail/accounts/<id>/codex-home` |
| Claude | `CLAUDE_CONFIG_DIR` | `~/.turntrail/accounts/<id>/claude-home` |

Claude's layout has one asymmetry worth knowing, because it is easy to get backwards: the config
file sits *beside* the stock `~/.claude` home, at `~/.claude.json`, but moves *inside* any custom
`CLAUDE_CONFIG_DIR`. The email the client displays lives in that config, not in the credential.

### Signing in

Every method is a card in the sign-in panel that expands in place, so one that will not work can be
abandoned without losing the others.

**Codex** — Turntrail launches the **official** `codex` binary with `CODEX_HOME` set, reads its
output to drive the progress display, and never performs the OAuth exchange or holds a token. Five
methods: browser, device code, access token, API key, or pasting an existing `auth.json`.

**Claude** — this one is different, and the difference is forced rather than chosen. Claude Code's
login is an Ink terminal UI that requires raw mode on stdin, so a piped child process dies before
printing anything; `claude setup-token` is the same UI and writes no credential by design. The
official VS Code extension sidesteps this by *being* the CLI — it bundles the runtime — which is not
something another extension can borrow. So Turntrail runs the same public PKCE flow the CLI
runs, against the same client id, and writes the credential itself.

> **This means Turntrail performs the token exchange for Claude and handles those tokens**,
> which it never does for Codex. The endpoints involved are not a published contract and can change
> without notice; the flow is written to fail loudly rather than silently when they do.

Four Claude methods: browser via a loopback callback on port 54545, an authorization code needing no
local port (for SSH and containers), adopting the login already at `~/.claude`, or pasting a
`.credentials.json` from another machine. macOS keeps Claude credentials in the Keychain rather than
a file, so the adopt and paste methods have nothing to read there.

For both agents, choosing a file rather than pasting keeps the credential out of the panel entirely.
Credentials are written `0600`, and secrets go to stdin, never argv.

### Quota

Readings come from the same usage endpoints the official clients use, cached five minutes per
account. A failed refresh keeps the last good reading rather than blanking the display.

When an account is out of quota the card says **when it comes back**, not just that it is blocked.
That time is the reset of the window actually holding you — which is not always the next reset. A
five-hour window can clear in an hour while an exhausted weekly allowance keeps you blocked for
days, and when several windows are exhausted you resume only once the last of them clears. Accounts
with more than one window list each one with its own reset beneath the bar.

For Codex subscriptions, the card also shows any **banked usage resets** reported by OpenAI. When
details are available it shows the earliest expiry. **Use reset** asks for confirmation, consumes
one reset through the same endpoint used by the official Codex client, and immediately refreshes
that account's quota. Turntrail never redeems a reset automatically and never retries the
account-changing request; after a timeout it tells you to refresh before trying again.
Access tokens expire, and each official client normally renews only the account it is currently
using. A quota read renews an inactive OAuth account only when its access-token expiry says renewal
is due. While Claude is running, the official client owns its rotating refresh token and Turntrail
only copies the latest credential back into the managed snapshot. While Claude is stopped,
Turntrail can proactively renew the active login and atomically update both copies, writing the live
credential first. It can also restore a missing or blank live credential when one managed account,
or the retained Claude profile, identifies the account unambiguously. API-key accounts have no
OAuth token to maintain and are skipped.

Background maintenance is **off by default**. When a managed Codex or Claude account is first
detected, Turntrail offers a one-time opt-in; you can also run **Turntrail: Toggle Background Account
Maintenance** or **Turntrail: Run Account Maintenance Now**. Enabled maintenance runs about every
five hours while an editor is open, with timing jitter. Each run updates quota caches and renews due
inactive OAuth accounts only when credential ownership is safe. A machine-wide lock prevents several
VS Code-compatible editors or CLI jobs from refreshing the same token concurrently. If Claude is
still running when renewal becomes due, Turntrail makes no provider request and retries locally
after 15 minutes. There is no inference request, generated prompt, telemetry, or Turntrail server
involved.

If a provider rejects a locally unexpired access token during maintenance, Turntrail attempts one
refresh and retries the usage check. It repairs the selected machine-default credential only when no
process for that provider is running; otherwise it defers instead of racing the official client.

This is recovery hardening, not a login-lifetime guarantee. Neither provider documents a fixed
inactivity lifetime that a third-party tool can promise to defeat, and a provider can revoke a
session independently of its local expiry. Maintenance also cannot run while every editor is closed;
use `turntrail account maintain --json` from an OS scheduler for that case. API-key accounts have no
OAuth refresh token and are skipped.

```bash
turntrail account add "Primary" --import   # Codex: adopt the login you already have
turntrail account add "Subscription 2"     # then run the printed `codex login`
turntrail accounts --refresh               # remaining quota per subscription
turntrail account maintain --json          # maintain all providers; suitable for an OS scheduler
```

### Switching

Click **Use this** and the official CLI and extension for that agent start using the account — they
read one credential path each, so switching rewrites it and the change is machine-wide. For Claude
that means two files: the credential, plus the `oauthAccount` key inside `~/.claude.json`, because
that is where the displayed email actually lives. Everything else in that file — project history,
caches — is left byte-identical, and both files are backed up first.

Turntrail checks the operating-system process list immediately before replacing the credential. If
the provider is stopped, the switch is immediate. If `codex`, `claude`, the Codex Windows desktop
app, or an IDE background service is running, the extension offers **Stop Processes & Switch** or
**Wait for Me to Stop Them**. The Codex Windows package currently hosts its desktop UI in
`ChatGPT.exe`; Turntrail recognizes it only from the package-qualified `OpenAI.Codex` path, so a
separate ChatGPT installation is not treated as Codex. The
first action explicitly terminates only matching provider processes after warning that active runs
can be interrupted. The second starts a detached helper that waits until every provider process has
exited for three consecutive polls, performs the same guarded switch, and reopens the initiating
workspace. Unrelated editor windows can remain open, but a window whose Codex or Claude extension
keeps restarting its provider service may need to be closed or have that extension disabled. The
credential path is machine-wide across compatible editors, CLI sessions, and desktop clients.

Before installing a Codex OAuth account, Turntrail renews its saved refresh token even when the
access-token JWT still claims to be unexpired. This verifies the login with OpenAI and catches
server-side revocation before the live `auth.json` is replaced. A rejected or
unreachable verification leaves the current Codex login unchanged and does not report success.

The queued request expires after 15 minutes and contains only an account id, bounded process
metadata, and the editor path needed for relaunch — never credentials. If the provider restarts
before the quiet period or the request expires, the live credential is left unchanged. After signing
in again to an account that is already selected, **Update Claude login** or **Update Codex login**
runs the same guarded verification and replacement so the repaired managed credential reaches the
official client.

The account in use is marked in the panel and shown in the status bar with its remaining quota.
Every account stays signed in, so this is cheap and reversible; the toast offers **Undo**. To use an
account *without* changing the default, use **Terminal**, which scopes the variable to that one
session.

**Switching is manual and deliberate.** Turntrail shows you what each account has left and lets
you choose; it does not silently fail over when one runs out.

---

---

## The ledger

```text
.turntrail/
  manifest.json          # index of sessions, snapshots, exports
  sessions/              # imported transcripts (JSONL, verbatim)
  snapshots/             # git + file-metadata snapshots
  exports/               # generated handoff markdown
  attachments/           # reversible sanitized content omitted from exports
```

`.turntrail/` is **git-ignored by default** because the ledger contains private transcripts, command output, and file paths. Export attachments contain redacted content rather than raw transcript bytes, are deduplicated by SHA-256, and are removed when no retained export references them. Export redaction is defense in depth, not a reason to publish the ledger. See [docs/SECURITY.md](docs/SECURITY.md).

---

## For AI agents

> This section is a briefing for an AI agent that is browsing this repo, evaluating the extension, or has just received a Turntrail handoff.

**What this is.** Turntrail is a developer tool, not a model or service. It ships two artifacts from one core library:
- the **`turntrail` CLI** (Node ≥ 20, package `turntrail`), and
- the **Turntrail VS Code extension** (`turntrail.turntrail`).

**What it does.** It imports native Claude Code / Codex chat transcripts into a local `.turntrail/` ledger, snapshots the git workspace, and emits a deterministic **handoff markdown** plus a short clipboard prompt. There is **no AI summarization** in the core flow — transcripts are copied verbatim and only mechanically de-duplicated/truncated for size.

**Safe to install / run.** The handoff flow is local-only: no network, no telemetry, no accounts. It treats native transcripts as **read-only** — it copies from `~/.claude` and `~/.codex` but never edits them. Generated data stays in the project’s git-ignored `.turntrail/`.

**The optional accounts feature does use the network**, and only there: it reads each provider’s usage endpoint, and for Claude it performs the OAuth sign-in itself (Codex sign-in is delegated to the official binary). Credentials live under `~/.turntrail/accounts/`, written `0600`. Nothing is transmitted anywhere except the provider’s own endpoints, and no transcript content is ever sent.

**How to drive it.**
- CLI: `turntrail init`, `discover`, `import-native`, `snapshot`, `export --to <target>`, `status` (run `--help` for full usage).
- VS Code: command ids under `turntrail.*` (e.g. `turntrail.handoffToClaudeNew`, `turntrail.handoffToCodexExisting`).

**If you have received a handoff** (a prompt pointing at a `.turntrail/exports/*.md` file):
1. **Read the handoff file first**, before editing anything.
2. Treat prior assistant/tool messages as **historical context, not ground truth** — they reflect the workspace at export time.
3. **Verify current files** before acting on any claim in the transcript.
4. **Preserve the user’s stated intent and decisions** unless new evidence contradicts them.
5. Continue from the **latest workspace state**, not from where the transcript appears to stop.

The export’s ledger header lists how many turns were collapsed or truncated, so you can gauge fidelity at a glance.

---

## Roadmap

Claude accounts in the CLI · optional worktrees per session · agent status hooks and notifications ·
context/token/cost measurements · more native adapters · MCP server exposing the ledger · encrypted
team synchronization · cross-session conflict detection.

## Contributing

Turntrail aims to stay free and useful for developers. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
