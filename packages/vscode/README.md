# Turntrail — VS Code Extension

**Continue the same coding session across Claude Code, Codex, and other agents — without asking one AI to summarize another.**

Turntrail does two independent jobs:

- **Sessions and handoffs.** Search native and imported conversations in one view, preview one,
  snapshot your workspace, and write a clean, deterministic handoff you paste into the next agent.
  Everything stays local in `.turntrail/` — no telemetry, no network, no AI summarization.
- **Accounts.** Keep several Codex subscriptions and Claude accounts signed in at once, see what each has left on a usage bar, and switch the official tools between them.

Use either without the other. The handoff flow never touches the network. Account actions, and
background maintenance only when explicitly enabled, reach only the providers' own sign-in, token,
and usage endpoints; no transcript content is ever sent anywhere.

Works in VS Code and compatible forks (Cursor, Windsurf, Google Antigravity).

## See it in action

Find the exact conversation and continue it in another agent:

![Turntrail Sessions view with Claude, Codex, Gemini, and Cursor conversations and cross-agent handoff controls](media/marketplace/01-cross-agent-handoff.png)

See quota across Codex subscriptions, switch the active login, and use banked resets:

![Turntrail Accounts view showing three Codex subscriptions, quota windows, and a banked reset](media/marketplace/02-account-quotas.png)

Keep multiple Claude Code accounts signed in and ready to use:

![Turntrail Accounts view showing two Claude Code accounts and their usage windows](media/marketplace/03-claude-accounts.png)

Review the deterministic local handoff before the next agent reads it:

![A Turntrail handoff document open beside the unified Sessions view](media/marketplace/04-local-handoff.png)

## Use it

1. Open the Turntrail icon in the activity bar and expand **Sessions**.
2. Search or filter Claude, Codex, Gemini, and Cursor conversations. Workspace scope is the default;
   **Everywhere** deliberately includes other projects.
3. Choose **Import & view** to inspect a bounded normalized preview, or choose Claude/Codex and
   new/existing beside **Handoff**. Choose **Managed CLI** for direct delivery or **Clipboard** to
   paste it yourself.
4. Turntrail imports when needed, snapshots the workspace, writes a handoff, and copies its short
   prompt as a fallback. Managed delivery launches, resumes, or injects into the official CLI.

The command-palette and Handoff-card workflows remain available. To ingest a session without
generating a handoff, use **Import** in the Sessions view or **Discover … Sessions** → pick one →
**Import**.

The Sessions webview sees opaque row ids rather than native file paths. Preview content comes from
the normalized project ledger, is limited to 1,000 turns and 2 MiB by default, and says when it was
clipped. An unreadable individual transcript is skipped and reported without hiding other sessions.

## Managed CLI

The strip above the session list tracks Claude and Codex terminals opened by Turntrail. Use its add
button to start one, **Open CLI** on a session row to resume it, and the focus/close controls to
manage live terminals. `Turntrail: Open Managed CLI Session` provides the same launch from the
palette.

A managed handoff to **New** launches the provider with the handoff as its initial prompt. A handoff
to **Existing** uses a matching live managed terminal or launches the native resume command with the
recorded session id. Turntrail never substitutes another terminal when the ledger identifies a
specific destination chat.

The provider executable is the terminal's direct process: handoff text is an argument, not a shell
command, and there is no shell left behind if the agent exits. Before injecting into an already-live
TUI, Turntrail asks you to confirm it is waiting for a normal prompt because VS Code cannot inspect
provider permission/selection state. The prompt remains on the clipboard if direct delivery fails.

Editor terminal reconnection may preserve a live managed process across window reloads, and
Turntrail reattaches through a validated marker. This is not a daemon: a process that has exited, or
a machine/editor that fully stopped it, must be resumed again.

## Commands

**Handoff**

- `Turntrail: Discover Claude Sessions` / `Discover Codex Sessions`
- `Turntrail: Discover Gemini Sessions` / `Discover Cursor Sessions`
- `Turntrail: Import Latest Claude Session` / `Import Latest Codex Session`
- `Turntrail: Import Latest Gemini Session` / `Import Latest Cursor Session`
- `Turntrail: Handoff to New / Existing Claude Session`
- `Turntrail: Handoff to New / Existing Codex Session`
- `Turntrail: Open Latest Handoff`
- `Turntrail: Copy Latest Handoff Prompt`
- `Turntrail: Open Managed CLI Session`

**Accounts** — all of these are also reachable from the panel, which never sends you to a dropdown.

- `Turntrail: Add Account` / `Add Codex Subscription` / `Add Claude Account`
- `Turntrail: Import Current Login` / `Import Current Codex Login` / `Import Current Claude Login`
- `Turntrail: Switch Account` · `Undo Account Switch`
- `Turntrail: Refresh Account Quota` · `Show Raw Response`
- `Turntrail: Open Terminal for Account`
- `Turntrail: Rename Account` · `Remove Account`

