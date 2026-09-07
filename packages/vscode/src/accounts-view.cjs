const crypto = require('node:crypto');
const vscode = require('vscode');
const { classifyAccountHealth, recommendAccount } = require('./account-health.cjs');

// Subscriptions, for both agents.
//
// Split into a store (what we know) and a webview (how it looks). The panel is
// a webview rather than a tree because the useful presentation here is a
// meter: a percentage is much easier to judge against a filled bar than as a
// number, and a TreeItem cannot render one.
//
// Codex and Claude are kept in separate sections rather than one merged list.
// Their quotas are not the same currency and switching one has no effect on the
// other, so a single pooled number across both would be meaningless.

const PROVIDERS = [
  { id: 'codex', title: 'Codex', noun: 'subscription' },
  { id: 'claude', title: 'Claude Code', noun: 'account' }
];

function loginNeedsUpdate(account, activeId, hasAuthenticationIssue = false) {
  const signedInAt = Date.parse(account.signedInAt || '');
  const lastUsedAt = Date.parse(account.lastUsedAt || '');
  return !hasAuthenticationIssue && account.id === activeId &&
    Number.isFinite(signedInAt) && Number.isFinite(lastUsedAt) && signedInAt > lastUsedAt;
}

class AccountsStore {
  constructor(core) {
    this.core = core;
    this.usage = new Map();
    this.activeIds = {};
    this.handoff = undefined;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  async accounts(provider) {
    const { listAccounts } = await this.core();
    return listAccounts(provider ? { provider } : {});
  }

  async reloadActive(provider, known) {
    const { activeCodexAccountId, activeClaudeAccountId } = await this.core();
    const accounts = known || (await this.accounts(provider));
    const resolve = provider === 'claude' ? activeClaudeAccountId : activeCodexAccountId;
    this.activeIds[provider] = await resolve(accounts).catch(() => undefined);
    return this.activeIds[provider];
  }

  async reloadUsage(options = {}) {
    const { getCodexUsage, getClaudeUsage } = await this.core();
    const all = [];

    // A refresh can be scoped to one provider, so refreshing Codex's pool does
    // not also poll every Claude account.
    const providers = options.providerId ? PROVIDERS.filter((p) => p.id === options.providerId) : PROVIDERS;
    for (const provider of providers) {
      const accounts = await this.accounts(provider.id);
      const read = provider.id === 'claude' ? getClaudeUsage : getCodexUsage;
      await Promise.all(
        accounts.map(async (account) => {
          try {
            this.usage.set(account.id, await read(account.id, options));
          } catch (error) {
            this.usage.set(account.id, { error: error.message, windows: [] });
          }
        })
      );
      await this.reloadActive(provider.id, accounts);
      all.push(...accounts);
    }

    this.emitter.fire(await this.viewModel());
    return all;
  }

  // Refresh one account's quota without touching the others. This is the read
  // behind a card's own refresh button - and because a Codex read renews the
  // token, it doubles as "wake this one account up" for a login gone stale.
  async reloadUsageOne(accountId, providerId, options = {}) {
    const { getCodexUsage, getClaudeUsage } = await this.core();
    const read = providerId === 'claude' ? getClaudeUsage : getCodexUsage;
    try {
      this.usage.set(accountId, await read(accountId, options));
    } catch (error) {
      this.usage.set(accountId, { error: error.message, windows: [] });
    }
    await this.reloadActive(providerId);
    this.emitter.fire(await this.viewModel());
    return this.usage.get(accountId);
  }

  async refresh() {
    this.emitter.fire(await this.viewModel());
  }

  // The last handoff, so the panel can offer to reopen or re-copy it. Owned by
  // the extension (it lives in globalState), pushed in here for rendering.
  setHandoff(latest) {
    this.handoff = latest;
    this.refresh().catch(() => {});
  }

  // Everything the panel and the status bar draw, resolved in one place so the
  // two can never disagree about which subscription is in use.
  async viewModel() {
    const { isSignedIn, isClaudeSignedIn, resumesAt } = await this.core();

    const sections = [];
    for (const provider of PROVIDERS) {
      const accounts = await this.accounts(provider.id);
      if (this.activeIds[provider.id] === undefined && accounts.length > 0) {
        await this.reloadActive(provider.id, accounts);
      }

      // Read sign-in state from disk rather than inferring it from a quota
      // result: an account that has never been polled has no usage record at
      // all, and treating that as signed in offered "Use this" on an account
      // that could not possibly be switched to.
      const check = provider.id === 'claude' ? isClaudeSignedIn : isSignedIn;
      const signedIn = new Map(
        await Promise.all(accounts.map(async (item) => [item.id, await check(item.id).catch(() => false)]))
      );

      const rows = accounts.map((account) => this.row(account, provider, signedIn, resumesAt));
      const recommended = recommendAccount(rows);
      const presentedRows = rows.map((row) => ({ ...row, recommended: row.id === recommended?.id }));
      sections.push({ ...provider, rows: presentedRows, pooled: pool(rows) });
    }

    return { sections, handoff: this.handoff };
  }

  row(account, provider, signedIn, resumesAt) {
    const usage = this.usage.get(account.id);
    const requiresSignIn = usage?.requiresSignIn === true;
    const requiresRevalidation = usage?.requiresRevalidation === true;
    const hasAuthenticationIssue = requiresSignIn || requiresRevalidation;
    const windows = hasAuthenticationIssue ? [] : (usage?.windows || []);
    const needsActivation = loginNeedsUpdate(account, this.activeIds[provider.id], hasAuthenticationIssue);
    const row = {
      id: account.id,
      provider: provider.id,
      label: account.label,
      plan: account.plan ? planLabel(account.plan) : undefined,
      email: usage?.email || account.email,
      active: account.id === this.activeIds[provider.id],
      needsActivation,
      signedIn: signedIn.get(account.id) === true && !hasAuthenticationIssue,
      requiresSignIn,
      requiresRevalidation,
      error: usage?.error === 'not-signed-in' ? undefined : usage?.error,
      limitReached: !hasAuthenticationIssue && Boolean(usage?.limitReached),
      credits: hasAuthenticationIssue ? undefined : usage?.credits,
      resetCredits: provider.id === 'codex' && !hasAuthenticationIssue ? usage?.resetCredits : undefined,
      remaining: hasAuthenticationIssue ? undefined : remainingOf(usage),
      resetsAt: nextReset(windows),
      // When a blocked account starts working again, which is not the same as
      // its next reset - see resumesAt() in core.
      resumesAt: resumesAt ? resumesAt(usage) : undefined,
      fetchedAt: usage?.fetchedAt,
      staleReason: usage?.staleReason,
      loaded: Boolean(usage),
      windows: windows.map((window) => ({
        label: window.label,
        remaining: window.remainingPercent,
        resetsAt: window.resetsAt
      })),
      additionalLimits: (hasAuthenticationIssue ? [] : (usage?.additionalLimits || [])).map((limit) => ({
        id: limit.id,
        label: limit.label,
        limitReached: Boolean(limit.limitReached),
        windows: (limit.windows || []).map((window) => ({
          label: window.label,
          remaining: window.remainingPercent,
          resetsAt: window.resetsAt
        }))
      }))
    };
    return { ...row, health: classifyAccountHealth(row) };
  }

  async recommendation(providerId, options = {}) {
    if (!PROVIDERS.some((provider) => provider.id === providerId)) return undefined;
    if (options.refresh) {
      await this.reloadUsage({ force: true, providerId, signal: options.signal });
    }
    const model = await this.viewModel();
    return model.sections.find((section) => section.id === providerId)?.rows.find((row) => row.recommended);
  }

  // The status bar shows one agent at a time. Codex wins when both are set,
  // because that is the one whose switch is machine-global and easy to forget.
  async summary() {
    const { resumesAt } = await this.core();
    for (const provider of PROVIDERS) {
      const accounts = await this.accounts(provider.id);
      const active = accounts.find((account) => account.id === this.activeIds[provider.id]);
      if (!active) continue;
      const usage = this.usage.get(active.id);
      return {
        provider: provider.id,
        title: provider.title,
        label: active.label,
        remaining: remainingOf(usage),
        limitReached: Boolean(usage?.limitReached),
        resumesAt: resumesAt(usage)
      };
    }
    return { label: undefined };
  }
}

function pool(rows) {
  const values = rows.map((row) => row.remaining).filter((value) => typeof value === 'number');
  const stamps = rows.map((row) => Date.parse(row.fetchedAt || '')).filter((value) => Number.isFinite(value));
  return {
    count: rows.length,
    // Age of the oldest reading on screen, so the panel can say how current it
    // is rather than leaving the user to wonder.
    updatedAt: stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : undefined,
    total: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined,
    // The pooled bar is an average so it stays on a 0-100 scale even as
    // accounts are added; the headline number stays the sum, which is what
    // "how much do I have across everything" actually means.
    average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
  };
}

class AccountsWebview {
  constructor(store) {
    this.store = store;
    this.view = undefined;
    store.onDidChange((model) => this.post(model));
  }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);

