# CLI Reference

The binary name is `turntrail`. The legacy `context-bridge` executable remains an alias for compatibility.

## `init`

Create a `.turntrail/` ledger in the current project.

```bash
turntrail init
```

## `import`

Import a transcript file into the local ledger.

```bash
turntrail import --provider claude --surface cli ./transcript.jsonl
turntrail import --provider codex --surface ide ./codex-export.json
turntrail import --provider other ./notes.md
```

Supported inputs:

- `.jsonl`: one JSON object per line
- `.json`: arrays, common `{ messages: [...] }` shapes, or a single object
- `.md` / `.txt`: preserved as a single imported transcript turn

## `snapshot`

Capture workspace state.

```bash
turntrail snapshot
```

The snapshot includes Git branch, status, latest commit, and top-level files when available.

## `discover`

Find native Claude Code, Codex, Gemini CLI, or Cursor Agent sessions matching the current project.

```bash
turntrail discover --provider claude
turntrail discover --provider codex
turntrail discover --provider gemini
turntrail discover --provider cursor
```

Use `--all` to show sessions even when the native transcript does not match the current project path:

```bash
turntrail discover --provider codex --all
```

Codex archived sessions can be included with:

```bash
turntrail discover --provider codex --includeArchived
```

## `import-native`

Import a native Claude Code, Codex, Gemini CLI, or Cursor Agent session into `.turntrail/sessions/`.

```bash
turntrail import-native --provider claude --last
turntrail import-native --provider codex --last
turntrail import-native --provider gemini --last
turntrail import-native --provider cursor --last
turntrail import-native --provider claude --session <session-id>
```

By default, native import searches for sessions whose recorded working directory matches the current project. Use `--all` if you intentionally want to import across projects.

Native files are read-only inputs. Turntrail does not modify `~/.claude`, `~/.codex`, `~/.gemini`,
or `~/.cursor`. Gemini's legacy JSON and current JSONL recordings are both supported. Claude Code's
and Cursor's main transcripts are imported by default; the nested subagent recordings both keep
beside a session are left out of `discover` and `import-native --last` unless
`--include-subagents` is given, which lists each under the name its parent gave it and with a
session id of its own.

An import re-reads the whole native file, which for a long thread takes a minute. The manifest
records the file's size and modification time at import, so `import-native` on a file that has
not changed since, with the same options, reports the existing ledger session instead of reading
it again. `--force` imports regardless.

When a Claude Code session launched background agents, importing it splices each agent's final
report in right after the turn that launched it, so the handoff carries what the agents found.
`import-native --subagent-transcripts` splices the agents' whole recordings instead.

## `run`

Launch Claude, Codex, Gemini CLI, or Cursor Agent, then import the native transcript file changed during that run.

```bash
turntrail run claude
turntrail run codex
turntrail run gemini
turntrail run cursor
turntrail run claude -- -c
turntrail run codex -- --approval-mode auto-edit
```

The current implementation uses the native transcript as the source of truth after the process exits. It does not yet capture full terminal redraw output through a pseudo-terminal. `run cursor` invokes the official `cursor-agent` executable.

Native arguments are passed directly to the executable without a command shell. On Windows, npm
command shims are launched through their sibling PowerShell shim with an argument array, preserving
literal spaces and shell metacharacters. `SIGINT` and `SIGTERM` are forwarded to the child, and a
signal-terminated child produces the conventional nonzero exit status.

## `export`

Generate a deterministic handoff file.

```bash
turntrail export --to codex
turntrail export --to claude --max-chars 60000
```

The generated file appears in `.turntrail/exports/`.

## `status`

Show ledger status.

```bash
turntrail status
```

## Accounts

> **Codex only.** The CLI's account commands read Codex paths and the Codex usage endpoint.
> `--provider claude` will list Claude accounts but report their sign-in state and quota from the
> wrong place, so treat it as unsupported. Manage Claude accounts from the VS Code panel until the
> CLI catches up.

Keep several Codex subscriptions signed in at once and see what each has left. The mechanism is one
environment variable: the Codex CLI keeps its identity in `auth.json` under whatever `CODEX_HOME`
points at, so each account gets its own directory under `~/.turntrail/accounts/<id>/codex-home`.

```bash
turntrail accounts                  # list, using cached quota
turntrail accounts --refresh        # re-read quota from the usage endpoint
turntrail account add "Primary" --import
turntrail account add "Subscription 2"
turntrail account use <id>
turntrail account remove <id> [--purge]
turntrail account maintain [--json]
```

`account add --import` adopts the login already at `~/.codex` — it **copies**, so the original stays
signed in. Without `--import` it prints the `codex login` command to run with the right
`CODEX_HOME` already set.

`account use` makes an account the machine default by writing the credential the official Codex CLI
and VS Code extension read. For OAuth accounts it first rotates the saved refresh token with OpenAI,
so a server-revoked but locally unexpired credential fails before the live login is touched. It
backs up what it replaces first. To use an account *without* changing the default, set the variable
yourself for that one session:

```bash
CODEX_HOME="$HOME/.turntrail/accounts/<id>/codex-home" codex
```

Close every running Codex CLI and close or reload editor windows hosting the Codex extension before
running `account use`. Turntrail checks the process list and refuses to replace the credential
while a Codex process is active, because that process could later write its previous account back
over the new default.

`account remove` forgets the account but leaves its credential on disk so it can be added back.
`--purge` deletes the managed directory and, when that account is currently active, the default
Codex login too. Stop Codex before purging an active account. Deletion cannot be undone.

Codex API-key `auth.json` files are valid accounts and can be activated or launched normally.
Subscription quota is unavailable for API-key authentication, so those accounts show that explicit
state instead of appearing signed out.

Quota is cached for five minutes per account. A failed refresh keeps the last good reading rather
than blanking the display.

`account maintain` is the exception to the Codex-only note above: it processes every managed Codex
and Claude account. It skips API-key and unsigned accounts, refreshes an inactive OAuth credential
only when due, synchronizes provider-owned active credentials without refreshing them, and updates
quota caches. A machine-wide lock makes it safe to invoke from several editor windows or an OS
scheduler; a contended invocation exits successfully and reports that another run is active.
If a quota request rejects a locally unexpired token, maintenance attempts one refresh and retries.
It repairs the selected machine-default credential only when that provider has no running process.

Use the machine-readable form as the target of Task Scheduler, cron, launchd, or systemd when you
want maintenance to continue while no editor is open:

```bash
turntrail account maintain --json
```

Schedule it about every five hours. Running it more frequently does not force token rotation, but it
does force provider quota requests and provides no benefit.
No schedule can guarantee login persistence: providers can revoke OAuth sessions independently.
Turntrail does not send model prompts as keep-alive traffic, and API-key accounts have no OAuth
refresh token to rotate.
