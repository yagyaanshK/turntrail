const path = require('node:path');
const fs = require('node:fs');
const vscode = require('vscode');
const { safeAgentCommand, safeClaudeUri } = require('./security.cjs');
const { AccountMaintenanceScheduler, shouldOfferAccountMaintenance } = require('./account-maintenance.cjs');
const { readRawUsage } = require('./raw-usage.cjs');
const { AccountsStore, AccountsWebview } = require('./accounts-view.cjs');
const { SessionsStore, SessionsWebview } = require('./sessions-view.cjs');
const { ManagedTerminalStore } = require('./managed-terminals.cjs');
const { handoffForRoot } = require('./handoff-state.cjs');
const { LoginPanel } = require('./login-view.cjs');
const { runWithCancellation } = require('./progress.cjs');
const {
  consumeSwitchResults,
  createSwitchRequest,
  editorRelaunch,
  startSwitchHelper
} = require('./switch-restart.cjs');

let accountsProvider;
let accountStatus;
let loginPanel;
let accountsWebview;
let sessionsProvider;
let sessionsWebview;
let managedTerminals;
let accountMaintenance;
let accountMaintenanceOutput;
let accountMaintenanceOffer;

async function activateExtension(context) {
  accountsProvider = new AccountsStore(core);
  accountsWebview = new AccountsWebview(accountsProvider);
  managedTerminals = new ManagedTerminalStore();
  sessionsProvider = new SessionsStore(core, workspaceRoot, { discoveryOptions: accountSessionDiscoveryOptions });
  sessionsWebview = new SessionsWebview(sessionsProvider);
  loginPanel = new LoginPanel(context, core, accountsProvider);

  // The panel is only visible when its view is open, so the account in use also
  // lives in the status bar - that is where you look while actually working.
  accountStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  accountStatus.command = 'turntrail.switchAccount';
  accountStatus.name = 'Turntrail: active account';
  accountsProvider.onDidChange(() => accountsProvider.summary().then(renderStatus));
  accountMaintenanceOutput = vscode.window.createOutputChannel('Turntrail Accounts');
  accountMaintenance = createAccountMaintenance(context);
  managedTerminals.start(context);
  sessionsProvider.setManaged(managedTerminals.viewModel());

  context.subscriptions.push(
    accountStatus,
    accountMaintenanceOutput,
    accountMaintenance,
    accountsProvider.emitter,
    sessionsProvider.emitter,
    managedTerminals.onDidChange(() => sessionsProvider.setManaged(managedTerminals.viewModel())),
    accountsProvider.onDidChange(() => queueAccountMaintenanceOffer(context)),
    vscode.window.registerWebviewViewProvider('turntrailAccounts', accountsWebview),
    vscode.window.registerWebviewViewProvider('turntrailSessions', sessionsWebview),
    ...compatibleCommands('switchAccount', (item) => switchAccount(item)),
    ...compatibleCommands('showRawUsage', (item) => showRawUsage(item)),
    ...compatibleCommands('undoAccountSwitch', () => undoAccountSwitch()),
    ...compatibleCommands('addAccount', (item) => addAccount(item)),
    ...compatibleCommands('importAccount', (item) => importAccount(item)),
    ...compatibleCommands('addCodexAccount', () => addAccount({ provider: 'codex' })),
    ...compatibleCommands('addClaudeAccount', () => addAccount({ provider: 'claude' })),
    ...compatibleCommands('importCodexAccount', () => importAccount({ provider: 'codex' })),
    ...compatibleCommands('importClaudeAccount', () => importAccount({ provider: 'claude' })),
    ...compatibleCommands('signInAccount', (item) => signInAccount(item)),
    ...compatibleCommands('refreshAccountQuota', (item) => refreshAccountQuota(item)),
    ...compatibleCommands('useCodexReset', (item) => useCodexReset(item)),
    ...compatibleCommands('openAccountTerminal', (item) => openAccountTerminal(item)),
    ...compatibleCommands('renameAccount', (item) => renameAccount(item)),
    ...compatibleCommands('forgetAccount', (item) => forgetAccount(item)),
    ...compatibleCommands('toggleAccountMaintenance', () => toggleAccountMaintenance()),
    ...compatibleCommands('runAccountMaintenance', () => runAccountMaintenance()),
    ...compatibleCommands('discoverClaude', () => discover('claude')),
    ...compatibleCommands('discoverCodex', () => discover('codex')),
    ...compatibleCommands('discoverGemini', () => discover('gemini')),
    ...compatibleCommands('discoverCursor', () => discover('cursor')),
    ...compatibleCommands('importLatestClaude', () => importLatest('claude')),
    ...compatibleCommands('importLatestCodex', () => importLatest('codex')),
    ...compatibleCommands('importLatestGemini', () => importLatest('gemini')),
    ...compatibleCommands('importLatestCursor', () => importLatest('cursor')),
    ...compatibleCommands('createHandoff', (item) =>
      handoff(item?.target === 'codex' ? 'codex' : 'claude', item?.mode === 'existing' ? 'existing' : 'new')
    ),
    ...compatibleCommands('refreshSessions', (item) => refreshSessions(item)),
    ...compatibleCommands('importIndexedSession', (item) => importIndexedSession(item)),
    ...compatibleCommands('viewIndexedSession', (item) => viewIndexedSession(item)),
    ...compatibleCommands('handoffIndexedSession', (item) => handoffIndexedSession(item)),
    ...compatibleCommands('openManagedSession', (item) => openManagedSession(item)),
    ...compatibleCommands('focusManagedSession', (item) => focusManagedSession(item)),
    ...compatibleCommands('closeManagedSession', (item) => closeManagedSession(item)),
    ...compatibleCommands('handoffToClaudeExisting', () => handoff('claude', 'existing')),
    ...compatibleCommands('handoffToClaudeNew', () => handoff('claude', 'new')),
    ...compatibleCommands('handoffToCodexExisting', () => handoff('codex', 'existing')),
    ...compatibleCommands('handoffToCodexNew', () => handoff('codex', 'new')),
    ...compatibleCommands('openLatestHandoff', () => openLatestHandoff()),
    ...compatibleCommands('copyLatestHandoffPrompt', () => copyLatestHandoffPrompt()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('turntrail.accountMaintenance') ||
        event.affectsConfiguration('contextBridge.accountMaintenance')
      ) {
        accountMaintenance.reschedule();
      }
    })
  );

  // Populate the panel and status bar from cache on activation. Offline, so
  // opening a window never costs a call to the usage endpoint.
  accountsProvider.reloadUsage({ offline: true }).catch(() => {});
  publishHandoffState().catch(() => {});
  startSwitchResultMonitor(context);
  accountMaintenance.start();
  queueAccountMaintenanceOffer(context);
}

function deactivate() {}

async function accountSessionDiscoveryOptions() {
  const api = await core();
  const accounts = await api.listAccounts();
  return {
    codex: {
      additionalLocations: accounts.filter((account) => account.provider === 'codex').map((account) => {
        const home = api.codexHome(account.id);
        return {
          sessionsDir: path.join(home, 'sessions'),
          archivedDir: path.join(home, 'archived_sessions'),
          sessionIndex: path.join(home, 'session_index.jsonl')
        };
      })
    },
    claude: {
      additionalLocations: accounts.filter((account) => account.provider === 'claude').map((account) => ({
        projectsDir: path.join(api.claudeHome(account.id), 'projects')
      }))
    }
  };
}