    view.webview.onDidReceiveMessage((message) => {
      const commands = {
        switch: 'turntrail.switchAccount',
        signin: 'turntrail.signInAccount',
        terminal: 'turntrail.openAccountTerminal',
        raw: 'turntrail.showRawUsage',
        forget: 'turntrail.forgetAccount',
        purge: 'turntrail.forgetAccount',
        rename: 'turntrail.renameAccount',
        add: 'turntrail.addAccount',
        import: 'turntrail.importAccount',
        refresh: 'turntrail.refreshAccountQuota',
        useReset: 'turntrail.useCodexReset',
        handoff: 'turntrail.createHandoff',
        openHandoff: 'turntrail.openLatestHandoff',
        copyHandoff: 'turntrail.copyLatestHandoffPrompt'
      };
      const command = commands[message?.type];
      if (!command) return;
      // `confirmed` tells the handler the panel already asked in the card, so
      // it must not raise a dialog of its own.
      vscode.commands.executeCommand(command, {
        accountId: message.id,
        provider: message.provider,
        confirmed: true,
        purge: Boolean(message.purge),
        label: message.label,
        target: message.target,
        mode: message.mode
      });
    });

    // Reading quota when the panel is shown keeps the numbers current without a
    // background timer. This is not a forced refresh, so the cache TTL still
    // applies and repeatedly toggling the panel costs nothing.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.store.reloadUsage().catch(() => this.store.refresh());
    });
    this.post(await this.store.viewModel());
  }

  post(model) {
    if (this.view?.visible) this.view.webview.postMessage({ type: 'state', model });
  }
}