## Settings (`turntrail.*`)

| Setting | Default | Effect |
|---------|---------|--------|
| `dedupeTurns` | `true` | Collapse consecutive duplicate turns in exports. |
| `toolMaxChars` | `2000` | Truncate long tool outputs (git diffs, listings); `0` disables. |
| `systemMaxChars` | `800` | Truncate long system turns; `0` disables. |
| `maxExportChars` | `120000` | Character budget for the transcript. User turns are reserved first, then the most recent turns fill the budget; `0` disables it. |
| `sinceLastExport` | `false` | Send only what the receiving agent has not seen — its own last turn, or the last handoff aimed at it, whichever is later. Leave off if you paste handoffs into fresh sessions. |
| `snapshotDiffMaxChars` | `4000` | How much of the uncommitted diff (vs HEAD) to embed; `0` shows the file-level stat only. |
| `keepExports` | `10` | Past handoff files kept in `.turntrail/exports`; older ones are deleted after each export. `0` keeps all. |
| `openHandoffDocument` | `true` | Open the handoff file after export. |
| `allowExternalClaudeUri` | `false` | Allow the known Claude extension URI using the current editor's scheme. Application-scoped. |
| `alwaysUseLatestSession` | `false` | When several sessions were started in this workspace, use the newest without asking instead of showing a picker. |
| `claudeUri` | `vscode://anthropic.claude-code/open` | URI used to open Claude when enabled; only the current editor scheme and known Claude authority/path are accepted. Application-scoped. |
| `claudeOpenCommand` | `""` | Installed Claude/Anthropic open command. Unavailable, unrelated, destructive, and workspace-supplied ids are rejected. |
| `codexOpenCommand` | `""` | Installed Codex/OpenAI open command with the same validation. |

Handoffs are kept small deterministically: duplicate turns are collapsed, oversized tool/system output is trimmed (head + tail kept), inline base64 screenshots are stripped, and a total character budget caps the transcript. User and assistant prose is preserved verbatim — there is no AI summarization.

The budget is on by default because an unbounded handoff is not actually lossless: receiving agents refuse or silently truncate oversized files, so an over-long export delivers a fraction of itself with no indication that anything is missing. A budgeted export reports exactly what it dropped in its header.

Every handoff opens with **Where This Left Off**: the last real request and the last assistant message quoted verbatim, plus files written and recent commands pulled from recorded tool-call arguments. It is extractive, never generated, and it is built from the whole session — so the last request survives even when the budget drops the turn that carried it. The workspace snapshot below it carries the uncommitted diff and a `git log -1` check, so the receiving agent can tell whether the tree moved on before it starts editing.

## Handoff from the panel

The bottom of the panel carries a **Handoff** card: choose the agent to hand off to, whether it is
going into a new session or the one already open, and press **Create handoff**. It runs exactly the
same flow as the command palette — the palette entries are unchanged and still work — and afterwards
the card shows the last handoff with **Open** and **Copy prompt** beside it.

## Accounts

An **Accounts** panel in the activity bar lists your Codex and Claude accounts in two labelled
sections. Each section has its own pooled bar, because the two quotas are not the same currency and
switching one has no effect on the other. Buttons are always visible, so nothing needs the command
palette.

Each limit window gets **its own labelled bar** — a Claude account shows one for the five-hour
window and one for the weekly, a Codex subscription shows whichever its API reports. Each bar is
coloured by its own state and carries its own reset, so a healthy weekly allowance is not painted
red because the short window beside it is spent. The percentage beside the account name stays the
tightest window, since that is the one that will actually stop you. Codex reports a second window
only sometimes: when an account is sitting on its weekly cap it sends `secondary_window: null` and
there is genuinely one limit to show. **Raw Response** shows what arrived.

When an account is out of quota the card says **when it comes back**, not just that it is blocked.
That time is the reset of the window actually holding you — which is not always the next reset. A
five-hour window can clear in an hour while an exhausted weekly allowance keeps you blocked for
days, and when several windows are exhausted you resume only once the last of them clears. Accounts
with more than one window list each one with its own reset beneath the bar.

Codex cards also show the number of **banked resets** available and the earliest expiry when OpenAI
provides detail rows. **Use reset** requires confirmation, consumes one reset, and then refreshes
the account. It is never automatic, and the redemption POST is never retried.