// ---------------------------------------------------------------------------
// Codex subscriptions
//
// Each account owns a CODEX_HOME. Signing in, running a session, and reading
// quota all happen against that directory, so several subscriptions stay logged
// in at once and nothing has to be swapped to use a different one.
//
// The one exception is "Set as Default", which writes the official CLI's own
// home. The official Codex CLI and VS Code extension read only that path, so
// pointing them at an account is necessarily machine-wide.
// ---------------------------------------------------------------------------

// Switch which subscription the official Codex CLI and VS Code extension use.
//
// They read only the default CODEX_HOME, so this necessarily rewrites that
// credential rather than scoping anything to one window. It is still a cheap,
// reversible action - every subscription stays signed in on disk - so it runs
// on a single click and offers an undo afterwards instead of a confirmation
// prompt beforehand.
async function switchAccount(item) {
  const account = await resolveAccount(item, { excludeActive: true });
  if (!account) return;

  const api = await core();
  const processes = await api.listAgentProcesses().catch((error) => {
    vscode.window.showErrorMessage(`Turntrail: could not inspect running agent processes — ${error.message}`);
    return undefined;
  });
  if (!processes) return;
  const blockers = api.classifyAgentProcesses(account.provider, processes);
  if (blockers.length > 0) {
    const proceed = await handleRunningProviderProcesses(account, blockers, api);
    if (!proceed) return;
  }

  const activate = account.provider === 'claude' ? api.activateClaudeAccount : api.activateCodexAccount;
  let result = await activate(account.id).catch((error) => ({ error: error.message }));
  if (result?.error) {
    const raced = await api.listAgentProcesses().catch(() => []);
    const racedBlockers = api.classifyAgentProcesses(account.provider, raced);
    if (racedBlockers.length > 0) {
      const proceed = await handleRunningProviderProcesses(account, racedBlockers, api);
      if (!proceed) return;
      result = await activate(account.id).catch((error) => ({ error: error.message }));
    }
  }
  if (result?.error) {
    vscode.window.showErrorMessage(`Turntrail: could not switch to "${account.label}" — ${result.error}`);
    return;
  }
  await accountsProvider.reloadUsage({ offline: true });

  const usage = accountsProvider.usage.get(account.id);
  const remaining = usage?.windows?.length
    ? ` · ${formatPercent(Math.min(...usage.windows.map((window) => window.remainingPercent)))} left`
    : '';

  vscode.window
    .showInformationMessage(
      `${agentName(account.provider)} is now using "${account.label}"${remaining}. Reload if an open session does not pick it up.`,
      'Reload Window',
      'Undo'
    )
    .then((choice) => {
      if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      else if (choice === 'Undo') undoAccountSwitch({ provider: account.provider });
    });
}