function remainingOf(usage) {
  const values = (usage?.windows || [])
    .map((window) => window.remainingPercent)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : undefined;
}

function nextReset(windows) {
  const times = (windows || [])
    .map((window) => Date.parse(window.resetsAt || ''))
    .filter((value) => Number.isFinite(value));
  return times.length > 0 ? new Date(Math.min(...times)).toISOString() : undefined;
}

function planLabel(plan) {
  return String(plan).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

// Colours come from the editor's own theme tokens, so the panel follows
// whatever theme is active - including the high-contrast ones - instead of
// shipping a palette that only suits the default dark. The two section edges
// are the deliberate exception: they identify the agent, so they must stay
// recognisable rather than blend in.
function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --gap: 10px;
    --radius: 6px;
    --hairline: var(--vscode-panel-border, rgba(128,128,128,0.25));
    --dim: var(--vscode-descriptionForeground);
    /* Claude's own orange, which reads on both grounds, so one value serves
       both themes. Codex has no such colour, so its edge is the theme's
       opposite - white on dark, black on light - and is defined per theme. */
    --edge-claude: #d97757;
    --edge-codex: var(--vscode-foreground);
  }
  body.vscode-dark { --edge-codex: #ffffff; }
  body.vscode-light { --edge-codex: #000000; }
  body.vscode-high-contrast { --edge-codex: var(--vscode-contrastBorder, #ffffff); }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--gap) 0 18px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .agents { display: flex; flex-direction: column; gap: 16px; }
  /* The section box. The edge carries the agent's identity, so it is drawn at
     partial strength rather than full: a solid white rectangle in a dark theme
     outweighs everything inside it. */
  .agent {
    position: relative;
    margin: 0 var(--gap);
    padding: 16px 10px 12px;
    border: 1px solid color-mix(in srgb, var(--edge) 55%, transparent);
    border-radius: 9px;
  }
  .agent[data-provider="codex"] { --edge: var(--edge-codex); }
  .agent[data-provider="claude"] { --edge: var(--edge-claude); }
  .agent[data-provider="handoff"] { --edge: var(--vscode-charts-blue, #3794ff); }
  /* Sitting on the border so the rule reads as a titled frame, not a heading
     that happens to be above a box. */
  .agent-name {
    position: absolute; top: -0.65em; left: 12px;
    padding: 0 7px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    color: var(--edge);
    font-size: 0.72em; font-weight: 700;
    letter-spacing: 0.09em; text-transform: uppercase;
  }
  .pool {
    padding: 10px 12px 11px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--vscode-editorWidget-background, transparent);
  }
  .pool-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .pool-title { font-weight: 600; }
  .pool-total { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 1.1em; }
  .pool-sub { color: var(--dim); font-size: 0.9em; margin-top: 2px; }
  .list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .item {
    padding: 9px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.active { border-color: var(--edge); background: var(--vscode-list-inactiveSelectionBackground); }
  .head { display: flex; align-items: center; gap: 9px; }
  .avatar {
    flex: none;
    width: 26px; height: 26px;
    border-radius: 50%;
    display: grid; place-items: center;
    font-size: 0.8em; font-weight: 700;
    color: var(--vscode-editor-background, #1e1e1e);
    background: var(--tint);
  }
  .ident { min-width: 0; flex: 1; }
  .name { display: flex; align-items: center; gap: 6px; }
  .name b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pencil {
    flex: none; padding: 1px 4px; line-height: 1; border-radius: 3px;
    border: none; background: transparent; color: var(--dim);
    cursor: pointer; opacity: 0; transition: opacity 120ms ease;
  }
  .item:hover .pencil, .pencil:focus-visible { opacity: 1; }
  .pencil:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .card-refresh {
    flex: none; padding: 1px 5px; line-height: 1; border-radius: 4px; font-size: 0.95em;
    border: none; background: transparent; color: var(--dim);
    cursor: pointer; opacity: 1;
  }
  .card-refresh:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
  .rename { display: flex; gap: 6px; align-items: center; }
  .rename input {
    flex: 1; min-width: 0; font-family: inherit; font-size: 0.95em; padding: 3px 7px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder);
  }
  .pool-refresh {
    margin-left: auto; padding: 2px 8px; border-radius: 4px; font-size: 0.8em;
    border: 1px solid var(--hairline); background: transparent; color: var(--dim); cursor: pointer;
  }
  .pool-refresh:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .pool-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--dim); font-size: 0.82em; }
  .plan {
    flex: none;
    font-size: 0.75em; letter-spacing: 0.02em;
    padding: 1px 6px; border-radius: 999px;
    border: 1px solid var(--hairline); color: var(--dim);
  }
  .email { color: var(--dim); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pct { flex: none; font-variant-numeric: tabular-nums; font-weight: 600; }
  .pct.warn { color: var(--vscode-charts-yellow); }
  .pct.crit { color: var(--vscode-charts-red); }
  /* The track must not carry opacity: it applies to the fill inside too, which
     washed every bar out to 35%. Dim the track's own colour instead. */
  .bar {
    position: relative; overflow: hidden;
    height: 5px; margin-top: 8px;
    border-radius: 999px;
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.25));
  }
  .bar > i {
    position: absolute; inset: 0 auto 0 0;
    border-radius: 999px;
    background: var(--fill);
    transition: width 220ms ease;
  }
  .meta {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-top: 6px; color: var(--dim); font-size: 0.85em;
  }
  .badge { color: var(--vscode-charts-green); font-weight: 600; }
  .badge.crit { color: var(--vscode-charts-red); }
  .recommended {
    color: var(--vscode-charts-green); font-size: 0.72em; font-weight: 600;
    border: 1px solid color-mix(in srgb, var(--vscode-charts-green) 45%, transparent);
    border-radius: 4px; padding: 1px 4px;
  }
  .health { font-weight: 600; }
  .health.warn { color: var(--vscode-charts-yellow); }
  .health.crit { color: var(--vscode-charts-red); }
  .health.ok { color: var(--vscode-charts-green); }
  /* Always visible. Hiding actions until hover is what sent people to the
     command palette in the first place. */
  .actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
  .confirm {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    margin-top: 8px; padding-top: 8px;
    border-top: 1px solid var(--hairline);
    font-size: 0.85em; color: var(--dim);
  }
  .confirm .danger {
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-charts-red));
    color: var(--vscode-foreground);
  }
  [hidden] { display: none !important; }
  button {
    font-family: inherit; font-size: 0.85em;
    padding: 3px 9px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .add {
    margin-top: 8px;
    width: 100%;
    text-align: center; padding: 7px;
    border: 1px dashed color-mix(in srgb, var(--edge) 45%, transparent);
    background: transparent; color: var(--dim);
  }
  .add:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .adopt {
    border-style: solid;
    border-color: color-mix(in srgb, var(--edge) 35%, transparent);
    color: var(--vscode-foreground);
  }
  .empty { padding: 4px 2px 8px; color: var(--dim); line-height: 1.5; font-size: 0.9em; }
  /* One meter per limit window. A single bar could only ever show the tightest
     one, which hides the fact that a healthy 5h window sits behind an exhausted
     weekly one - or the reverse. */
  .meters { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; }
  .meter-top {
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    margin-bottom: 3px;
  }
  .meter-label { color: var(--dim); font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meter-label b { color: var(--vscode-foreground); font-weight: 600; }
  .meter .bar { margin-top: 0; }
  .additional-limits {
    display: flex; flex-direction: column; gap: 9px;
    margin-top: 10px; padding-top: 9px;
    border-top: 1px solid var(--hairline);
  }
  .additional-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .additional-title b { font-size: 0.88em; font-weight: 600; }
  .additional-title span, .additional-status { color: var(--dim); font-size: 0.78em; }
  .additional-limit .meters { margin-top: 6px; }
  .reset-credits {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px; padding-top: 9px;
    border-top: 1px solid var(--hairline);
  }
  .reset-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .reset-copy b { font-size: 0.88em; font-weight: 600; }
  .reset-copy span { color: var(--dim); font-size: 0.78em; }
  button:disabled { opacity: 0.55; cursor: default; }
  button:disabled:hover { background: var(--vscode-button-secondaryBackground); }

  /* Handoff */
  .handoff { display: flex; flex-direction: column; gap: 10px; }
  .handoff-lede { color: var(--dim); font-size: 0.88em; line-height: 1.45; }
  .choice { display: flex; flex-direction: column; gap: 4px; }
  .choice-label { color: var(--dim); font-size: 0.78em; letter-spacing: 0.04em; text-transform: uppercase; }
  .segmented { display: flex; gap: 0; }
  .segmented button {
    flex: 1; border-radius: 0; margin: 0;
    border: 1px solid var(--hairline); border-right-width: 0;
    background: transparent; color: var(--dim);
  }
  .segmented button:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  .segmented button:last-child { border-radius: 0 var(--radius) var(--radius) 0; border-right-width: 1px; }
  .segmented button[aria-pressed="true"] {
    background: color-mix(in srgb, var(--edge) 18%, transparent);
    border-color: color-mix(in srgb, var(--edge) 55%, transparent);
    color: var(--vscode-foreground); font-weight: 600;
  }
  .segmented button:hover { color: var(--vscode-foreground); }
  .go { width: 100%; padding: 7px; }
  .last {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding-top: 9px; border-top: 1px solid var(--hairline);
    color: var(--dim); font-size: 0.85em;
  }
  .last span { flex: 1; min-width: 0; }
  @media (prefers-reduced-motion: reduce) { .bar > i { transition: none; } }
</style>
</head>
<body>
<div id="root"><div class="empty" style="padding-left:12px">Loading subscriptions…</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const TINTS = ['--vscode-charts-blue','--vscode-charts-purple','--vscode-charts-green','--vscode-charts-orange','--vscode-charts-red','--vscode-charts-yellow'];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—';
  return (Number.isInteger(value) ? value : value.toFixed(1)) + '%';
}
function tint(id) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 'var(' + TINTS[hash % TINTS.length] + ')';
}
// "a subscription" but "an account" - the two agents' nouns differ.
function article(noun) {
  return /^[aeiou]/i.test(noun) ? 'n' : '';
}
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  return name.slice(0, 1) + '•••@' + domain;
}
function ago(iso) {
  const at = Date.parse(iso || '');
  if (!isFinite(at)) return 'never';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
}
function until(iso) {
  const at = Date.parse(iso || '');
  if (!isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60000);
  // A reset time already well in the past does not mean "resetting now" — it
  // means the reading predates it. Fresh data always resets in the future, so a
  // past reset time is a stale reading whose percentage no longer holds; say so
  // rather than dressing it up as an imminent reset.
  if (minutes < -2) return 'stale · refresh';
  if (minutes <= 0) return 'resetting now';
  if (minutes < 60) return 'resets in ' + minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return 'resets in ' + hours + 'h';
  return 'resets in ' + Math.round(hours / 24) + 'd';
}

