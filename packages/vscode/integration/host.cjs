const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'turntrail.context-bridge-vscode';

async function run() {
  const scenario = process.env.TURNTRAIL_TEST_SCENARIO || process.env.CONTEXT_BRIDGE_TEST_SCENARIO;
  if (scenario === 'untrusted') return untrustedWorkspace();

  assert.equal(vscode.workspace.isTrusted, true, `${scenario} must run as a trusted workspace`);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the development host`);
  await extension.activate();
  assert.equal(extension.isActive, true);
  const hooks = extension.exports.__test;
  assert.ok(hooks, 'integration test hooks must be enabled only in the test process');

  if (scenario === 'smoke-and-seed') return smokeAndSeed(hooks);
  if (scenario === 'other-workspace') return otherWorkspace(hooks);
  throw new Error(`Unknown extension-host scenario: ${scenario}`);
}

async function smokeAndSeed(hooks) {
  const root = workspaceRoot();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'turntrail.discoverClaude',
    'turntrail.discoverCodex',
    'turntrail.discoverGemini',
    'turntrail.discoverCursor',
    'turntrail.refreshSessions',
    'turntrail.importIndexedSession',
    'turntrail.viewIndexedSession',
    'turntrail.handoffIndexedSession',
    'turntrail.openManagedSession',
    'turntrail.focusManagedSession',
    'turntrail.closeManagedSession',
    'turntrail.copyLatestHandoffPrompt',
    'turntrail.openLatestHandoff',
    'turntrail.createHandoff'
  ]) {
    assert.equal(commands.includes(command), true, `${command} must be registered`);
  }

  await vscode.commands.executeCommand('workbench.view.extension.turntrail');
  await vscode.commands.executeCommand('turntrailAccounts.focus');
  await waitFor(() => hooks.integrationState().webviewResolved);
  const state = hooks.integrationState();
  assert.equal(state.webviewScripts, true);
  assert.match(state.webviewHtml, /default-src 'none'/);
  assert.match(state.webviewHtml, /<div id="root">/);
  assert.match(state.webviewHtml, /acquireVsCodeApi\(\)/);

  await vscode.commands.executeCommand('turntrailSessions.focus');
  await waitFor(() => hooks.integrationState().sessionsWebviewResolved);
  const sessionsState = hooks.integrationState();
  assert.equal(sessionsState.sessionsWebviewScripts, true);
  assert.match(sessionsState.sessionsWebviewHtml, /default-src 'none'/);
  assert.match(sessionsState.sessionsWebviewHtml, /Search sessions/);
  assert.match(sessionsState.sessionsWebviewHtml, /All providers/);
  assert.match(sessionsState.sessionsWebviewHtml, /Managed CLI/);
  assert.match(sessionsState.sessionsWebviewHtml, /Clipboard/);

  await vscode.commands.executeCommand('turntrail.openManagedSession', { provider: 'codex' });
  await waitFor(() => vscode.window.terminals.some((terminal) =>
    terminal.creationOptions?.env?.TURNTRAIL_MANAGED_TERMINAL === '1'
  ));
  const managed = vscode.window.terminals.find((terminal) =>
    terminal.creationOptions?.env?.TURNTRAIL_MANAGED_TERMINAL === '1'
  );
  assert.equal(managed.creationOptions.env.TURNTRAIL_MANAGED_PROVIDER, 'codex');
  assert.equal(managed.creationOptions.cwd, root);
  assert.equal(typeof managed.creationOptions.shellPath, 'string');
  assert.equal(managed.creationOptions.shellPath.length > 0, true);
  await vscode.commands.executeCommand('turntrail.closeManagedSession', {
    managedId: managed.creationOptions.env.TURNTRAIL_MANAGED_ID
  });
  await waitFor(() => !vscode.window.terminals.includes(managed));

  const handoffPath = path.join(root, 'handoff.md');
  const prompt = 'Turntrail extension-host prompt';
  await fs.writeFile(handoffPath, '# Integration handoff\n', 'utf8');
  await hooks.rememberLatest(root, 'claude', handoffPath, prompt);
  assert.equal((await hooks.latestState(root))?.prompt, prompt);
  assert.equal(await hooks.latestState(path.join(path.dirname(root), 'workspace-b')), undefined);
  await vscode.commands.executeCommand('turntrail.copyLatestHandoffPrompt');
  assert.equal(await vscode.env.clipboard.readText(), prompt);
  await vscode.commands.executeCommand('turntrail.openLatestHandoff');
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, handoffPath);

  const source = new vscode.CancellationTokenSource();
  const cancelled = hooks.runWithCancellation(source.token, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), {
      once: true
    });
  }));
  source.cancel();
  await assert.rejects(cancelled, { name: 'AbortError' });
  source.dispose();

  for (const scheme of ['vscode', 'cursor', 'windsurf', 'antigravity']) {
    const expected = `${scheme}://anthropic.claude-code/open`;
    assert.equal(hooks.safeClaudeUri(expected, scheme), expected);
    assert.equal(hooks.safeClaudeUri(expected, `${scheme}-other`), undefined);
  }
}

async function otherWorkspace(hooks) {
  assert.equal(await hooks.latestState(workspaceRoot()), undefined, 'another window must not inherit the handoff');
}

async function untrustedWorkspace() {
  assert.equal(vscode.workspace.isTrusted, false, 'the restricted-mode fixture must remain untrusted');
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  assert.equal(extension.packageJSON.capabilities?.untrustedWorkspaces?.supported, false);
  assert.equal(extension.isActive, false, 'Turntrail must not activate in an untrusted workspace');
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  assert.equal(folders.length, 1);
  return folders[0].uri.fsPath;
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the Turntrail webview');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = { run };