async function handleRunningProviderProcesses(account, blockers, api) {
  const agent = agentName(account.provider);
  const editors = [...new Set(blockers.map((item) => item.editor).filter(Boolean))];
  const desktopClients = [...new Set(blockers.map((item) => item.client).filter(Boolean))];
  const interactive = blockers.filter((item) => item.kind === 'interactive');
  const processNames = [...new Set(blockers.map((item) => item.name).filter(Boolean))].slice(0, 4).join(', ');
  const locations = editors.length > 0 ? ` Editor services: ${editors.join(', ')}.` : '';
  const desktops = desktopClients.length > 0 ? ` Desktop clients: ${desktopClients.join(', ')}.` : '';
  const sessions = interactive.length > 0
    ? ` ${interactive.length} other ${agent} process${interactive.length === 1 ? ' is' : 'es are'} also running.`
    : '';
  const choice = await vscode.window.showWarningMessage(
    `${agent} must stop before Turntrail can safely switch to "${account.label}".`,
    {
      modal: true,
      detail:
        `Running provider processes${processNames ? `: ${processNames}` : ''}.${locations}${desktops}${sessions}\n\n` +
        `Every ${agent} client that owns the shared login must stop, including CLI sessions, desktop clients, ` +
        `and IDE extension services. Unrelated editor windows can stay open.\n\n` +
        `Stopping these processes can interrupt active agent runs. Turntrail can stop them now, or wait while ` +
        `you close the relevant clients yourself.`
    },
    'Stop Processes & Switch',
    'Wait for Me to Stop Them'
  );
  if (choice === 'Wait for Me to Stop Them') {
    await queueSwitchAfterProviderStops(account, blockers);
    return false;
  }
  if (choice !== 'Stop Processes & Switch') return false;

  const stopped = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Stopping ${agent} processes`,
      cancellable: false
    },
    () => api.terminateAgentProcesses(account.provider)
  ).catch((error) => ({ error: error.message }));

  if (stopped?.error) {
    vscode.window.showErrorMessage(`Turntrail: could not stop ${agent} processes - ${stopped.error}`);
    return false;
  }
  if (stopped.remaining.length > 0) {
    await queueSwitchAfterProviderStops(account, stopped.remaining);
    vscode.window.showWarningMessage(
      `Turntrail: ${agent} restarted before the switch. The switch is queued; close or disable the client that keeps restarting it.`
    );
    return false;
  }
  return true;
}

async function queueSwitchAfterProviderStops(account, blockers) {
  const agent = agentName(account.provider);
  const editors = [...new Set(blockers.map((item) => item.editor).filter(Boolean))];

  const directory = switchResultsDirectory();
  let queued;
  try {
    queued = await createSwitchRequest(directory, {
      provider: account.provider,
      accountId: account.id,
      accountLabel: account.label,
      editorHostPid: process.pid,
      relaunch: editorRelaunch(
        { execPath: process.execPath },
        {
          workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
          folder: vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file'
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined
        }
      ),
      blockers
    });
    await startSwitchHelper({
      editorExecutable: process.execPath,
      helperPath: path.join(__dirname, 'switch-helper.cjs'),
      requestPath: queued.requestPath
    });
  } catch (error) {
    if (queued?.requestPath) await fs.promises.rm(queued.requestPath, { force: true }).catch(() => {});
    vscode.window.showErrorMessage(`Turntrail: could not queue the account switch — ${error.message}`);
    return;
  }

  const affected = editors.length > 0
    ? ` Stop ${agent} in ${editors.join(' and ')}; close those editor windows only if their extension service will not stop.`
    : ` Close every running ${agent} CLI or desktop client.`;
  vscode.window.showInformationMessage(
    `Turntrail is waiting to switch to "${account.label}".${affected} The initiating editor will reopen if it was closed.`
  );
}

function startSwitchResultMonitor(context) {
  let reading = false;
  const read = async () => {
    if (reading) return;
    reading = true;
    try {
      for (const result of await consumeSwitchResults(switchResultsDirectory())) {
        if (result.success) {
          await accountsProvider.reloadUsage({ offline: true });
          const relaunch = result.relaunchError ? ` The editor could not reopen automatically: ${result.relaunchError}` : '';
          const choice = await vscode.window.showInformationMessage(
            `Turntrail: ${agentName(result.provider)} is now using "${result.accountLabel || result.accountId}".${relaunch}`,
            'Reload Window'
          );
          if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
          vscode.window.showErrorMessage(
            `Turntrail: queued switch to "${result.accountLabel || result.accountId || 'account'}" failed — ${result.error}`
          );
        }
      }
    } catch (error) {
      console.error(`Turntrail could not read queued switch results: ${error.message}`);
    } finally {
      reading = false;
    }
  };
  read();
  const timer = setInterval(read, 1500);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function switchResultsDirectory() {
  return path.join(extensionContext.globalStorageUri.fsPath, 'switches');
}

function agentName(provider) {
  return provider === 'claude' ? 'Claude Code' : 'Codex';
}

async function undoAccountSwitch(item) {
  const { restoreCodexBackup, restoreClaudeBackup } = await core();
  const provider = item?.provider === 'claude' ? 'claude' : 'codex';
  const restore = provider === 'claude' ? restoreClaudeBackup : restoreCodexBackup;
  await restore();
  await accountsProvider.reloadUsage({ offline: true });
  vscode.window.showInformationMessage(`Turntrail: restored the previous ${agentName(provider)} login.`);
}

// The usage payload is not a published contract, so when the panel cannot find
// any windows this shows exactly what came back. Beats guessing at the shape.
async function showRawUsage(item) {
  const account = await resolveAccount(item);
  if (!account) return;

  const api = await core();
  const claude = account.provider === 'claude';

  const endpoint = claude ? api.CLAUDE_USAGE_URL : api.CODEX_USAGE_URL;
  const auth = claude
    ? await api.ensureClaudeAccessToken(account.id)
    : await api.readCodexAuth(api.codexHome(account.id));
  if (!auth?.accessToken) {
    if (!claude && auth?.apiKey) {
      throw new Error('Raw subscription quota is unavailable for Codex API-key authentication.');
    }
    throw new Error(`"${account.label}" is not signed in.`);
  }

  const headers = claude
    ? api.claudeApiHeaders(auth.accessToken)
    : {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'turntrail',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {})
      };

  const raw = await withProgress(`Reading usage for ${account.label}`, ({ signal }) =>
    readRawUsage(api, { endpoint, headers, signal, claude, auth })
  );
  const document = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(
      {
        note: `Raw response from the ${agentName(account.provider)} usage endpoint, plus how Turntrail parsed it. No tokens are included.`,
        endpoint,
        httpStatus: raw.status,
        rawResponse: raw.body,
        parsedByTurntrail: raw.parsed
      },
      null,
      2
    )
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

function renderStatus(summary) {
  if (!summary?.label) {
    accountStatus.hide();
    return;
  }
  const remaining = summary.remaining;
  accountStatus.text =
    remaining === undefined
      ? `$(arrow-swap) ${summary.label}`
      : `$(arrow-swap) ${summary.label} ${formatPercent(remaining)}`;
  accountStatus.tooltip =
    `${summary.title || 'Codex'} is using "${summary.label}". Click to switch account.` +
    // Being told the limit is reached without being told when it lifts is the
    // half of the message that is no use.
    (summary.limitReached ? `\nLimit reached${summary.resumesAt ? ` — resumes ${describeWhen(summary.resumesAt)}` : ''}.` : '');
  accountStatus.backgroundColor =
    typeof remaining === 'number' && remaining <= 10
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  accountStatus.show();
}

// "in 42m" / "in 3d", for a sentence rather than a bare label.
function describeWhen(iso) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return 'soon';
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

// Naming and sign-in both happen in the panel, so adding an account is one
// uninterrupted flow rather than an input box followed by a terminal.
async function addAccount(item) {
  const provider = await resolveProvider(item);
  if (!provider) return;
  const accounts = await accountsProvider.accounts(provider);
  await loginPanel.open({ provider, label: `${agentName(provider)} ${accounts.length + 1}` });
}

// The panel names the agent it was clicked in; the palette has to ask.
async function resolveProvider(item) {
  if (item?.provider === 'codex' || item?.provider === 'claude') return item.provider;
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Codex', description: 'ChatGPT subscription or API key', provider: 'codex' },
      { label: 'Claude Code', description: 'Claude Pro, Max, Team or Console account', provider: 'claude' }
    ],
    { placeHolder: 'Which agent?' }
  );
  return picked?.provider;
}

async function importAccount(item) {
  const provider = await resolveProvider(item);
  if (!provider) return;

  const api = await core();
  const claude = provider === 'claude';
  const source = claude ? api.defaultClaudeHome() : api.defaultCodexHome();
  const credential = claude ? '.credentials.json' : 'auth.json';
  if (!fs.existsSync(path.join(source, credential))) {
    throw new Error(
      `No existing ${agentName(provider)} login found at ${source}. Sign in from the panel instead.`
    );
  }

  const label = await vscode.window.showInputBox({
    title: `Import current ${agentName(provider)} login`,
    prompt: `Name for the account currently signed in at ${source}`,
    value: 'Primary',
    validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
  });
  if (!label) return;

  const account = await api.createAccount({ label: label.trim(), provider });
  try {
    let auth = claude
      ? await api.importClaudeAuth(account.id, source)
      : await api.importCodexAuth(account.id, source);
    // A Claude credential carries no email; ask the API who it belongs to.
    if (claude) auth = (await api.backfillClaudeProfile(account.id).catch((error) => {
      if (error?.code === 'PROVIDER_CONTRACT_CHANGED') throw error;
      return auth;
    })) || auth;

    // Import reads the official client's live credential, so the imported
    // account is already selected. Do not present it as waiting to be applied.
    await api.updateAccount(account.id, { lastUsedAt: new Date().toISOString() });

    await accountsProvider.reloadUsage({ force: true });
    vscode.window.showInformationMessage(
      `Turntrail: imported ${auth?.claims?.email || auth?.email || label.trim()} as "${account.label}". The original login is untouched.`
    );
  } catch (error) {
    try {
      await api.removeAccount(account.id, { purge: true, purgeLive: false });
    } catch (cleanupError) {
      throw new Error(`${error.message} Turntrail could not remove the incomplete account: ${cleanupError.message}`);
    }
    throw error;
  }
}

async function signInAccount(item) {
  const account = await resolveAccount(item);
  if (account) {
    await loginPanel.open({ provider: account.provider, accountId: account.id, label: account.label });
  }
}

async function openAccountTerminal(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const api = await core();
  const claude = account.provider === 'claude';

  const signedIn = claude ? await api.isClaudeSignedIn(account.id) : await api.isSignedIn(account.id);
  if (!signedIn) throw new Error(`"${account.label}" is not signed in yet. Use "Sign In" first.`);

  if (claude) await api.ensureClaudeHome(account.id);
  else await api.ensureCodexHome(account.id);

  const root = await workspaceRoot();
  const terminal = vscode.window.createTerminal({
    name: `${agentName(account.provider)} · ${account.label}`,
    cwd: root,
    // One environment variable is the whole isolation mechanism: the CLI
    // treats whatever it points at as its entire world.
    env: claude ? api.claudeEnv(account.id) : api.codexEnv(account.id)
  });
  terminal.show();
  terminal.sendText(claude ? 'claude' : 'codex');
}

// Rename changes only the display label. The account id forms the path to its
// credential directory and is deliberately left alone, so renaming can never
// invalidate a login or require signing in again.
async function renameAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { updateAccount } = await core();

  let label = typeof item?.label === 'string' ? item.label.trim() : '';
  if (!label) {
    // The panel edits inline; the palette has to ask.
    label = (
      await vscode.window.showInputBox({
        title: 'Rename subscription',
        value: account.label,
        prompt: 'This changes the display name only, not the stored login.',
        validateInput: (value) => (value.trim() ? undefined : 'Enter a name.')
      })
    )?.trim();
  }
  if (!label || label === account.label) return;

  await updateAccount(account.id, { label });
  await accountsProvider.reloadUsage({ offline: true });
}

// The panel confirms in the card before calling this, so an invocation carrying
// `confirmed` acts immediately. Only the command palette, which has nowhere to
// put an inline confirmation, falls back to a dialog.
async function forgetAccount(item) {
  const account = await resolveAccount(item);
  if (!account) return;
  const { removeAccount } = await core();

  let purge = Boolean(item?.purge);
  if (!item?.confirmed) {
    const choice = await vscode.window.showWarningMessage(
      `Remove "${account.label}" from Turntrail?`,
      {
        modal: true,
        detail:
          `"Forget" removes it from this list but leaves its login on disk at ${account.dir}, so it can be added back.\n\n` +
          `"Delete Credentials" also erases that directory and, if this account is active, its live ${agentName(account.provider)} login. ` +
          `Stop ${agentName(account.provider)} first. This cannot be undone.`
      },
      'Forget',
      'Delete Credentials'
    );
    if (choice !== 'Forget' && choice !== 'Delete Credentials') return;
    purge = choice === 'Delete Credentials';
  }

  await removeAccount(account.id, { purge });
  accountsProvider.usage.delete(account.id);
  await accountsProvider.reloadUsage({ offline: true });
  vscode.window.setStatusBarMessage(
    `Turntrail: removed "${account.label}"${purge ? ' and deleted its credentials' : ''}.`,
    4000
  );
}

async function refreshAccountQuota(item) {
  // A card's own refresh button identifies its account, so refresh just that
  // one. A pool "Refresh now" carries only its provider. The palette and the
  // title-bar button carry neither and refresh everything.
  if (item?.accountId && item?.provider) {
    const usage = await withProgress(`Refreshing ${agentName(item.provider)} quota`, ({ signal }) =>
      accountsProvider.reloadUsageOne(item.accountId, item.provider, { force: true, signal })
    );
    if (usage?.error) {
      vscode.window.showWarningMessage(`Turntrail: could not read that account's usage — ${usage.error}`);
    }
    return;
  }
  if (item?.provider) {
    await withProgress(`Reading ${agentName(item.provider)} quota`, ({ signal }) =>
      accountsProvider.reloadUsage({ force: true, providerId: item.provider, signal })
    );
    return;
  }
  const accounts = await withProgress('Reading account quota', ({ signal }) =>
    accountsProvider.reloadUsage({ force: true, signal })
  );
  if (accounts.length === 0) {
    vscode.window.showInformationMessage('Turntrail: no accounts yet. Add one from the Turntrail panel.');
  }
}