function expires(iso) {
  const at = Date.parse(iso || '');
  if (!isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60000);
  if (minutes <= 0) return 'expiry pending refresh';
  if (minutes < 60) return 'expires in ' + minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return 'expires in ' + hours + 'h';
  return 'expires in ' + Math.round(hours / 24) + 'd';
}
function level(row) {
  if (row.limitReached || (typeof row.remaining === 'number' && row.remaining <= 5)) return 'crit';
  if (typeof row.remaining === 'number' && row.remaining <= 20) return 'warn';
  return 'ok';
}
function fillColor(name) {
  return name === 'crit' ? 'var(--vscode-charts-red)'
    : name === 'warn' ? 'var(--vscode-charts-yellow)'
    : 'var(--vscode-charts-green)';
}

// Bar width: a non-zero remainder must still paint something, or 0.4% and 0%
// look identical.
function barWidth(value) {
  return typeof value === 'number' ? Math.max(value, value > 0 ? 2 : 0) : 0;
}

function levelOf(remaining) {
  if (typeof remaining !== 'number') return 'ok';
  if (remaining <= 5) return 'crit';
  if (remaining <= 20) return 'warn';
  return 'ok';
}

// One labelled meter for one limit window. Each is coloured by its own state,
// not the account's: a weekly allowance at 60% should not be painted red
// because the five-hour window beside it is spent.
function renderMeter(window) {
  const state = levelOf(window.remaining);
  const reset = window.resetsAt ? until(window.resetsAt) : '';
  return '<div class="meter">' +
    '<div class="meter-top">' +
      '<span class="meter-label"><b>' + esc(window.label) + '</b>' + (reset ? ' · ' + esc(reset) : '') + '</span>' +
      '<span class="pct ' + (state === 'ok' ? '' : state) + '">' + pct(window.remaining) + '</span>' +
    '</div>' +
    '<div class="bar"><i style="width:' + barWidth(window.remaining) + '%;--fill:' + fillColor(state) + '"></i></div>' +
  '</div>';
}

