# Marketplace Screenshot Plan

## Purpose

Show the real Turntrail extension doing its most important jobs. Captures use an isolated
editor profile and deterministic synthetic data; no personal account, transcript, filesystem path,
or token may appear.

## Capture Standard

- Capture the real packaged extension at 1600 by 900 in VS Code's default dark theme.
- Use the synthetic `Launchpad` workspace produced by `node scripts/create-marketing-fixture.mjs`.
- Hide the menu bar, minimap, status noise, notifications, and unrelated panels.
- Keep the Turntrail sidebar wide enough that labels and controls are fully readable.
- Export PNG at native resolution. Do not add claims or controls that are absent from the product.
- Record the extension version and source commit in `media/marketplace/manifest.json`.

## Sequence

### 01 - Continue across agents

**Visible state:** Sessions view with Claude, Codex, Gemini, and Cursor rows. Open the handoff controls
on `Refactor the analytics dashboard`, targeting Claude, a new session, and Managed CLI.

**Caption:** Find the exact conversation and continue it in another agent.

**Proof:** Cross-provider discovery, explicit session selection, new/existing choice, and direct or
clipboard delivery.

### 02 - Manage Codex subscriptions

**Visible state:** Accounts view showing three Codex subscriptions. Keep `Studio` selected and its
banked reset visible.

**Caption:** See quota, switch Codex subscriptions, and use banked resets from one panel.

**Proof:** Multiple account storage, active-account state, per-window quota, and Codex reset controls.

### 03 - Keep Claude accounts ready

**Visible state:** Accounts view scrolled to the Claude Code section, showing two signed-in accounts,
separate quota windows, the active account, and the handoff card.

**Caption:** Keep multiple Claude Code accounts signed in and ready to use.

**Proof:** Claude OAuth storage, quota visibility, explicit account switching, and direct handoff.

### 04 - Inspect the handoff

**Visible state:** Generated Turntrail handoff open in the editor with the Sessions panel alongside.
Frame the handoff header, ledger metadata, workspace snapshot, and first transcript turn.

**Caption:** Review a deterministic, local handoff before the next agent reads it.

**Proof:** Auditable output, local storage, workspace state, and transcript continuity without an AI
summary.

## Files

```text
packages/vscode/media/marketplace/
  01-cross-agent-handoff.png
  02-account-quotas.png
  03-claude-accounts.png
  04-local-handoff.png
  manifest.json
```

## Reproduce

1. Build and install the current VSIX in a disposable editor profile.
2. Run `npm run marketing:fixture` to recreate the isolated workspace, accounts, quotas, snapshot,
   and handoff.
3. Launch that workspace in the disposable profile with Chromium remote debugging enabled on port
   `9333` and with `HOME` and `USERPROFILE` set to `.marketing-capture/home`.
4. Run `npm run marketing:capture`.
5. Inspect every PNG before publishing. The capture script records hashes, dimensions, extension
   version, and source commit in `media/marketplace/manifest.json`.

The Marketplace README uses repository-relative image references. VSCE maps these to the public
GitHub repository when packaging the extension.