async function useCodexReset(item) {
  const account = await resolveAccount({ ...item, provider: 'codex' });
  if (!account) return;
  if (account.provider !== 'codex') throw new Error('Banked resets are available only for Codex accounts.');

  const reset = accountsProvider.usage.get(account.id)?.resetCredits;
  if (!reset || reset.availableCount <= 0) {
    vscode.window.showInformationMessage(`Turntrail: "${account.label}" has no banked resets available.`);
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Use one banked reset for "${account.label}"?`,
    {
      modal: true,
      detail:
        `This immediately resets the eligible Codex usage windows and consumes one of the account's ` +
        `${reset.availableCount} banked reset${reset.availableCount === 1 ? '' : 's'}. This cannot be undone.`
    },
    'Use reset'
  );
  if (choice !== 'Use reset') return;

  const { consumeCodexResetCredit } = await core();
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Using banked reset for ${account.label}`,
      cancellable: false
    },
    () => consumeCodexResetCredit(account.id)
  );

  const usage = await accountsProvider.reloadUsageOne(account.id, 'codex', { force: true });
  if (result.code === 'reset') {
    const windows = result.windowsReset === undefined
      ? 'Eligible usage windows were reset.'
      : `${result.windowsReset} usage window${result.windowsReset === 1 ? ' was' : 's were'} reset.`;
    const refresh = usage?.error ? ` The refreshed usage could not be read: ${usage.error}` : '';
    vscode.window.showInformationMessage(`Turntrail: banked reset applied. ${windows}${refresh}`);
  } else if (result.code === 'nothing_to_reset') {
    vscode.window.showInformationMessage('Turntrail: no current Codex usage window was eligible for a reset.');
  } else if (result.code === 'no_credit') {
    vscode.window.showInformationMessage('Turntrail: this account no longer has a banked reset available.');
  } else {
    vscode.window.showInformationMessage('Turntrail: this reset request had already completed successfully.');
  }
}

// Invoked from a panel card we already know the account for, or from the
// palette and status bar where we have to ask. The picker spans both agents
// and labels which is which, and shows remaining quota so the choice can be
// made without opening the panel first.
async function resolveAccount(item, options = {}) {
  if (item?.account) return item.account;

  const accounts = await accountsProvider.accounts(item?.provider);
  // Buttons in the panel identify their account directly; the palette and the
  // status bar arrive with nothing and have to ask.
  if (item?.accountId) {
    const known = accounts.find((account) => account.id === item.accountId);
    if (known) return known;
  }

  if (accounts.length === 0) {
    throw new Error('No accounts yet. Add one from the Turntrail panel first.');
  }

  // "Active" is per agent: switching Codex says nothing about Claude, so each
  // agent contributes its own account to exclude.
  const activeIds = new Set();
  for (const provider of ['codex', 'claude']) {
    if (!accounts.some((account) => account.provider === provider)) continue;
    const activeId = await accountsProvider.reloadActive(provider);
    if (activeId) activeIds.add(activeId);
  }

  const pool = options.excludeActive ? accounts.filter((account) => !activeIds.has(account.id)) : accounts;
  if (pool.length === 0) {
    vscode.window.showInformationMessage('Turntrail: every account is already in use by its agent.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    pool.map((account) => {
      const usage = accountsProvider.usage.get(account.id);
      const remaining = usage?.windows?.length
        ? Math.min(...usage.windows.map((window) => window.remainingPercent))
        : undefined;
      return {
        label: `${activeIds.has(account.id) ? '$(check) ' : ''}${account.label}`,
        description: [
          agentName(account.provider),
          remaining === undefined ? undefined : `${formatPercent(remaining)} left`,
          account.email
        ]
          .filter(Boolean)
          .join(' · '),
        account
      };
    }),
    { placeHolder: options.excludeActive ? 'Switch to which account?' : 'Choose an account' }
  );
  return picked?.account;
}

function numberSetting(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

// Arguments must be forwarded: commands invoked from the panel carry the
// subscription they act on. Dropping them made every button fall through to the
// "choose a subscription" picker, which is exactly what the panel exists to
// avoid.
function command(name, handler) {
  return vscode.commands.registerCommand(name, async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'Canceled') return;
      vscode.window.showErrorMessage(`Turntrail: ${error.message}`);
    }
  });
}

function compatibleCommands(name, handler) {
  return [command(`turntrail.${name}`, handler), command(`contextBridge.${name}`, handler)];
}

async function core() {
  return import('@turntrail/core');
}

function createAccountMaintenance(context) {
  return new AccountMaintenanceScheduler({
    readConfig: accountMaintenanceConfig,
    readLastRun: () => context.globalState.get('accountMaintenance.lastRunAt'),
    writeLastRun: (value) => context.globalState.update('accountMaintenance.lastRunAt', value),
    run: async ({ signal }) => {
      const api = await core();
      return api.maintainAccounts({ signal });
    },
    onComplete: async (maintenance) => {
      const counts = maintenance.results.reduce((all, item) => {
        all[item.status] = (all[item.status] || 0) + 1;
        return all;
      }, {});
      const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ') || 'no accounts';
      accountMaintenanceOutput.appendLine(`[${maintenance.completedAt}] Account maintenance: ${summary}.`);
      await accountsProvider.reloadUsage({ offline: true });
    },
    onError: (error) => {
      accountMaintenanceOutput.appendLine(`[${new Date().toISOString()}] Account maintenance failed: ${error.message}`);
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer)
  });
}

function accountMaintenanceConfig() {
  const enabled = Boolean(userOnlySetting('accountMaintenance.enabled'));
  const hours = numberSetting(userOnlySetting('accountMaintenance.intervalHours'));
  return {
    enabled,
    intervalMs: Math.max(1, Math.min(24, hours || 5)) * 60 * 60 * 1000
  };
}

async function toggleAccountMaintenance() {
  const configuration = vscode.workspace.getConfiguration('turntrail');
  const enabled = !accountMaintenanceConfig().enabled;
  await configuration.update('accountMaintenance.enabled', enabled, vscode.ConfigurationTarget.Global);
  accountMaintenance.reschedule();
  const message = enabled
    ? 'Background account maintenance is enabled. Turntrail will contact provider token and usage endpoints about every five hours.'
    : 'Background account maintenance is disabled.';
  vscode.window.showInformationMessage(`Turntrail: ${message}`);
}

async function runAccountMaintenance() {
  if (!accountMaintenanceConfig().enabled) {
    const choice = await vscode.window.showInformationMessage(
      'Background account maintenance is disabled.',
      {
        modal: true,
        detail:
          'Enabling it lets Turntrail periodically renew due inactive OAuth credentials and verify account usage ' +
          'while an editor is open. It makes requests only to the providers and cannot prevent provider-side revocation.'
      },
      'Enable & Run'
    );
    if (choice !== 'Enable & Run') return;
    await vscode.workspace
      .getConfiguration('turntrail')
      .update('accountMaintenance.enabled', true, vscode.ConfigurationTarget.Global);
    accountMaintenance.reschedule();
  }

  const maintenance = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Maintaining Turntrail accounts',
      cancellable: false
    },
    () => accountMaintenance.runNow()
  );
  if (!maintenance) {
    vscode.window.showInformationMessage('Turntrail: account maintenance is already running.');
    return;
  }
  const summary = maintenanceSummary(maintenance);
  vscode.window.showInformationMessage(`Turntrail: account maintenance completed - ${summary}.`);
}

function maintenanceSummary(maintenance) {
  if (maintenance.locked) return 'another editor is handling it';
  const counts = maintenance.results.reduce((all, item) => {
    all[item.status] = (all[item.status] || 0) + 1;
    return all;
  }, {});
  return Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ') || 'no accounts';
}

async function offerAccountMaintenance(context) {
  const promptKey = 'accountMaintenance.optInPrompted';
  const accounts = await accountsProvider.accounts();
  const previouslyPrompted = context.globalState.get(promptKey) === true ||
    context.globalState.get('accountMaintenance.claudeOptInPrompted') === true;
  if (!shouldOfferAccountMaintenance({
    enabled: accountMaintenanceConfig().enabled,
    prompted: previouslyPrompted,
    accounts: accounts.length
  })) return;

  await context.globalState.update(promptKey, true);
  const choice = await vscode.window.showInformationMessage(
    'Turntrail can periodically renew inactive Codex and Claude OAuth credentials while their clients are stopped.',
    'Enable maintenance',
    'Not now'
  );
  if (choice !== 'Enable maintenance') return;

  await vscode.workspace
    .getConfiguration('turntrail')
    .update('accountMaintenance.enabled', true, vscode.ConfigurationTarget.Global);
  accountMaintenance.reschedule();
  const maintenance = await accountMaintenance.runNow();
  const message = maintenance
    ? `Account maintenance is enabled and the first check completed - ${maintenanceSummary(maintenance)}.`
    : 'Account maintenance is enabled. The first check will retry automatically.';
  vscode.window.showInformationMessage(`Turntrail: ${message}`);
}

function queueAccountMaintenanceOffer(context) {
  if (accountMaintenanceOffer) return;
  accountMaintenanceOffer = offerAccountMaintenance(context)
    .catch((error) => {
      accountMaintenanceOutput.appendLine(`[${new Date().toISOString()}] Could not offer account maintenance: ${error.message}`);
    })
    .finally(() => {
      accountMaintenanceOffer = undefined;
    });
}

async function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) throw new Error('Open a workspace folder first.');
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose workspace for Turntrail' });
  if (!picked) throw new Error('No workspace selected.');
  return picked.uri.fsPath;
}

// Pick the native session to use as a source. A native session records the
// folder it was started in; agents (e.g. Codex in a VS Code fork) often run
// from a sibling folder of the open workspace, so a strict cwd match can find
// nothing even when a chat is clearly open. Prefer a workspace-matched session;
// if there is none, say so explicitly and offer the most recent session from
// another folder, showing its cwd so the choice is informed.
async function resolveSourceSession(provider, root) {
  const { discoverNativeSessions } = await core();
  const sessions = await withProgress(`Discovering ${provider} sessions`, ({ signal }) =>
    discoverNativeSessions(provider, { root, all: true, includeArchived: true, signal })
  );
  if (sessions.length === 0) return { status: 'none' };

  const origin = await ledgerOriginChat(root, provider === 'codex' ? 'codex' : 'claude');
  const matched = orderByOrigin(sessions.filter((session) => session.matchesProject), origin);

  if (matched.length === 1) return { status: 'matched', session: matched[0] };

  // Several sessions in one folder is normal - a long-running chat, a quick
  // one-off, an experiment - and they are not interchangeable. Taking the most
  // recently touched one silently hands off whichever chat happened to be
  // focused last, which is often not the one worth continuing.
  if (matched.length > 1) {
    if (setting('alwaysUseLatestSession')) {
      return { status: 'matched', session: matched[0] };
    }
    const picked = await vscode.window.showQuickPick(pickableSessions(matched, origin), {
      placeHolder: `Which ${provider} session? ${matched.length} were started in this workspace`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return { status: 'cancelled' };
    return { status: 'matched', session: picked.session };
  }

  const recent = sessions[0];
  const choice = await vscode.window.showWarningMessage(
    `Turntrail: no ${provider} session was started in this workspace.`,
    {
      modal: true,
      detail:
        `Workspace:\n${root}\n\n` +
        `Use the most recent ${provider} session instead? It was started in:\n` +
        `${formatSessionFolder(recent.cwd)}\n\nLast active: ${recent.modifiedAt}`
    },
    'Use Most Recent',
    'Choose Another Session'
  );
  if (choice === 'Use Most Recent') return { status: 'fallback', session: recent };
  if (choice === 'Choose Another Session') {
    const picked = await vscode.window.showQuickPick(pickableSessions(sessions, origin), {
      placeHolder: `All ${provider} sessions on this machine`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (picked) return { status: 'fallback', session: picked.session };
  }
  return { status: 'cancelled' };
}

// One rendering of a session for every picker, so the same facts identify a
// session wherever it is chosen.
//
// Both agents name most of the sessions you started yourself, and that name
// leads when it exists: Claude Code writes an `aiTitle` into the transcript,
// Codex keeps its thread name in a separate index. What is left unnamed is
// mostly machinery - forks, subagent runs - and there the opening request is a
// poor stand-in, because sessions forked from a common parent share it word for
// word and render as a wall of identical rows. For those the most recent
// substantive request leads instead, since that is where they diverge.
// Which chat the ledger in this workspace was last built from, for one agent.
// Undefined before the first handoff, and whenever the core cannot be loaded.
async function ledgerOriginChat(root, target) {
  try {
    const { readManifest, originChat } = await core();
    return originChat(await readManifest(root), target);
  } catch {
    return undefined;
  }
}

// A session already in the ledger is almost always the one meant: it is the
// chat this workspace's handoffs have been built from. It leads the list and
// says so, rather than being left to be found among the others.
function orderByOrigin(sessions, origin) {
  if (!origin?.sessionId) return sessions;
  const index = sessions.findIndex((session) => session.sessionId === origin.sessionId);
  if (index <= 0) return sessions;
  return [sessions[index], ...sessions.slice(0, index), ...sessions.slice(index + 1)];
}

function pickableSessions(sessions, origin) {
  return sessions.map((session) => {
    const opening = session.title;
    const latest = session.latest;
    const label = session.named && opening ? opening : latest || opening || session.sessionId;

    const context = [];
    if (origin?.sessionId && session.sessionId === origin.sessionId) {
      context.push('already in this workspace ledger');
    }
    if (session.named && latest) context.push(`latest: ${latest}`);
    else if (session.named && session.opening) context.push(`started: ${session.opening}`);
    else if (latest && opening && label !== opening) context.push(`started: ${opening}`);
    if (!session.matchesProject) context.push(formatSessionFolder(session.cwd));

    return {
      label,
      description: [
        relativeTime(session.modifiedAt),
        session.surface,
        session.forkedFrom ? 'forked' : undefined,
        formatSize(session.size),
        session.matchesProject ? undefined : 'other folder'
      ]
        .filter(Boolean)
        .join(' · '),
      detail: context.join('  ·  ') || session.path,
      session
    };
  });
}

function relativeTime(iso) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function discover(provider) {
  const root = await workspaceRoot();
  const { discoverNativeSessions } = await core();
  const sessions = await withProgress(`Discovering ${provider} sessions`, ({ signal }) =>
    discoverNativeSessions(provider, { root, all: true, includeArchived: true, signal })
  );

  if (sessions.length === 0) {
    vscode.window.showInformationMessage(`Turntrail: no ${provider} sessions found on this machine.`);
    return;
  }

  const matched = sessions.filter((session) => session.matchesProject);
  let pool = matched;
  if (matched.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      `Turntrail: no ${provider} session was started in this workspace. Browse ${sessions.length} importable session(s) from other folders? This will not create a handoff.`,
      'Browse All Sessions'
    );
    if (choice !== 'Browse All Sessions') return;
    pool = sessions;
  }

  const selected = await vscode.window.showQuickPick(
    pickableSessions(pool),
    {
      placeHolder:
        matched.length === 0
          ? `All ${provider} sessions (${sessions.length}) - none started in this workspace`
          : `${matched.length} ${provider} session(s) for this workspace`
    }
  );

  if (selected) {
    const action = await vscode.window.showInformationMessage(
      `Import ${provider} session ${selected.session.sessionId}?`,
      'Import',
      'Cancel'
    );
    if (action === 'Import') await importSession(provider, selected.session);
  }
}

async function importLatest(provider) {
  const root = await workspaceRoot();
  const { initStore, importNativeSession } = await core();
  const resolved = await resolveSourceSession(provider, root);
  if (resolved.status === 'cancelled') return;
  if (resolved.status === 'none') {
    vscode.window.showWarningMessage(`Turntrail: no ${provider} sessions were found anywhere on this machine.`);
    return;
  }
  const result = await withProgress(`Importing ${provider} session`, async ({ signal }) => {
    await initStore(root);
    return importNativeSession(root, provider, { path: resolved.session.path, includeArchived: true, signal });
  });
  await reportImport(provider, result);
}

async function importSession(provider, session) {
  const root = await workspaceRoot();
  const { initStore, importNativeSession } = await core();
  const result = await withProgress(`Importing ${provider} session`, async ({ signal }) => {
    await initStore(root);
    return importNativeSession(root, provider, { path: session.path, includeArchived: true, signal });
  });
  await reportImport(provider, result);
}

async function refreshSessions(item = {}) {
  return withProgress('Discovering sessions', ({ signal }) =>
    sessionsProvider.refresh({ all: item.all, signal })
  );
}

function indexedSession(item) {
  const row = sessionsProvider.resolve(item?.rowId);
  if (!row) throw new Error('That session is no longer in the dashboard. Refresh Sessions and try again.');
  return row;
}

async function importIndexedSession(item) {
  const row = indexedSession(item);
  if (row.kind !== 'native') {
    vscode.window.showInformationMessage('Turntrail: this session is already stored in the workspace ledger.');
    return row;
  }
  const root = await workspaceRoot();
  const { initStore, importNativeSession } = await core();
  const result = await withProgress(`Importing ${row.provider} session`, async ({ signal }) => {
    await initStore(root);
    return importNativeSession(root, row.provider, { path: row.path, includeArchived: true, signal });
  });
  sessionsProvider.markImported(row.id, result);
  vscode.window.showInformationMessage(`Turntrail: imported ${result.turnCount} turns from ${row.provider}.`);
  return { row, result };
}

async function viewIndexedSession(item) {
  let row = indexedSession(item);
  let ledgerSessionId = row.ledgerSessionId;
  if (!ledgerSessionId) {
    const imported = await importIndexedSession(item);
    if (!imported?.result) return;
    ledgerSessionId = imported.result.id;
    row = imported.row;
  }

  const root = await workspaceRoot();
  const { readSessionPreview, renderSessionPreview } = await core();
  const markdown = await withProgress(`Reading ${row.provider} transcript`, async ({ signal }) => {
    const preview = await readSessionPreview(root, ledgerSessionId, { signal });
    return renderSessionPreview(preview);
  });
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function handoffIndexedSession(item) {
  const row = indexedSession(item);
  const target = item?.target === 'codex' ? 'codex' : 'claude';
  const mode = item?.mode === 'existing' ? 'existing' : 'new';
  const delivery = item?.delivery === 'managed' ? 'managed' : 'clipboard';
  return handoff(target, mode, row, delivery);
}

async function openManagedSession(item = {}) {
  const row = item?.rowId ? indexedSession(item) : undefined;
  let provider = row?.provider || item?.provider;
  if (provider !== 'claude' && provider !== 'codex') {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Claude', provider: 'claude' },
        { label: 'Codex', provider: 'codex' }
      ],
      { placeHolder: 'Open which managed CLI?' }
    );
    provider = picked?.provider;
  }
  if (!provider) return;
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error('Managed terminals support only Claude and Codex.');
  }

  const root = await workspaceRoot();
  const existing = row?.sessionId
    ? managedTerminals.list(provider, root).find((record) => record.sessionId === row.sessionId)
    : undefined;
  if (existing) {
    managedTerminals.focus(existing.id);
    vscode.window.setStatusBarMessage(`Turntrail: focused the existing managed ${agentName(provider)} session.`, 3000);
    return existing;
  }
  const account = row?.sessionId ? undefined : await recommendedManagedAccount(provider);
  return managedTerminals.launch({
    provider,
    root,
    sessionId: row?.sessionId,
    title: row?.title || 'New session',
    ...account
  });
}

async function recommendedManagedAccount(provider) {
  const registered = await accountsProvider.accounts(provider);
  if (registered.length === 0) return undefined;

  const recommendation = await withProgress(
    `Selecting a ${agentName(provider)} account`,
    ({ signal }) => accountsProvider.recommendation(provider, { refresh: true, signal })
  );
  if (!recommendation) {
    throw new Error(
      `No usable ${agentName(provider)} account is available. Refresh its usage or repair its sign-in in the Accounts view.`
    );
  }

  const account = registered.find((candidate) => candidate.id === recommendation.id);
  if (!account) throw new Error('The recommended account is no longer registered. Refresh the Accounts view and retry.');
  const api = await core();
  if (provider === 'claude') await api.ensureClaudeHome(account.id);
  else await api.ensureCodexHome(account.id);
  return {
    accountId: account.id,
    accountLabel: account.label,
    accountEnv: provider === 'claude' ? api.claudeEnv(account.id) : api.codexEnv(account.id)
  };
}

function focusManagedSession(item = {}) {
  return managedTerminals.focus(item.managedId);
}

function closeManagedSession(item = {}) {
  return managedTerminals.close(item.managedId);
}

// Import only ingests into the ledger (it opens nothing), so confirm it
// modally — a transient toast was easy to miss and felt like "nothing happened".
async function reportImport(provider, result) {
  await vscode.window.showInformationMessage(
    `Turntrail: imported ${result.turnCount} turns from ${provider} into the ledger. This only updated local Turntrail data; no handoff was created. Run "Turntrail: Handoff to Claude/Codex" separately when you want one.`,
    { modal: true },
    'OK'
  );
}

function formatSessionFolder(cwd) {
  if (!cwd) return '(unknown folder)';
  return fs.existsSync(cwd) ? cwd : `${cwd} (folder not found; it may have been renamed or moved)`;
}

async function handoff(target, mode, selected, delivery = 'clipboard') {
  const root = await workspaceRoot();
  const source = selected?.provider || (target === 'claude' ? 'codex' : 'claude');
  // 0 is a meaningful value here ("no clipping"), so it must reach the core
  // instead of collapsing to undefined and picking up the default budget.
  const maxChars = numberSetting(setting('maxExportChars'));
  const dedupe = setting('dedupeTurns') !== false;
  const sinceLastExport = Boolean(setting('sinceLastExport'));
  const toolMaxChars = numberSetting(setting('toolMaxChars'));
  const systemMaxChars = numberSetting(setting('systemMaxChars'));
  const snapshotDiffMaxChars = numberSetting(setting('snapshotDiffMaxChars'));
  const keepExports = numberSetting(setting('keepExports'));
  const openDocument = Boolean(setting('openHandoffDocument'));
  const { initStore, importNativeSession, captureSnapshot, exportHandoff } = await core();

  const resolved = selected
    ? { status: selected.kind === 'native' ? 'matched' : 'ledger', session: selected.native }
    : await resolveSourceSession(source, root);
  if (resolved.status === 'cancelled') return;
  if (resolved.status === 'none') {
    const choice = await vscode.window.showWarningMessage(
      `Turntrail: no ${source} sessions were found anywhere on this machine. Create a handoff from the existing ledger only?`,
      'Continue Without Import',
      'Cancel'
    );
    if (choice !== 'Continue Without Import') return;
  }

  const result = await withProgress(`Creating handoff to ${target}`, async ({ signal }) => {
    await initStore(root);
    if (resolved.session) {
      const imported = await importNativeSession(root, source, { path: resolved.session.path, includeArchived: true, signal });
      if (selected?.id) sessionsProvider.markImported(selected.id, imported);
    }
    await captureSnapshot(root, { signal });
    return exportHandoff(root, {
      target,
      maxChars,
      dedupe,
      sinceLastExport,
      toolMaxChars,
      systemMaxChars,
      snapshotDiffMaxChars,
      keepExports,
      signal
    });
  });

  // Which chat on the receiving side this ledger already belongs to. Naming it
  // is what makes a return trip land in the original conversation instead of a
  // fresh one that has to be re-explained.
  const destination = mode === 'existing' ? await ledgerOriginChat(root, target) : undefined;
  const prompt = handoffPrompt(target, mode, result.path, destination);
  await vscode.env.clipboard.writeText(prompt);
  await rememberLatest(root, target, result.path, prompt, destination);
  await publishHandoffState(root);

  if (openDocument) await openDocumentAt(result.path);
  let delivered;
  if (delivery === 'managed') {
    try {
      delivered = await deliverManagedHandoff({ target, mode, prompt, destination, root });
    } catch (error) {
      vscode.window.showWarningMessage(
        `Turntrail: the managed CLI could not receive this handoff — ${error.message} The prompt remains on your clipboard.`
      );
    }
  } else if (mode === 'new') {
    await openTarget(target);
  }

  const targetLabel = target === 'claude' ? 'Claude' : target === 'codex' ? 'Codex' : target;
  const wordCount = countWords(prompt);
  const into = chatLabel(destination) ? ` chat "${chatLabel(destination)}"` : '';
  const outcome = delivered
    ? `sent directly to managed ${targetLabel}${delivered.reused ? into : ''}`
    : `copied to clipboard — paste it into ${targetLabel}${into} to continue`;
  vscode.window.showInformationMessage(
    `Turntrail: ${wordCount}-word handoff prompt ${outcome}.`,
    'Copy Prompt Again',
    'Open Handoff'
  ).then((choice) => {
    if (choice === 'Open Handoff') openDocumentAt(result.path);
    else if (choice === 'Copy Prompt Again') vscode.env.clipboard.writeText(prompt);
  });
}

async function deliverManagedHandoff({ target, mode, prompt, destination, root }) {
  const active = managedTerminals.list(target, root);
  let chosen;
  if (mode === 'existing') {
    chosen = active.find((record) => destination?.sessionId && record.sessionId === destination.sessionId);
    const unspecified = !destination?.sessionId;
    if (!chosen && unspecified && active.length === 1) chosen = active[0];
    if (!chosen && unspecified && active.length > 1) {
      const picked = await vscode.window.showQuickPick(
        active.map((record) => ({
          label: record.title,
          description: `${agentName(record.provider)} · managed terminal`,
          detail: record.sessionId || 'New session',
          record
        })),
        { placeHolder: `Which managed ${agentName(target)} session should receive this handoff?` }
      );
      chosen = picked?.record;
      if (!chosen) return undefined;
    }
  }

  if (chosen) {
    const confirmation = await vscode.window.showWarningMessage(
      `Inject this handoff into the running managed ${agentName(target)} terminal?`,
      {
        modal: true,
        detail:
          'Turntrail cannot inspect the agent TUI state. Continue only when that terminal is ready for a new prompt, not while it is showing a permission or selection dialog.'
      },
      'Inject Handoff'
    );
    if (confirmation !== 'Inject Handoff') return undefined;
    managedTerminals.inject(chosen.id, prompt);
    return { record: chosen, reused: true };
  }

  let sessionId = mode === 'existing' ? destination?.sessionId : undefined;
  let title = chatLabel(destination) || 'Handoff';
  if (mode === 'existing' && !sessionId) {
    const resolved = await resolveSourceSession(target, root);
    if (resolved.status === 'cancelled') return undefined;
    if (resolved.status === 'none') {
      throw new Error(`no existing ${agentName(target)} session was found`);
    }
    sessionId = resolved.session.sessionId;
    title = resolved.session.title || resolved.session.latest || title;
  }

  const account = sessionId ? undefined : await recommendedManagedAccount(target);
  const record = await managedTerminals.launch({
    target,
    provider: target,
    root,
    sessionId,
    title,
    prompt,
    ...account
  });
  return { record, reused: false };
}

function countWords(text) {
  const matches = String(text || '').trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

async function openLatestHandoff() {
  const latest = await latestState(await workspaceRoot());
  if (!latest?.handoffPath) throw new Error('No latest handoff recorded in this VS Code window.');
  await openDocumentAt(latest.handoffPath);
}

async function copyLatestHandoffPrompt() {
  const latest = await latestState(await workspaceRoot());
  if (!latest?.prompt) throw new Error('No latest handoff prompt recorded in this VS Code window.');
  await vscode.env.clipboard.writeText(latest.prompt);
  vscode.window.showInformationMessage(
    `Turntrail: ${countWords(latest.prompt)}-word handoff prompt copied to clipboard.`
  );
}

async function openTarget(target) {
  const command = await findAgentCommand(target);
  if (command) {
    await vscode.commands.executeCommand(command);
    return;
  }

  if (target === 'claude') {
    if (userOnlySetting('allowExternalClaudeUri')) {
      const editorScheme = vscode.env.uriScheme || 'vscode';
      const configuredUri = userOnlySetting('claudeUri', false) || `${editorScheme}://anthropic.claude-code/open`;
      const uri = safeClaudeUri(configuredUri, editorScheme);
      if (!uri) {
        throw new Error(`Turntrail blocked an unsafe Claude URI setting. Use ${editorScheme}://anthropic.claude-code/open.`);
      }
      await vscode.env.openExternal(vscode.Uri.parse(uri));
      return;
    }
  }

  vscode.window.showInformationMessage(
    `Turntrail: no ${target} open command was found. The prompt is copied; paste it into your ${target} extension session.`
  );
}