function renderAdditionalLimit(limit) {
  const meters = (limit.windows || []).map(renderMeter).join('');
  return '<div class="additional-limit">' +
    '<div class="additional-title"><b>' + esc(limit.label) + '</b>' +
      '<span>Separate allowance</span></div>' +
    (limit.limitReached ? '<div class="additional-status">Limit reached</div>' : '') +
    (meters ? '<div class="meters">' + meters + '</div>' : '<div class="additional-status">Quota unavailable</div>') +
  '</div>';
}

function renderResetCredits(row) {
  const reset = row.resetCredits;
  if (!reset || reset.availableCount <= 0) return '';
  const count = reset.availableCount;
  const expiry = reset.nextExpiresAt ? expires(reset.nextExpiresAt) : '';
  return '<div class="reset-credits">' +
    '<span class="reset-copy"><b>' + count + ' banked reset' + (count === 1 ? '' : 's') + '</b>' +
      (expiry ? '<span>' + esc(expiry) + '</span>' : '') + '</span>' +
    '<button data-act="useReset" data-id="' + esc(row.id) + '" data-provider="codex">Use reset</button>' +
  '</div>';
}

function renderRow(row) {
  const state = level(row);
  const width = barWidth(row.remaining);
  const id = esc(row.id);
  const provider = esc(row.provider);
  const health = row.health || { label: 'Quota unknown', tone: 'neutral' };

  let status;
  if (row.needsActivation) status = 'New sign-in ready';
  else if (row.requiresRevalidation) status = row.active ? 'Selected login needs repair' : 'Login needs verification';
  else if (!row.signedIn) status = row.active ? 'Selected login needs sign-in' : 'Not signed in';
  else if (row.error) status = esc(row.error);
  // "Limit reached" on its own leaves the one question that matters
  // unanswered. The resume time is the whole reason to look at the card.
  else if (row.limitReached) status = 'Limit reached' + (row.resumesAt ? ' · ' + until(row.resumesAt) : '');
  else if (!row.loaded) status = 'Quota not read';
  else if (typeof row.remaining !== 'number') status = 'Quota unavailable';
  // The meters already carry each window's reset, so repeating the soonest here
  // would just be the same fact twice.
  else status = (row.windows || []).length > 0 ? '' : until(row.resetsAt);

  const credits = row.credits && row.credits.hasCredits
    ? (row.credits.unlimited ? ' · unlimited credits' : ' · ' + row.credits.balance + ' credits')
    : '';

  // Every window gets its own meter. With nothing to meter - not signed in, or
  // never polled - fall back to one flat bar so the card keeps its shape.
  const meters = (row.windows || []).length > 0
    ? '<div class="meters">' + row.windows.map(renderMeter).join('') + '</div>'
    : '<div class="bar"><i style="width:' + width + '%;--fill:' + fillColor(state) + '"></i></div>';
  const additionalLimits = (row.additionalLimits || []).length > 0
    ? '<div class="additional-limits">' + row.additionalLimits.map(renderAdditionalLimit).join('') + '</div>'
    : '';
  const resetCredits = renderResetCredits(row);

  const act = (action, text, cls) =>
    '<button class="' + (cls || '') + '" data-act="' + action + '" data-id="' + id +
    '" data-provider="' + provider + '">' + text + '</button>';

  return '<li class="item' + (row.active ? ' active' : '') + '">' +
    '<div class="head">' +
      '<span class="avatar" style="--tint:' + tint(row.id) + '">' + esc((row.label || '?').slice(0, 1).toUpperCase()) + '</span>' +
      '<span class="ident">' +
        '<span class="name" data-name="' + id + '"><b>' + esc(row.label) + '</b>' +
          (row.plan ? '<span class="plan">' + esc(row.plan) + '</span>' : '') +
          (row.recommended ? '<span class="recommended">Recommended</span>' : '') +
          '<button class="pencil" data-rename="' + id + '" title="Rename" aria-label="Rename account">✎</button>' +
        '</span>' +
        '<span class="rename" data-editor="' + id + '" data-provider="' + provider + '" hidden>' +
          '<input type="text" value="' + esc(row.label) + '" aria-label="Account name">' +
          '<button data-save="' + id + '">Save</button>' +
          '<button data-discard="' + id + '">Cancel</button>' +
        '</span>' +
        '<span class="email">' + esc(maskEmail(row.email)) + '</span>' +
      '</span>' +
      '<span class="pct ' + (state === 'ok' ? '' : state) + '">' +
        (row.signedIn && typeof row.remaining === 'number' ? pct(row.remaining) : '—') +
      '</span>' +
      (row.signedIn
        ? '<button class="card-refresh" data-act="refresh" data-id="' + id + '" data-provider="' + provider +
            '" title="Refresh this account’s usage" aria-label="Refresh this account’s usage">↻</button>'
        : '') +
    '</div>' +
    meters +
    additionalLimits +
    resetCredits +
    '<div class="meta"><span><b class="health ' + esc(health.tone) + '">' + esc(health.label) + '</b>' +
      (status && status !== health.label ? ' &middot; ' + status : '') + esc(credits) + '</span>' +
      (row.active ? '<span class="badge' + (state === 'crit' ? ' crit' : '') + '">' +
        (row.signedIn && !row.needsActivation ? 'In use' : 'Selected') + '</span>' : '') +
    '</div>' +
    '<div class="actions">' +
      (row.needsActivation
        ? act('switch', 'Update ' + (row.provider === 'claude' ? 'Claude' : 'Codex') + ' login', 'primary')
        : (row.requiresRevalidation
            ? act('switch', row.active ? 'Repair login' : 'Verify & use', 'primary')
            : (row.active || !row.signedIn ? '' : act('switch', 'Use this', 'primary')))) +
      (row.signedIn || row.requiresRevalidation ? '' : act('signin', 'Sign in', 'primary')) +
      (row.requiresRevalidation ? act('signin', 'Sign in') : '') +
      (row.signedIn ? act('terminal', 'Terminal') : '') +
      (row.signedIn ? act('raw', 'Raw Response') : '') +
      '<button data-ask="' + id + '">Remove</button>' +
    '</div>' +
    '<div class="confirm" id="confirm-' + id + '" hidden>' +
      '<span>Remove this account?</span>' +
      act('forget', 'Forget') +
      act('purge', 'Delete credentials', 'danger') +
      '<button data-cancel="' + id + '">Cancel</button>' +
    '</div>' +
  '</li>';
}

