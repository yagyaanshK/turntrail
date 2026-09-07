# VS Code Extension

Turntrail includes a VS Code extension package for developers who use Claude, Codex, Gemini CLI, and Cursor Agent alongside their editor.

It does two separate jobs: it indexes sessions and generates **handoffs** between agents, and it
manages **accounts** for Claude and Codex in a sidebar panel. The two are independent — you can use
either without the other.

## Commands

Open the command palette and run:

**Handoff**

- `Turntrail: Handoff to Existing Claude Session`
- `Turntrail: Handoff to New Claude Session`
- `Turntrail: Handoff to Existing Codex Session`
- `Turntrail: Handoff to New Codex Session`
- `Turntrail: Discover Claude Sessions`
- `Turntrail: Discover Codex Sessions`
- `Turntrail: Discover Gemini Sessions`
- `Turntrail: Discover Cursor Sessions`
- `Turntrail: Import Latest Claude Session`
- `Turntrail: Import Latest Codex Session`
- `Turntrail: Import Latest Gemini Session`
- `Turntrail: Import Latest Cursor Session`
- `Turntrail: Open Latest Handoff`
- `Turntrail: Copy Latest Handoff Prompt`
- `Turntrail: Open Managed CLI Session`

**Accounts**

- `Turntrail: Add Account` / `Add Codex Subscription` / `Add Claude Account`
- `Turntrail: Import Current Login` / `Import Current Codex Login` / `Import Current Claude Login`
- `Turntrail: Switch Account`
- `Turntrail: Undo Account Switch`
- `Turntrail: Refresh Account Quota`
- `Turntrail: Open Terminal for Account`
- `Turntrail: Rename Account`
- `Turntrail: Remove Account`
- `Turntrail: Show Raw Response`
- `Turntrail: Toggle Background Account Maintenance`

Everything in the accounts group is also reachable from the panel, which never hands you off to a
dropdown: confirmations and renames happen inline in the card you clicked.

## The Sessions Panel

The **Sessions** view is the primary way to choose conversation history. It combines native Claude,
Codex, Gemini, and Cursor transcripts with sessions already imported into the current Turntrail
ledger, sorts them by recent activity, and marks imported rows. Duplicate native and ledger records
are merged when their native session id or source path identifies the same conversation.

The scope defaults to **Workspace**, so sessions from unrelated projects stay out of the list.
Choose **Everywhere** to search all locally discovered conversations. A provider filter and text
search narrow the result without rescanning the native stores.

| Action | Effect |
|--------|--------|
| **Import** / **Reimport** | Copies the selected native transcript into the project ledger. Native files are never modified. |
| **Import & view** / **View** | Imports if needed, then opens a readable normalized Markdown preview. |
| **Handoff** | Imports if needed and creates a Claude or Codex handoff in new- or existing-session mode. |
| **Open CLI** | Resumes that Claude or Codex conversation in a Turntrail-managed terminal. |
| **Refresh** | Rescans native stores and rereads the project ledger. |

Previews are bounded to 1,000 turns and 2 MiB by default so opening a very large conversation cannot
stall the extension host. The preview says when it was clipped. It renders normalized text from the
local ledger rather than dumping raw JSONL or inline base64 image data.

The webview receives opaque row ids and display metadata only. Native transcript paths and import
descriptors remain in the trusted extension host and are resolved only after a button click. An
unreadable or oversized individual transcript is skipped and reported without hiding healthy
sessions from the same provider.

Gemini and Cursor are currently source providers. Their sessions can be imported, viewed, and handed
off to Claude or Codex, but Turntrail does not yet open or inject prompts into Gemini or Cursor.

### Managed CLI Sessions

The **Managed CLI** strip above the session list shows Claude and Codex terminals opened by
Turntrail. Use its add button for a new session, **Open CLI** on a session row to resume that native
conversation, and the play/close controls to focus or stop a managed terminal.

Before opening a new managed session, when managed accounts exist, Turntrail refreshes that
provider's account usage and selects the signed-in account with the strongest fresh remaining quota.
An account with unknown quota is a fallback; stale readings never outrank fresh readings, and
exhausted or rejected logins are excluded.
The selected account is shown in the terminal title and remains pinned through its isolated
`CODEX_HOME` or `CLAUDE_CONFIG_DIR`. Resumed native sessions keep their original environment because
changing homes can make their existing transcript unavailable.
The Sessions view scans those managed account homes as well as the default native stores, so their
transcripts remain discoverable after the terminal closes.