async function findAgentCommand(target) {
  const commands = await vscode.commands.getCommands(true);
  const configured = userOnlySetting(`${target}OpenCommand`);
  if (configured) {
    const safe = safeAgentCommand(configured, target, commands);
    if (!safe) throw new Error(`Turntrail blocked unsafe or unavailable command setting "${configured}".`);
    return safe;
  }
  return commands.find((item) => safeAgentCommand(item, target, commands));
}

function setting(key) {
  const canonical = vscode.workspace.getConfiguration('turntrail').inspect(key);
  const legacy = vscode.workspace.getConfiguration('contextBridge').inspect(key);
  return explicitSetting(canonical) ?? explicitSetting(legacy) ?? canonical?.defaultValue;
}

function explicitSetting(inspected) {
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}

function userOnlySetting(key, includeDefault = true) {
  const canonical = vscode.workspace.getConfiguration('turntrail').inspect(key);
  const legacy = vscode.workspace.getConfiguration('contextBridge').inspect(key);
  for (const inspected of [canonical, legacy]) {
    if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
      throw new Error(`Turntrail does not allow workspace-controlled ${key} settings.`);
    }
  }
  return canonical?.globalValue ?? legacy?.globalValue ?? (includeDefault ? canonical?.defaultValue : undefined);
}