function renderSection(section) {
  const pooled = section.pooled;
  const provider = esc(section.id);
  const noun = esc(section.noun);

  const body = section.rows.length === 0
    ? '<div class="empty">No ' + esc(section.title) + ' ' + noun + 's yet. ' +
        'Existing logins are never picked up on their own — adopt the one on this machine, or sign in to another.</div>' +
      '<button class="add adopt" data-act="import" data-provider="' + provider + '">' +
        'Use the ' + esc(section.title) + ' login on this machine</button>'
    : '<div class="pool">' +
        '<div class="pool-top"><span class="pool-title">Usage remaining</span>' +
          '<span class="pool-total">' + (pooled.total === undefined ? '—' : pct(pooled.total)) + '</span></div>' +
        '<div class="pool-sub">' + pooled.count + ' connected ' + noun + (pooled.count === 1 ? '' : 's') + '</div>' +
        '<div class="bar"><i style="width:' + (pooled.average || 0) + '%;--fill:var(--edge)"></i></div>' +
        '<div class="pool-foot"><span>' + (pooled.updatedAt ? 'Updated ' + ago(pooled.updatedAt) : 'Not read yet') + '</span>' +
          '<button class="pool-refresh" data-act="refresh" data-provider="' + provider + '">Refresh now</button></div>' +
      '</div>' +
      '<ul class="list">' + section.rows.map(renderRow).join('') + '</ul>';

  return '<section class="agent" data-provider="' + provider + '">' +
    '<span class="agent-name">' + esc(section.title) + '</span>' +
    body +
    '<button class="add" data-act="add" data-provider="' + provider + '">+ ' +
      (section.rows.length === 0 ? 'Sign in to a' + article(noun) : 'Add another') + ' ' + noun + '</button>' +
  '</section>';
}