Inside **Handoff**, **Send to → Managed CLI** provides direct delivery:

- **New** launches the official CLI with the handoff prompt as its initial prompt.
- **Existing** injects into the matching live managed terminal. If it is not running, Turntrail
  launches the provider's documented resume command with the native session id and prompt.
- When several live terminals could match an unnamed destination, Turntrail asks which one.
- When the ledger identifies a destination session, a different live terminal is never substituted.

Turntrail launches the provider executable as the terminal's direct process. It does not build a
shell command from the prompt, so spaces, newlines, backticks, and shell metacharacters remain data.
If the agent exits, the terminal has no interactive shell behind it and injection is refused. The
prompt is also copied to the clipboard before delivery as a recovery path.

VS Code does not expose whether an interactive TUI is waiting for normal input, running a tool, or
showing a permission dialog. Turntrail therefore asks for confirmation before injecting into an
already-running terminal. Fresh and resumed launches do not need that confirmation because the
prompt is passed as a process argument. Native terminal persistence and reconnection are provided by
the editor; Turntrail reattaches only to live terminals carrying its validated marker. It is not a
background daemon and cannot preserve a process after the editor, provider process, or machine has
fully stopped.

Claude's resume/initial-prompt syntax follows the
[official Claude CLI reference](https://code.claude.com/docs/en/cli-usage). Codex capability is
validated against the installed CLI's `codex --help` and `codex resume --help`; unsupported or
missing executables fail without falling back to shell interpolation.

## The Accounts Panel

The panel lists Codex subscriptions and Claude accounts in two labelled sections, each with its own
cards, usage bars and pooled total. Nothing is pooled across the two — the quotas are not the same
currency, and switching one has no effect on the other.

Each card shows the plan, masked email, and **one labelled bar per limit window** — a five-hour and
a weekly bar for Claude, whichever Codex reports for a subscription — each with its own colour and
its own reset. The percentage beside the name is the tightest window, the one that will stop you
first. Hovering reveals a pencil to rename; renaming changes the label only, never the directory
holding the credential, so it cannot invalidate a login.

Codex cards show **banked resets** when OpenAI reports any, including the earliest known expiry.
**Use reset** opens a modal confirmation, asks the backend to consume one reset, and refreshes that
account. The backend can decline with `nothing_to_reset`; Turntrail never uses a reset automatically
or retries the redemption POST.

| Action | Effect |
|--------|--------|
| **Use this** | Points that agent's official CLI and extension at this account (machine-wide). |
| **Repair login / Update Claude login / Update Codex login** | Validates a rejected login, or updates the official client after a newly completed sign-in to the selected account. |
| **Terminal** | Starts the agent as that account without changing the machine default. |
| **Sign in** | Opens the sign-in panel for that agent. |
| **Refresh now** | Forces a usage read; otherwise readings are cached for five minutes. |
| **Raw Response** | Shows the endpoint's actual JSON next to how Turntrail parsed it. |
| **Use reset** | Confirms and consumes one available Codex banked reset, then refreshes quota. |
| **Remove** | Forget the account, or delete its managed credentials and active default login. Confirmed inline. |

Background account maintenance is disabled by default. Turntrail offers a one-time opt-in after a
managed Codex or Claude account is detected. The toggle and **Run Account Maintenance Now** commands
remain available. Maintenance runs about every five hours while the editor is open. It fetches
quota, renews inactive OAuth accounts,
and synchronizes provider-owned credentials back into Turntrail's snapshot. When no Claude process
is running, it also proactively renews the active Claude credential and updates the official live
store first; missing or blank live credentials are repaired only when their account is
unambiguous. If Claude is running when renewal becomes due, Turntrail makes no provider request and
retries after 15 minutes. A machine-wide lock prevents duplicate refreshes across VS Code forks and CLI
schedulers. The interval can be changed with `turntrail.accountMaintenance.intervalHours` (1-24).
When a provider rejects a locally unexpired access token, maintenance attempts one refresh and
retries the usage request. It repairs a selected machine-default credential only when that provider
has no running process; otherwise the repair is deferred.
This reduces stale-login failures but cannot guarantee persistence: providers may revoke sessions
before their local expiry, and extension maintenance cannot run while every editor is closed.
Turntrail never spends quota on a synthetic inference request merely to keep a login warm. API-key
accounts do not use OAuth refresh tokens and are skipped.

### Signing in

**Codex** delegates to the official binary: Turntrail spawns `codex login` with `CODEX_HOME`
set and reads its output to render progress. It never performs the OAuth exchange. Methods: browser,
device code, access token, API key, paste an existing `auth.json`.

**Claude** cannot work that way. Its login is an Ink terminal UI needing raw mode on stdin, so a
piped child process dies before printing anything, and `claude setup-token` writes no credential by
design. The official extension avoids this by bundling the CLI runtime, which another extension
cannot borrow. So Turntrail runs the same public PKCE flow the CLI runs and writes the
credential itself — meaning **it handles Claude tokens, which it never does for Codex**. Methods:
browser (loopback on port 54545), authorization code (no local port, for SSH and containers), adopt
the login at `~/.claude`, or paste a `.credentials.json`.

Provider requests time out after 20 seconds and cancellable notifications abort their in-flight
request. The Claude browser callback accepts only its exact loopback path and PKCE state and expires
after five minutes. Secret fields are cleared when submitted, hidden login panels retain no DOM, and
a failed or cancelled attempt removes an account row created solely for that attempt.

Deleting credentials is destructive. If the account is currently in use, Turntrail also
removes the live default provider login after confirming the provider is stopped; unrelated Claude
configuration such as project history is preserved. A malformed Claude config is never replaced
during switching or deletion: the operation stops and leaves both live files unchanged.

On macOS Claude keeps credentials in the Keychain rather than a file, so the adopt and paste methods
have nothing to read there; the two OAuth methods work everywhere.

### Switching

Switching rewrites the one credential path the official tooling reads, which is what makes the
official UI start using your choice. For Claude that is two files — the credential plus the
`oauthAccount` key in `~/.claude.json`, where the displayed email lives. The rest of that file is
project history and caches and is left byte-identical. Both files are backed up first, and the
confirmation toast offers **Undo**.

Turntrail checks for native `codex` and `claude` processes immediately before replacing a login. On
Windows it also detects the Codex desktop app's `ChatGPT.exe` host by its package-qualified
`OpenAI.Codex` executable path; it does not match an unrelated ChatGPT installation by name alone.
If the provider is stopped, **Use this** switches immediately. If an interactive session, Codex
desktop client, or IDE background service is running, choose **Stop Processes & Switch** to terminate matching provider
processes after an explicit interruption warning, or **Wait for Me to Stop Them** to queue the
switch. The detached helper waits for every process to exit, requires three consecutive quiet polls,
runs the same guarded switch, and reopens the initiating workspace. Unrelated editor windows can
stay open. Close a relevant editor window only when its provider extension service keeps restarting;
the default credential is machine-wide across editors, CLIs, and desktop clients.

Ignoring an idle-looking `codex.exe app-server` is unsafe: Codex can retain the old account in memory
and refresh its persisted token later. Queuing keeps the strict process check while making it usable
from the extension. Requests expire after 15 minutes and contain no tokens. A timeout, a restarted
provider, or a failed account validation leaves the live credential unchanged.

Codex activation validates an OAuth account by rotating its refresh token before installing it,
even if the access-token JWT has not reached its local expiry. This catches credentials revoked by
OpenAI or renewed elsewhere. A usage-endpoint `401` is shown as a repairable verification state;
Turntrail offers both **Repair login** and a fresh **Sign in**. If a fresh sign-in belongs to the
account already selected in `~/.codex/auth.json`, **Update Codex login** performs the guarded replacement.

## The Handoff Card

The panel's bottom section runs the same handoff flow as the commands: choose the target agent,
choose a new or existing session, press **Create handoff**. Afterwards it shows the last handoff
with **Open** and **Copy prompt**. This remembered handoff is stored per workspace and is shown only
when its recorded project root matches the current workspace. The command palette entries are unchanged.

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

## How Handoff Works

Turntrail generates the same deterministic handoff whether you paste it into an existing session or a new one.

When handing off to Claude, the extension imports the latest Codex native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

When handing off to Codex, the extension imports the latest Claude native transcript for the workspace, captures a workspace snapshot, generates a handoff markdown file, and copies a concise prompt to the clipboard.

Discovery, import, and handoff progress notifications have a **Cancel** action. Cancellation propagates through provider-directory walking, JSONL parsing, snapshot commands, and ledger export rather than leaving background work in the extension host.

The receiving prompt points at the handoff file instead of pasting a giant transcript into the chat box:

```text
Continue in this existing session using this Turntrail handoff:

<path-to-.turntrail/exports/...md>

Read the handoff before acting...
```

Screenshot payloads embedded in native transcripts are not pasted into the handoff. Turntrail keeps local image paths when available and replaces inline base64 image blobs with compact omission markers.

Gemini and Cursor are import sources in this release. Use their Discover or Import Latest commands,
then create a handoff to Claude or Codex. The extension does not yet open or inject prompts into
Gemini or Cursor panels; the generated file and copied prompt remain the integration boundary.

## Existing vs New Session

Use an existing session for short round trips where the original conversation is still coherent.

Use a new session when the old native chat is long, stale, noisy, or confused. The Turntrail ledger remains the source of truth either way.

## Claude

For new Claude sessions, Turntrail first tries to find and execute an installed Claude/Anthropic command in the current editor.

You can set `turntrail.claudeOpenCommand` at application/user scope to an installed Claude or
Anthropic open/focus command. Turntrail rejects unavailable, unrelated, or destructive command ids.

Turntrail no longer opens the Claude Code URI by default because VS Code forks may hand `vscode://...` links to Microsoft VS Code instead of the current editor. If you want that external behavior, enable `turntrail.allowExternalClaudeUri`.

The optional URI setting is:

```text
<current-editor-scheme>://anthropic.claude-code/open
```

You can override it with the application-scoped `turntrail.claudeUri`. Only the current editor's
URI scheme, the `anthropic.claude-code` authority, and `/open` path are accepted; workspace settings
cannot supply executable commands or URIs.

## Codex

Codex does not currently have a documented URI equivalent in this project. Turntrail tries to find an installed VS Code command containing `codex` or `openai`; if that fails, it leaves the prompt on the clipboard and opens the handoff document.

You can set `turntrail.codexOpenCommand` at application/user scope to an installed Codex/OpenAI
open/focus command. Workspace-controlled and destructive command ids are rejected.

## Development

```bash
npm install
npm test
npm run lint
```

Then open the repository in VS Code and press `F5` to launch an Extension Development Host. The repository includes `.vscode/launch.json`, so VS Code should open the Extension Development Host directly instead of asking you to select a debugger.

## Local VSIX Install

For normal use, package a VSIX:

```bash
npm run package:vscode
```

Run the real extension-host suite with:

```bash
npm run test:vscode-integration
```

The suite uses the minimum supported VS Code API version and isolated home, profile, extension, and
workspace directories. It verifies command registration and execution, webview resolution and CSP,
VS Code cancellation propagation, state isolation between workspace windows, Restricted Mode, and
the editor URI schemes used by VS Code-compatible forks. Linux CI runs it under Xvfb.

Turntrail deliberately declares no support for untrusted workspaces. It reads local agent
transcripts and Git workspace state and can launch provider tools, so VS Code keeps it inactive in
Restricted Mode until the folder is trusted.

This writes:

```text
dist/turntrail-<version>.vsix
```

Install it from the Extensions view:

1. Open Extensions.
2. Click the `...` menu.
3. Choose `Install from VSIX...`.
4. Select `dist/turntrail-<version>.vsix`.

This is the best path before marketplace publication because it works like a normal extension install.

## VS Code Forks

Turntrail uses the standard VSIX extension format and the public VS Code extension API. The local VSIX should install in VS Code-compatible editors that support VSIX extensions, including Cursor, Windsurf, and Google Antigravity.

If a fork does not expose the same Claude/Codex extension commands, Turntrail still generates the handoff file and copies the prompt. The user can paste the prompt into the target agent manually.