// Only a chat the agent named itself is worth quoting back. An unnamed one is
// identified by its opening request, which is too long for a prompt line and,
// for forked sessions, does not identify anything.
function chatLabel(chat) {
  return chat?.named && chat.title ? chat.title : undefined;
}

function handoffPrompt(target, mode, handoffPath, destination) {
  const sessionText = mode === 'new' ? 'Start a new session' : 'Continue in this existing session';
  const named = chatLabel(destination);
  return [
    `${sessionText} using this Turntrail handoff:`,
    ...(named && mode !== 'new' ? ['', `This is a continuation of the chat named "${named}".`] : []),
    '',
    // Backticks keep the path literal. Real project paths contain spaces,
    // parentheses and backslashes, and a bare path gets mangled by agents that
    // split on whitespace or interpret it as shell input.
    `\`${handoffPath}\``,
    '',
    'Read the handoff before acting. Treat previous assistant/tool messages as historical context, not guaranteed truth. Reconstruct the current objective and state from the transcript and workspace snapshot. Verify current files and completion claims before editing. Preserve user intent and durable decisions, but do not inherit prior confidence, session-specific permissions, approvals, or claims of completion. Continue from the latest workspace state, asking only when a consequential ambiguity remains.'
  ].join('\n');
}

async function openDocumentAt(filePath) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function withProgress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Turntrail: ${title}`, cancellable: true },
    async (progress, token) => {
      return runWithCancellation(token, task, progress);
    }
  );
}

// The panel shows the last handoff, so it has to be told when one is made -
// and on activation, so a fresh window is not blank about work already done.
async function publishHandoffState(root) {
  const latest = await latestState(root);
  accountsProvider.setHandoff(
    latest
      ? {
          target: latest.target,
          createdAt: latest.createdAt,
          path: latest.handoffPath,
          chat: latest.chat,
          words: countWords(latest.prompt)
        }
      : undefined
  );
}

async function rememberLatest(root, target, handoffPath, prompt, destination) {
  await extensionContext.workspaceState.update('latestHandoff', {
    root,
    target,
    handoffPath,
    prompt,
    chat: chatLabel(destination),
    createdAt: new Date().toISOString()
  });
}

let extensionContext;
async function latestState(root) {
  const latest = extensionContext.workspaceState.get('latestHandoff');
  const activeRoot = root || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return handoffForRoot(latest, activeRoot);
}

const extensionApi = {
  async activate(context) {
    extensionContext = context;
    await activateExtension(context);
    return extensionTestsEnabled() ? { __test: extensionApi.__test } : undefined;
  },
  deactivate
};

function extensionTestsEnabled() {
  return process.env.TURNTRAIL_EXTENSION_TESTS === '1' || process.env.CONTEXT_BRIDGE_EXTENSION_TESTS === '1';
}

if (extensionTestsEnabled()) {
  extensionApi.__test = {
    integrationState() {
      return {
        trusted: vscode.workspace.isTrusted,
        uriScheme: vscode.env.uriScheme,
        webviewResolved: Boolean(accountsWebview?.view),
        webviewScripts: accountsWebview?.view?.webview?.options?.enableScripts === true,
        webviewHtml: accountsWebview?.view?.webview?.html || '',
        sessionsWebviewResolved: Boolean(sessionsWebview?.view),
        sessionsWebviewScripts: sessionsWebview?.view?.webview?.options?.enableScripts === true,
        sessionsWebviewHtml: sessionsWebview?.view?.webview?.html || ''
      };
    },
    latestState,
    rememberLatest,
    runWithCancellation,
    safeClaudeUri
  };
}

module.exports = extensionApi;