// Handoff, as a card rather than a command you have to remember. The palette
// entries still work and are unchanged - this is a second door, not a
// replacement.
let handoffTarget = 'claude';
let handoffMode = 'new';

function segmented(name, options, current) {
  return '<div class="segmented">' + options.map((option) =>
    '<button data-choose="' + name + '" data-value="' + option.value + '" aria-pressed="' +
    (option.value === current) + '">' + esc(option.label) + '</button>').join('') + '</div>';
}

function renderHandoff(latest) {
  // You hand off *to* the other agent, so the label names where the context is
  // going, and the source is stated rather than left to be inferred.
  const from = handoffTarget === 'claude' ? 'Codex' : 'Claude Code';
  const to = handoffTarget === 'claude' ? 'Claude Code' : 'Codex';

  // Naming the chat the last handoff was aimed at is the difference between
  // knowing where to paste and hunting through a folder of transcripts for it.
  const last = latest
    ? '<div class="last"><span>Last: to ' + esc(latest.target === 'codex' ? 'Codex' : 'Claude Code') +
        (latest.chat ? ' · ' + esc(latest.chat) : '') +
        ' · ' + esc(ago(latest.createdAt)) +
        (latest.words ? ' · ' + latest.words + ' words' : '') + '</span>' +
        '<button data-act="openHandoff">Open</button>' +
        '<button data-act="copyHandoff">Copy prompt</button></div>'
    : '';

  return '<section class="agent" data-provider="handoff">' +
    '<span class="agent-name">Handoff</span>' +
    '<div class="handoff">' +
      '<div class="handoff-lede">Import the latest <b>' + esc(from) + '</b> session, snapshot the workspace, ' +
        'and copy a prompt to paste into <b>' + esc(to) + '</b>.</div>' +
      '<div class="choice"><span class="choice-label">Hand off to</span>' +
        segmented('target', [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }], handoffTarget) +
      '</div>' +
      '<div class="choice"><span class="choice-label">Into</span>' +
        segmented('mode', [{ value: 'new', label: 'A new session' }, { value: 'existing', label: 'The open one' }], handoffMode) +
      '</div>' +
      '<button class="primary go" data-act="handoff">Create handoff</button>' +
      last +
    '</div>' +
  '</section>';
}