Every account gets its own configuration directory under `~/.turntrail/accounts/` —
`CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude — so they all stay signed in
simultaneously and there is nothing to swap.

### Signing in

Each method is a card that expands in place, so one that will not work can be abandoned without
losing the others, and each has its own Retry.

**Codex** methods drive the official `codex` binary as a background process. Turntrail reads
its output to render progress but never performs the OAuth exchange and never holds a token.

| Method | Local port | Notes |
|--------|-----------|-------|
| Sign in with ChatGPT | `localhost:1455` | The default. Cannot complete over SSH or in a container. |
| Device code | none | Approve a short code from any device. A workspace admin can disable it. |
| Access token | none | `--with-access-token`. Issued by workspace admins for trusted scripts and CI. |
| API key | none | Billed per token at API rates, not against a subscription. |
| Paste an existing login | none | Bring `auth.json` from a machine that is already signed in. |

**Claude** works differently, and the difference is forced rather than chosen. Claude Code's login is
an Ink terminal UI that requires raw mode on stdin, so a piped child process dies before printing
anything; `claude setup-token` is the same UI and, by design, writes no credential at all. The
official VS Code extension sidesteps this by *being* the CLI — it bundles the runtime — which is not
something another extension can borrow. So Turntrail runs the same public PKCE flow the CLI
runs, against the same client id, and writes the credential itself.

**This means Turntrail performs the token exchange for Claude and handles those tokens**, which
it never does for Codex. The endpoints involved are not a published contract and can change without
notice; the flow is written to fail loudly rather than silently when they do.

| Method | Local port | Notes |
|--------|-----------|-------|
| Sign in with Claude | `localhost:54545` | Opens the browser and returns to the panel by itself. |
| Authorization code | none | Approve on any device, paste the code back. Works over SSH and in containers. |
| Use the login on this machine | none | Adopt the account Claude Code is already signed in as. |
| Paste an existing login | none | Bring `.credentials.json` from another machine. |

For both agents, choosing a file rather than pasting keeps the credential out of the panel entirely —
the extension reads it directly. Credentials are written `0600`. **Your existing logins at
`~/.codex` and `~/.claude` are never touched by signing in or adding an account**; only
*switching* writes there, and it backs up what it replaces first.

macOS keeps Claude credentials in the Keychain rather than a file, so there is nothing to copy or
adopt there.

### Switching

**Click "Use this" to switch.** The official CLIs and extensions read one credential path each, so
switching rewrites it — which is exactly what makes the *official* UI start using the account you
picked. For Claude that means two files: the credential, plus the `oauthAccount` key inside
`~/.claude.json`, because that is where the email the client displays actually lives. Everything
else in that file — project history, caches — is left byte-identical, and both files are backed up
first.

The account in use is marked and appears in the status bar with its remaining quota. Every account
stays signed in, so switching back is one more click; the confirmation also offers **Undo** and
**Reload Window**.

For Codex OAuth accounts, switching first rotates the incoming refresh token with OpenAI. This
detects a login revoked server-side even when its local JWT expiry is still in the future. Failed
verification leaves the current live credential untouched instead of reporting a file copy as a
successful account switch.

If the provider is already stopped, **Use this** switches immediately. If an IDE background service
or interactive process is running, Turntrail offers **Stop Processes & Switch** or **Wait for Me to
Stop Them**. The first action terminates only matching provider processes after warning that active
runs can be interrupted. The second uses a detached helper to wait until all provider processes have
exited, perform the guarded switch, and reopen the initiating workspace. Unrelated editor windows do
not need to close, but a window that keeps restarting its provider extension service may need to be
closed or have that extension disabled. A queued request expires after 15 minutes and never contains
credentials.

| Action | Effect |
|--------|--------|
| **Use this** | Points that agent's official CLI and extension at this account. |
| **Repair login / Update Claude login / Update Codex login** | Verifies a rejected login, or updates the official client with credentials created by signing in again, using the same guarded switch flow. |
| **Terminal** | Starts the agent as that account without changing the machine default. |
| **Sign in** | Opens the sign-in panel for that agent. |
| **↻** (on each card) | Refreshes just that account — and for Codex, renews its token in the process, so it doubles as waking a stale login. |
| **Refresh now** (on the pool) | Reads every account for that agent. Otherwise readings are cached for five minutes. |
| **Raw Response** | Opens the endpoint's actual JSON next to how Turntrail parsed it. |
| **Use reset** | Confirms and consumes one available Codex banked reset, then refreshes quota. |
| **✎** (on hover) | Renames the account. The directory holding its credential never changes, so a rename cannot invalidate a login. |
| **Remove** | Forgets an account, or permanently deletes its managed login and active default login after the provider stops. |

Switching is manual. The panel shows what each account has left and lets you choose — it does not
fail over on its own when one runs out.

Access tokens expire, and each official client normally renews only the account it is *currently*
using. A quota read renews an inactive OAuth account only when its recorded access-token expiry says
renewal is due. Background maintenance does not refresh the **active** Codex account because the live
official client owns its rotating token. A deliberate switch or repair waits for Codex to stop and
may then verify that account safely. Turntrail otherwise synchronizes the live credential back into
the managed snapshot so a later switch does not reinstall an older refresh token.

Background maintenance is **off by default**. Turntrail offers one opt-in after the first managed
Codex or Claude account appears. You can also run **Turntrail: Toggle Background Account
Maintenance** or **Turntrail: Run Account Maintenance Now**. While an editor is open, Turntrail then
performs a jittered maintenance run about every five hours: refresh due inactive OAuth credentials,
read quota, and update the local cache. A machine-wide lock prevents simultaneous refreshes from
multiple VS Code-compatible editors or a CLI scheduler. API-key accounts are skipped, and no
model/inference request is used as a keep-alive.

A provider `401` triggers one refresh-and-retry when the account is inactive, or when it is selected
but no provider process is running. A selected account owned by a running provider process is
deferred rather than raced.

Maintenance reduces stale-login failures; it does not guarantee that a provider session will remain
authorized. Providers can revoke a login before its local expiry, a fully expired login still needs
a fresh sign-in, and editor maintenance cannot run while every editor is closed. Use
`turntrail account maintain --json` from an OS scheduler for unattended maintenance.

API-key Codex accounts can be activated and launched normally. They do not have subscription quota,
so the panel reports quota as unavailable instead of treating the account as signed out.

**What this cannot do.** A VS Code extension cannot add UI inside another extension's panel, so the
picker lives in the sidebar and status bar rather than inside Codex's or Claude's own menu. Tools
that put it there patch the desktop application itself, which pins them to an exact app build.

---

## What this accesses

Turntrail is a local tool. Here is exactly what it touches and why.

**Reads, never modifies:**

- Your agent transcripts under `~/.claude/projects/`, `~/.codex/sessions/`, `~/.gemini/tmp/`, and `~/.cursor/projects/` (plus `~/.codex/session_index.jsonl` for chat names). These are copied into the ledger; the originals are never edited. Turntrail does not open Cursor's live editor databases.
- Your current sign-in files (`~/.codex/auth.json`, `~/.claude/.credentials.json` and the matching config), so the accounts panel can show which account is active and how much quota remains.

**Writes, only in these two places:**

- The project’s git-ignored `.turntrail/` — the merged ledger, snapshots, and handoff documents.
- `~/.turntrail/accounts/` — copies of the credentials for accounts you add, written owner-only (`0600`) so you can switch between them. Nothing account-related is written inside your project.

**Network:** the handoff flow makes **no network calls at all**. The optional accounts panel and the
separately opt-in background maintenance setting contact only the providers' own endpoints —
Anthropic and OpenAI sign-in, token refresh, and usage/quota. Background maintenance is disabled by
default. Your credentials go to the service that issued them and nowhere else. There is **no
telemetry** and no other server involved.

Provider HTTP calls have a 20-second timeout and support cancellation. Provider response bodies are
not copied into error messages. The Claude loopback callback requires exact PKCE state and expires;
the login panel clears submitted secrets, discards hidden DOM state, bounds process output, and
removes provisional accounts after failed or cancelled attempts.

**Credentials stay on your machine.** They are read from and written to local files only. The extension bundles no analytics and phones no home.

## For AI agents

> Briefing for an AI agent evaluating or installing this extension.

Turntrail is a **local developer tool**, safe to install: no telemetry, read-only access to native transcripts (it copies from `~/.claude` / `~/.codex` and never edits them). Output lives in the project’s git-ignored `.turntrail/`.

The handoff flow makes no network calls at all. The optional accounts panel is the only part that does, and only to the providers’ own sign-in and usage endpoints; account credentials live under `~/.turntrail/accounts/`, written `0600`, never inside the project.

Drive it via command ids under `turntrail.*` (e.g. `turntrail.handoffToClaudeNew`). A handoff produces a markdown file in `.turntrail/exports/` plus a clipboard prompt pointing to it. A companion `turntrail` CLI offers the same flow in the terminal.

**If you received a handoff prompt** (it points at a `.turntrail/exports/*.md` file): read that file first; treat prior turns as historical context, not ground truth; verify current files before editing; preserve the user’s intent; and continue from the latest workspace state. The export’s header reports how many turns were collapsed/truncated so you can judge fidelity.

## Development

Open the repository in VS Code, press `F5`, and choose **Extension Development Host**. To package locally, run `npm run package:vscode` from the repo root and install the generated `dist/turntrail-<version>.vsix` via **Install from VSIX…**.

[Source & full docs](https://github.com/yagyaanshK/turntrail) · [MIT License](https://github.com/yagyaanshK/turntrail/blob/main/LICENSE)