function render(model) {
  const root = document.getElementById('root');
  if (!model || !model.sections) return;
  root.innerHTML = '<div class="agents">' +
    model.sections.map(renderSection).join('') +
    renderHandoff(model.handoff) +
    '</div>';
}

// Confirmation for a destructive action happens here, in the card, so acting on
// something in this panel never hands the user off to a dialog or a picker.
// Renaming edits the label in place. The account id, and therefore the
// directory holding its credential, never changes - so a rename cannot
// invalidate a login or require signing in again.
function editing(id, on) {
  const name = document.querySelector('[data-name="' + CSS.escape(id) + '"]');
  const editor = document.querySelector('[data-editor="' + CSS.escape(id) + '"]');
  if (!name || !editor) return;
  name.hidden = on;
  editor.hidden = !on;
  if (on) {
    const input = editor.querySelector('input');
    input.focus();
    input.select();
  }
}

function commitRename(id) {
  const editor = document.querySelector('[data-editor="' + CSS.escape(id) + '"]');
  const label = editor.querySelector('input').value.trim();
  if (!label) { editor.querySelector('input').focus(); return; }
  vscode.postMessage({ type: 'rename', id, provider: editor.dataset.provider, label });
  editing(id, false);
}

document.addEventListener('keydown', (event) => {
  const editor = event.target.closest('[data-editor]');
  if (!editor) return;
  if (event.key === 'Enter') commitRename(editor.dataset.editor);
  if (event.key === 'Escape') editing(editor.dataset.editor, false);
});

document.addEventListener('click', (event) => {
  const rename = event.target.closest('[data-rename]');
  if (rename) { editing(rename.dataset.rename, true); return; }
  const save = event.target.closest('[data-save]');
  if (save) { commitRename(save.dataset.save); return; }
  const discard = event.target.closest('[data-discard]');
  if (discard) { editing(discard.dataset.discard, false); return; }

  const ask = event.target.closest('[data-ask]');
  if (ask) {
    const panel = document.getElementById('confirm-' + ask.dataset.ask);
    if (panel) panel.hidden = !panel.hidden;
    return;
  }
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) {
    const panel = document.getElementById('confirm-' + cancel.dataset.cancel);
    if (panel) panel.hidden = true;
    return;
  }
  const choose = event.target.closest('[data-choose]');
  if (choose) {
    if (choose.dataset.choose === 'target') handoffTarget = choose.dataset.value;
    else handoffMode = choose.dataset.value;
    // Remember across a panel reload, which happens whenever the view is hidden.
    vscode.setState({ handoffTarget, handoffMode });
    if (lastModel) render(lastModel);
    return;
  }

  const button = event.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  vscode.postMessage({
    type: act,
    id: button.dataset.id,
    provider: button.dataset.provider,
    purge: act === 'purge',
    target: handoffTarget,
    mode: handoffMode
  });
});

let lastModel;
window.addEventListener('message', (event) => {
  if (event.data?.type === 'state') {
    lastModel = event.data.model;
    render(lastModel);
  }
});

const saved = vscode.getState();
if (saved) {
  handoffTarget = saved.handoffTarget || handoffTarget;
  handoffMode = saved.handoffMode || handoffMode;
}
</script>
</body>
</html>`;
}

module.exports = { AccountsStore, AccountsWebview, PROVIDERS, loginNeedsUpdate };
