const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const { allowedLoginUrl, appendBoundedOutput } = require('./security.cjs');

// Sign-in, without handing the user a terminal.
//
// The two agents get there very differently, and the difference is forced:
//
// Codex - the official `codex` binary performs the whole OAuth exchange and
// writes the credential. Turntrail only runs it as a child process with
// CODEX_HOME pointed at the right directory, reads its plain-text output, and
// presents the result. We never see the authorization code and never hold a
// token.
//
// Claude - none of that is possible. `claude` and `claude setup-token` render
// an Ink terminal UI that requires raw mode on stdin, so a piped child process
// dies before printing anything, and `setup-token` writes no credential even
// when it succeeds. So Turntrail runs the same public PKCE flow the CLI
// runs and writes the credential itself. That is a real difference in what this
// extension handles, and it is why the Claude paths live in core with their own
// tests rather than being a thin wrapper over a process.

const TITLES = { codex: 'Connect a Codex subscription', claude: 'Connect a Claude account' };
const MAX_LOGIN_OUTPUT_CHARS = 64 * 1024;

class LoginPanel {
  constructor(context, core, store) {
    this.context = context;
    this.core = core;
    this.store = store;
    this.panel = undefined;
    this.child = undefined;
    this.target = undefined;
    this.provider = undefined;
    this.pending = undefined;
    this.loopback = undefined;
    this.operation = undefined;
    this.operationController = undefined;
    this.provisionalAccountId = undefined;
  }

  async open(target = {}) {
    const provider = target.provider || 'codex';
    const changingTarget = this.target &&
      (this.target.accountId !== target.accountId || this.provider !== provider);
    if (changingTarget) await this.cancel();
    this.target = target;

    if (this.panel && this.provider !== provider) {
      // Switching agent changes every card on the page, so the document is
      // rebuilt rather than patched.
      this.panel.webview.html = html(this.panel.webview, provider);
      this.panel.title = TITLES[provider];
    }
    this.provider = provider;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'contextBridgeLogin',
        TITLES[provider],
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false }
      );
      this.panel.webview.html = html(this.panel.webview, provider);
      this.panel.webview.onDidReceiveMessage((message) => {
        void this.onMessage(message).catch((error) => {
          this.post({ type: 'failed', method: message?.method, message: error.message });
        });
      });
      this.panel.onDidChangeViewState?.((event) => {
        if (event.webviewPanel.visible) {
          this.post({ type: 'ready', label: this.target?.label || '', locked: Boolean(this.target?.accountId) });
        }
      });
      this.panel.onDidDispose(() => {
        void this.cancel();
        this.panel = undefined;
        this.provider = undefined;
      });
    }
    this.pendingLabel = target.label || '';
    this.post({ type: 'ready', label: target.label || '', locked: Boolean(target.accountId) });
  }

  post(message) {
    this.panel?.webview.postMessage(message);
  }

  async cancel() {
    this.pending = undefined;
    this.operationController?.abort();
    if (this.loopback) {
      this.loopback.close();
      this.loopback = undefined;
    }
    if (this.child) {
      const child = this.child;
      this.child = undefined;
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    await this.operation?.catch(() => {});
    await this.rollbackProvisional();
  }

  async onMessage(message) {
    if (message?.type === 'cancel') {
      await this.cancel();
      this.post({ type: 'idle' });
      return;
    }
    if (message?.type === 'openExternal' && message.url) {
      const url = allowedLoginUrl(message.url);
      if (!url) {
        this.post({
          type: 'failed',
          method: this.provider === 'claude' ? 'browser' : 'device',
          message: 'Blocked an unexpected external sign-in URL.'
        });
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (message?.type === 'copy' && message.value) {
      await vscode.env.clipboard.writeText(message.value);
      this.post({ type: 'copied' });
      return;
    }
    if (message?.type === 'pickFile') {
      try {
        await this.runOperation((signal) => this.adoptFromFile(signal));
      } catch (error) {
        this.post({ type: 'failed', method: 'paste', message: error.message });
      }
      return;
    }
    if (message?.type === 'start' || message?.type === 'submit') {
      try {
        await this.runOperation((signal) => this.start(message, signal));
      } catch (error) {
        this.post({ type: 'failed', method: message.method, message: error.message });
      }
    }
  }

  async runOperation(task) {
    if (this.operation) throw new Error('A sign-in operation is already running. Cancel it first.');
    const controller = new AbortController();
    this.operationController = controller;
    const operation = Promise.resolve().then(() => task(controller.signal));
    this.operation = operation;
    try {
      return await operation;
    } catch (error) {
      try {
        await this.rollbackProvisional();
      } catch (cleanupError) {
        throw new Error(`${error.message} Turntrail could not remove the incomplete account: ${cleanupError.message}`);
      }
      throw error;
    } finally {
      if (this.operation === operation) this.operation = undefined;
      if (this.operationController === controller) this.operationController = undefined;
    }
  }

  async rollbackProvisional() {
    const accountId = this.provisionalAccountId;
    if (!accountId) return;
    // Claim cleanup before awaiting it. Cancel and the operation's rejection
    // can arrive together; only one path may remove the provisional account.
    this.provisionalAccountId = undefined;
    const { removeAccount } = await this.core();
    try {
      await removeAccount(accountId, { purge: true, purgeLive: false });
    } catch (error) {
      if (!this.provisionalAccountId) this.provisionalAccountId = accountId;
      throw error;
    }
    this.pending = undefined;
    this.target = {
      provider: this.provider,
      label: this.target?.label || this.pendingLabel || ''
    };
  }

  commitProvisional() {
    this.provisionalAccountId = undefined;
  }

  // Reading the file here rather than in the webview means the credential is
  // never handed to the page at all - only the outcome is.
  async adoptFromFile(signal) {
    const claude = this.provider === 'claude';
    const picked = await vscode.window.showOpenDialog({
      title: claude ? 'Choose a .credentials.json' : 'Choose an auth.json',
      canSelectMany: false,
      filters: { 'Agent credential': ['json'] },
      openLabel: 'Use this login'
    });
    if (!picked?.length) return;

    const bytes = await vscode.workspace.fs.readFile(picked[0]);
    await this.adopt(Buffer.from(bytes).toString('utf8'), signal);
  }

  async adopt(text, signal) {
    const { importCodexAuthText, importClaudeAuthText, backfillClaudeProfile } = await this.core();
    const accountId = await this.ensureAccount();
    const claude = this.provider === 'claude';

    this.post({ type: 'running', method: 'paste' });
    let auth = claude ? await importClaudeAuthText(accountId, text) : await importCodexAuthText(accountId, text);
    if (!auth) {
      throw new Error('That credential has no usable login in it.');
    }
    // A pasted Claude credential carries no identity - the email lives in a
    // different file - so ask the API who it belongs to rather than showing an
    // unlabelled card.
    if (claude) auth = (await backfillClaudeProfile(accountId, { signal }).catch((error) => {
      if (error?.code === 'PROVIDER_CONTRACT_CHANGED') throw error;
      return auth;
    })) || auth;

    await this.store.reloadUsage({ force: true, signal });
    this.commitProvisional();
    this.post({ type: 'done', method: 'paste', email: auth.claims?.email || auth.email, label: this.target.label });
  }

  // A subscription row has to exist before any method can write into it.
  async ensureAccount() {
    const { createAccount, ensureCodexHome, ensureClaudeHome } = await this.core();
    const provider = this.provider || 'codex';
    const ensureHome = provider === 'claude' ? ensureClaudeHome : ensureCodexHome;

    if (this.target?.accountId) {
      await ensureHome(this.target.accountId);
      return this.target.accountId;
    }
    const label = String(this.pendingLabel || '').trim();
    if (!label) throw new Error('Give this account a name first.');
    const account = await createAccount({ label, provider });
    this.provisionalAccountId = account.id;
    this.target = { ...this.target, accountId: account.id, label, provider };
    await ensureHome(account.id);
    return account.id;
  }

  async start(message, signal) {
    if (message.method === 'paste') return this.adopt(message.secret, signal);
    this.pendingLabel = message.label;

    if (this.provider === 'claude') return this.startClaude(message, signal);
    return this.startCodex(message, signal);
  }

  // -------------------------------------------------------------------------
  // Claude: PKCE, performed here.
  // -------------------------------------------------------------------------

  async startClaude(message, signal) {
    if (message.method === 'import') return this.importClaudeCurrent(signal);
    if (message.type === 'submit') return this.completeClaudeCode(message.secret, signal);
    if (message.method === 'code') return this.beginClaudeCode();
    return this.beginClaudeBrowser(signal);
  }

  async importClaudeCurrent(signal) {
    const { importClaudeAuth, defaultClaudeHome, backfillClaudeProfile, updateAccount } = await this.core();
    const accountId = await this.ensureAccount();
    this.post({ type: 'running', method: 'import' });

    let auth = await importClaudeAuth(accountId, defaultClaudeHome());
    if (!auth) throw new Error('That directory has a credential file but no access token in it.');
    auth = (await backfillClaudeProfile(accountId, { signal }).catch((error) => {
      if (error?.code === 'PROVIDER_CONTRACT_CHANGED') throw error;
      return auth;
    })) || auth;

    // This credential came from Claude Code's live home, so it is already the
    // login in use. Record that fact instead of offering to apply it back to
    // the same file.
    await updateAccount(accountId, { lastUsedAt: new Date().toISOString() });

    await this.store.reloadUsage({ force: true, signal });
    this.commitProvisional();
    this.post({ type: 'done', method: 'import', email: auth.email, label: this.target.label });
  }

  // The loopback half: a local server catches the redirect, so the user only
  // has to approve in the browser.
  async beginClaudeBrowser(signal) {
    const { createPkce, claudeAuthorizeUrl, startLoopbackServer } = await this.core();
    const accountId = await this.ensureAccount();
    this.post({ type: 'running', method: 'browser' });

    const pkce = createPkce();
    const server = startLoopbackServer({ state: pkce.state });
    await server.listening;
    this.loopback = server;

    const url = claudeAuthorizeUrl({
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: server.redirectUri
    });
    // Unlike `codex login`, nothing else is going to open this for us.
    await vscode.env.openExternal(vscode.Uri.parse(url));
    this.post({ type: 'progress', method: 'browser', parsed: { authorizeUrl: url } });

    let returned;
    try {
      returned = await server.result;
    } finally {
      server.close();
      this.loopback = undefined;
    }

    // The state is what stops another page on this machine from feeding us a
    // code of its own.
    if (returned.state !== pkce.state) {
      throw new Error('The sign-in response did not match this request. Start again.');
    }
    await this.finishClaude(accountId, 'browser', {
      code: returned.code,
      state: pkce.state,
      verifier: pkce.verifier,
      redirectUri: server.redirectUri
    }, signal);
  }

  // The no-localhost half: the authorization page displays a code to paste
  // back. Works over SSH, in a container, and on a locked-down host.
  async beginClaudeCode() {
    const { createPkce, claudeAuthorizeUrl, CLAUDE_MANUAL_REDIRECT_URI } = await this.core();
    const accountId = await this.ensureAccount();

    const pkce = createPkce();
    const url = claudeAuthorizeUrl({
      challenge: pkce.challenge,
      state: pkce.state,
      redirectUri: CLAUDE_MANUAL_REDIRECT_URI
    });
    this.pending = { ...pkce, accountId, redirectUri: CLAUDE_MANUAL_REDIRECT_URI };
    this.post({ type: 'progress', method: 'code', parsed: { authorizeUrl: url } });
  }

  async completeClaudeCode(secret, signal) {
    const { parseAuthorizationCode } = await this.core();
    if (!this.pending) throw new Error('Start this method again to get a fresh sign-in link.');

    const { code, state } = parseAuthorizationCode(secret);
    if (state && state !== this.pending.state) {
      throw new Error('That code came from a different sign-in attempt. Start again.');
    }

    this.post({ type: 'running', method: 'code' });
    await this.finishClaude(this.pending.accountId, 'code', {
      code,
      state: this.pending.state,
      verifier: this.pending.verifier,
      redirectUri: this.pending.redirectUri
    }, signal);
    this.pending = undefined;
  }

  async finishClaude(accountId, method, exchange, signal) {
    const { exchangeClaudeCode, fetchClaudeProfile, writeClaudeCredential } = await this.core();

    const tokens = await exchangeClaudeCode({ ...exchange, signal });
    // The token response says nothing about the person, so the card would be
    // unlabelled without this. A network failure is not fatal, but accepting a
    // provider shape we no longer understand would write uncertain identity.
    const profile = await fetchClaudeProfile(tokens.accessToken, { signal }).catch((error) => {
      if (error?.code === 'PROVIDER_CONTRACT_CHANGED') throw error;
      return undefined;
    });
    const auth = await writeClaudeCredential(accountId, tokens, profile);

    await this.store.reloadUsage({ force: true, signal });
    this.commitProvisional();
    this.post({
      type: 'done',
      method,
      email: profile?.emailAddress || auth?.email,
      label: this.target.label
    });
  }

  // -------------------------------------------------------------------------
  // Codex: drive the official binary and read its output.
  // -------------------------------------------------------------------------

  async startCodex(message, signal) {
    const { codexHome, refreshCodexAccountIdentity, codexLoginArgs } = await this.core();

    if (this.child) throw new Error('A sign-in is already running. Cancel it first.');

    const accountId = await this.ensureAccount();
    const method = message.method;
    const args = codexLoginArgs(method);
    this.post({ type: 'running', method });

    const result = await this.run(args, codexHome(accountId), method, message.secret);
    if (!result.ok) {
      throw new Error(result.message);
    }

    const auth = await refreshCodexAccountIdentity(accountId);
    if (!auth) {
      throw new Error('Sign-in finished but no credential was written. Try again.');
    }

    if (signal.aborted) throw new Error('Sign-in cancelled.');
    await this.store.reloadUsage({ force: true, signal });
    this.commitProvisional();
    this.post({ type: 'done', method, email: auth.claims?.email, label: this.target.label });
  }

  run(args, home, method, secret) {
    return new Promise((resolve) => {
      const child = spawn('codex', args, {
        env: {
          ...process.env,
          CODEX_HOME: home,
          // Ask for plain output. Highlighting wraps the device code and the
          // links in escape sequences; the parser strips them anyway, but not
          // emitting them is the cheaper half of the fix.
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          CLICOLOR: '0',
          TERM: 'dumb'
        },
        // The launcher on Windows is a shim, not an executable.
        shell: process.platform === 'win32'
      });
      this.child = child;

      let output = '';

      const onChunk = async (chunk) => {
        output = appendBoundedOutput(output, chunk, MAX_LOGIN_OUTPUT_CHARS);
        const { parseCodexLoginOutput: parse } = await this.core();
        // `codex login` opens the browser itself. Opening it again from here
        // launched the page twice and raised the editor's own "open external
        // website?" prompt on top of it. The panel offers the link as a manual
        // fallback instead, for when the CLI could not open one.
        this.post({ type: 'progress', method, parsed: parse(output) });
      };

      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);

      // Both secret-bearing methods read from stdin, never argv, so the value
      // never appears in a process listing.
      if (method === 'apikey' || method === 'token') {
        child.stdin?.end(`${String(secret || '').trim()}\n`);
      }

      child.on('error', (error) => {
        this.child = undefined;
        resolve({
          ok: false,
          message:
            error.code === 'ENOENT'
              ? 'The `codex` command was not found. Install the Codex CLI and make sure it is on your PATH.'
              : error.message
        });
      });

      child.on('close', async (code) => {
        const wasCancelled = this.child !== child;
        this.child = undefined;
        if (wasCancelled) return resolve({ ok: false, message: 'Sign-in cancelled.' });
        if (code === 0) return resolve({ ok: true });
        const { codexLoginFailureReason: reason } = await this.core();
        resolve({ ok: false, message: reason(output, code) });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function codexCards() {
  return `
    <section class="card" data-method="browser">
      <button class="method primary" data-open="browser">
        <span class="glyph">↗</span>
        <span><b>Sign in with ChatGPT</b><span>Opens your browser and waits for you to finish</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Starting…</span></div>
        <div data-link hidden>
          <p class="note">Your browser should have opened. If it did not, open the page yourself:</p>
          <div class="row"><button class="action primary" data-verify>Open sign-in page</button></div>
          <p class="link" data-authlink></p>
        </div>
        <div class="row">
          <button class="action" data-retry="browser">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
      </div>
    </section>

    <section class="card" data-method="device">
      <button class="method" data-open="device">
        <span class="glyph">⌗</span>
        <span><b>Use a device code</b><span>For remote or headless machines, or a different device</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Requesting a code…</span></div>
        <div data-code-block hidden>
          <div class="code" data-code></div>
          <p class="note" data-hint></p>
          <div class="row">
            <button class="action primary" data-verify>Open the sign-in page</button>
            <button class="action" data-copy>Copy code</button>
          </div>
        </div>
        <p class="note">No local port is used, so this works over SSH or in a container, and the
          browser can be on any device. It has to be enabled in your ChatGPT security settings; on a
          workspace account an admin may have turned it off.</p>
        <div class="row">
          <button class="action" data-retry="device">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
      </div>
    </section>

    <section class="card" data-method="token">
      <button class="method" data-open="token">
        <span class="glyph">⛨</span>
        <span><b>Use an access token</b><span>Paste a Codex access token, no browser or local port</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="field">
          <label for="accessToken">Codex access token</label>
          <input id="accessToken" type="password" placeholder="Paste the token" autocomplete="off" spellcheck="false">
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Verifying…</span></div>
        <div class="row">
          <button class="action primary" data-submit="token">Sign in with this token</button>
          <button class="action" data-retry="token" hidden>Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">Runs <code>codex login --with-access-token</code>. Workspace admins issue these
          for trusted scripts and private CI runners. The token goes straight to <code>codex</code> on
          standard input — Turntrail does not store or log it.</p>
      </div>
    </section>

    <section class="card" data-method="apikey">
      <button class="method" data-open="apikey">
        <span class="glyph">⚿</span>
        <span><b>Use an API key</b><span>Billed per token, not against a subscription</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="field">
          <label for="apiKey">OpenAI API key</label>
          <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false">
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Verifying…</span></div>
        <div class="row">
          <button class="action primary" data-submit="apikey">Sign in with this key</button>
          <button class="action" data-retry="apikey" hidden>Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">The key is passed straight to <code>codex</code> on standard input. Turntrail does not store or log it.</p>
      </div>
    </section>

    <section class="card" data-method="paste">
      <button class="method" data-open="paste">
        <span class="glyph">⇩</span>
        <span><b>Paste an existing login</b><span>Bring an auth.json across from a machine that is already signed in</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="field">
          <label for="authJson">Contents of <code>auth.json</code></label>
          <textarea id="authJson" rows="5" placeholder='{ "tokens": { "access_token": "..." } }'
            autocomplete="off" spellcheck="false"></textarea>
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Adopting…</span></div>
        <div class="row">
          <button class="action primary" data-submit="paste">Use this login</button>
          <button class="action" data-pick-file>Choose a file…</button>
          <button class="action" data-retry="paste" hidden>Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">On the signed-in machine the file is at <code>~/.codex/auth.json</code>
          (<code>%USERPROFILE%\\.codex\\auth.json</code> on Windows). Treat it like a password: it
          contains live access tokens. Choosing a file keeps the contents out of this page entirely.</p>
      </div>
    </section>`;
}

function claudeCards() {
  return `
    <section class="card" data-method="browser">
      <button class="method primary" data-open="browser">
        <span class="glyph">↗</span>
        <span><b>Sign in with Claude</b><span>Opens your browser and returns here automatically</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Starting…</span></div>
        <div data-link hidden>
          <p class="note">Approve access in the browser. This tab updates by itself when you are done.</p>
          <div class="row"><button class="action primary" data-verify>Open sign-in page</button></div>
          <p class="link" data-authlink></p>
        </div>
        <div class="row">
          <button class="action" data-retry="browser">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">Uses a local callback on port 54545. If you are on SSH or in a container,
          nothing is listening on that port there — use the authorization code instead.</p>
      </div>
    </section>

    <section class="card" data-method="code">
      <button class="method" data-open="code">
        <span class="glyph">⌗</span>
        <span><b>Use an authorization code</b><span>No local port — approve anywhere, paste the code back</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Preparing a sign-in link…</span></div>
        <div data-link hidden>
          <p class="note">Open this page, approve access, then copy the code it shows you:</p>
          <div class="row"><button class="action primary" data-verify>Open sign-in page</button></div>
          <p class="link" data-authlink></p>
        </div>
        <div class="field">
          <label for="authCode">Authorization code</label>
          <input id="authCode" type="text" placeholder="code#state" autocomplete="off" spellcheck="false">
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Exchanging…</span></div>
        <div class="row">
          <button class="action primary" data-submit="code">Complete sign-in</button>
          <button class="action" data-retry="code">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">The page shows the code as <code>code#state</code> — paste the whole thing.
          Pasting the full callback URL works too. Codes are single-use and expire within minutes.</p>
      </div>
    </section>

    <section class="card" data-method="import">
      <button class="method" data-open="import">
        <span class="glyph">⇐</span>
        <span><b>Use the login already on this machine</b><span>Adopt the account Claude Code is signed in as</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="status"><span class="spinner"></span><span data-status>Copying the current login…</span></div>
        <div class="row">
          <button class="action" data-retry="import">Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">Copies the credential from <code>~/.claude</code> into this account's own
          directory. The original is left exactly as it is, so Claude Code stays signed in.</p>
      </div>
    </section>

    <section class="card" data-method="paste">
      <button class="method" data-open="paste">
        <span class="glyph">⇩</span>
        <span><b>Paste an existing login</b><span>Bring a credential across from another machine</span></span>
        <span class="chev">▾</span>
      </button>
      <div class="body" hidden>
        <div class="field">
          <label for="claudeCreds">Contents of <code>.credentials.json</code></label>
          <textarea id="claudeCreds" rows="5" placeholder='{ "claudeAiOauth": { "accessToken": "..." } }'
            autocomplete="off" spellcheck="false"></textarea>
        </div>
        <div class="status" data-busy hidden><span class="spinner"></span><span data-status>Adopting…</span></div>
        <div class="row">
          <button class="action primary" data-submit="paste">Use this login</button>
          <button class="action" data-pick-file>Choose a file…</button>
          <button class="action" data-retry="paste" hidden>Retry</button>
          <button class="action" data-cancel>Cancel</button>
        </div>
        <p class="note">On the signed-in machine the file is at <code>~/.claude/.credentials.json</code>
          (<code>%USERPROFILE%\\.claude\\.credentials.json</code> on Windows). Treat it like a password.
          Choosing a file keeps the contents out of this page entirely. macOS keeps this in the
          Keychain instead, so there is no file to copy there.</p>
      </div>
    </section>`;
}

const LEDE = {
  codex: `Turntrail runs the official <code>codex</code> sign-in and stores the result in
      its own directory, so your existing login stays exactly as it is.`,
  claude: `Turntrail runs Claude's own sign-in flow and stores the result in its own
      directory, so your existing login stays exactly as it is.`
};

function html(webview, provider) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const claude = provider === 'claude';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: grid;
    place-items: center;
    overflow: auto;
  }
  #bg { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }
  .shell {
    position: relative; z-index: 1;
    width: min(560px, 92vw);
    padding: 40px 0 56px;
    display: flex; flex-direction: column; gap: 26px;
  }
  .hero { text-align: center; display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .mark {
    width: 54px; height: 54px; border-radius: 15px;
    display: grid; place-items: center;
    background: ${claude ? '#d97757' : 'var(--vscode-button-background)'};
    color: ${claude ? '#1a1a19' : 'var(--vscode-button-foreground)'};
    font-size: 24px; font-weight: 700;
  }
  h1 { margin: 6px 0 0; font-size: 1.75rem; font-weight: 600; letter-spacing: -0.01em; }
  .lede { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.55; max-width: 42ch; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  label { font-size: 0.85rem; color: var(--vscode-descriptionForeground); }
  input, textarea {
    font-family: inherit; font-size: 1rem; padding: 9px 11px; border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  textarea {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85rem;
    resize: vertical; min-height: 96px; line-height: 1.45;
  }
  input:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .methods { display: flex; flex-direction: column; gap: 10px; }
  .method {
    display: flex; align-items: center; gap: 13px; width: 100%; text-align: left;
    padding: 14px 16px; border-radius: 9px; cursor: pointer;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    color: inherit; font-family: inherit; font-size: 1rem;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .method:hover { border-color: var(--accent); transform: translateY(-1px); }
  .method:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .method[disabled] { opacity: 0.5; cursor: default; transform: none; }
  .method .glyph {
    flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 15px;
  }
  .method .chev { margin-left: auto; opacity: 0.6; transition: transform 160ms ease; }
  .card.open .method .chev { transform: rotate(180deg); }
  :root { --accent: ${claude ? '#d97757' : 'var(--vscode-focusBorder)'}; }
  .card {
    border-radius: 9px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    overflow: hidden;
  }
  .card > .method { border: none; border-radius: 0; width: 100%; }
  .card.open { border-color: var(--accent); }
  .card .body {
    display: flex; flex-direction: column; gap: 13px;
    padding: 15px 16px 16px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    background: var(--vscode-editorWidget-background);
  }
  .outcome {
    margin: 0; padding: 13px 16px; border-radius: 9px; line-height: 1.5;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.28));
    background: var(--vscode-editorWidget-background);
  }
  .method.primary { background: ${claude ? '#d97757' : 'var(--vscode-button-background)'}; color: ${claude ? '#1a1a19' : 'var(--vscode-button-foreground)'}; border-color: transparent; }
  .method.primary .glyph { background: rgba(0,0,0,0.16); color: inherit; }
  .method b { display: block; font-weight: 600; }
  .method span { display: block; font-size: 0.83rem; opacity: 0.75; margin-top: 1px; }
  .code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 2rem; font-weight: 700; letter-spacing: 0.16em; text-align: center;
    padding: 14px; border-radius: 8px; user-select: all;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.14));
  }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button.action {
    font-family: inherit; font-size: 0.9rem; padding: 7px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  button.action.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.action:hover { filter: brightness(1.12); }
  .status { display: flex; align-items: center; gap: 10px; color: var(--vscode-descriptionForeground); font-size: 0.92rem; }
  .spinner {
    width: 15px; height: 15px; flex: none; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: spin 800ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: var(--vscode-errorForeground); font-size: 0.92rem; line-height: 1.5; }
  .ok { color: var(--vscode-charts-green); font-weight: 600; }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.82rem; line-height: 1.6; }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; word-break: break-all; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
    .method { transition: none; }
  }
</style>
</head>
<body>
<canvas id="bg" aria-hidden="true"></canvas>
<div class="shell">
  <div class="hero">
    <div class="mark">⇄</div>
    <h1>${claude ? 'Connect a Claude account' : 'Connect a Codex subscription'}</h1>
    <p class="lede">${LEDE[claude ? 'claude' : 'codex']}</p>
  </div>

  <div class="field" id="nameField">
    <label for="label">Name this account</label>
    <input id="label" type="text" placeholder="Account 2" autocomplete="off" spellcheck="false">
  </div>

  <div class="methods" id="methods">
${claude ? claudeCards() : codexCards()}
  </div>

  <p class="outcome" id="outcome" hidden></p>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ACCENT = ${claude ? "'#d97757'" : 'null'};
let method = 'browser';

// Ambient background: slow drifting colour fields, drawn from the agent's own
// accent so the page belongs to whatever it is signing into. Static under
// reduced motion.
(function background() {
  const canvas = $('bg');
  const ctx = canvas.getContext('2d');
  const accent = ACCENT || getComputedStyle(document.body).getPropertyValue('--vscode-button-background').trim() || '#3b82f6';
  let width = 0, height = 0;

  function size() {
    const ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  const blobs = [
    { x: 0.24, y: 0.28, r: 0.42, dx: 0.00007, dy: 0.00005 },
    { x: 0.78, y: 0.62, r: 0.38, dx: -0.00005, dy: 0.00008 },
    { x: 0.52, y: 0.86, r: 0.34, dx: 0.00006, dy: -0.00006 }
  ];
  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 0.16;
    for (const blob of blobs) {
      const x = (blob.x + Math.sin(time * blob.dx) * 0.06) * width;
      const y = (blob.y + Math.cos(time * blob.dy) * 0.06) * height;
      const r = blob.r * Math.min(width, height);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, accent);
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function frame(time) { draw(time); requestAnimationFrame(frame); }
  window.addEventListener('resize', () => { size(); if (reduced) draw(0); });
  size();
  if (reduced) draw(0); else requestAnimationFrame(frame);
})();

const card = (name) => document.querySelector('.card[data-method="' + name + '"]');
const within = (name, selector) => card(name).querySelector(selector);
const STARTING = {
  browser: 'Opening your browser…',
  device: 'Requesting a code…',
  code: 'Exchanging the code…',
  import: 'Copying the current login…',
  token: 'Verifying the token…',
  apikey: 'Verifying the key…',
  paste: 'Adopting the login…'
};
// Methods that collect input before they can run, and where they read it from.
const SECRET_INPUT = ${claude ? "{ code: 'authCode', paste: 'claudeCreds' }" : "{ token: 'accessToken', apikey: 'apiKey', paste: 'authJson' }"};
// Two-step methods run something on open (to produce a link) and are completed
// later by a submit. A one-step method with an input just waits for the value.
const TWO_STEP = ${claude ? "{ code: true }" : '{}'};
const secretOf = (name) => {
  if (!SECRET_INPUT[name]) return undefined;
  const input = $(SECRET_INPUT[name]);
  const secret = input.value.trim();
  input.value = '';
  return secret;
};
const clearSecrets = () => Object.values(SECRET_INPUT).forEach((id) => { $(id).value = ''; });

// One method runs at a time, but every method stays on screen. Opening a card
// expands it in place and starts that flow; the others remain available so a
// method that is not working can be abandoned without losing the panel.
function open(name) {
  document.querySelectorAll('.card').forEach((element) => {
    const isTarget = element.dataset.method === name;
    element.classList.toggle('open', isTarget);
    element.querySelector('.body').hidden = !isTarget;
  });
  $('outcome').hidden = true;
  method = name;
  reset(name);
  // Cards that only carry a secret collect it before anything is started.
  if (SECRET_INPUT[name] && !TWO_STEP[name]) { $(SECRET_INPUT[name]).focus(); return; }
  run(name);
}

function reset(name) {
  const body = card(name).querySelector('.body');
  body.querySelectorAll('[data-link], [data-code-block], [data-busy]').forEach((element) => { element.hidden = true; });
  const status = within(name, '.status');
  if (status && (!SECRET_INPUT[name] || TWO_STEP[name])) status.hidden = false;
  const copy = within(name, '[data-copy]');
  if (copy) copy.textContent = 'Copy code';
  const retry = within(name, '[data-retry]');
  if (retry && SECRET_INPUT[name] && !TWO_STEP[name]) retry.hidden = true;
}

function run(name, secret) {
  within(name, '[data-status]').textContent = STARTING[name] || 'Starting…';
  const busy = within(name, '[data-busy]');
  if (busy && secret !== undefined) busy.hidden = false;
  vscode.postMessage({ type: 'start', method: name, label: $('label').value, secret });
}

// Shared by the submit buttons and by Retry: a secret-bearing method cannot run
// without its value, and focusing the empty field says so better than an error.
function runWithSecret(name) {
  const secret = secretOf(name);
  if (SECRET_INPUT[name] && !secret) { $(SECRET_INPUT[name]).focus(); return; }
  if (TWO_STEP[name]) {
    const busy = within(name, '[data-busy]');
    if (busy) busy.hidden = false;
    vscode.postMessage({ type: 'submit', method: name, label: $('label').value, secret });
    return;
  }
  run(name, secret);
}

document.querySelectorAll('[data-open]').forEach((button) =>
  button.addEventListener('click', () => {
    const name = button.dataset.open;
    // Clicking the header of the card that is already open collapses it.
    if (card(name).classList.contains('open')) {
      clearSecrets();
      vscode.postMessage({ type: 'cancel' });
      card(name).classList.remove('open');
      card(name).querySelector('.body').hidden = true;
      return;
    }
    clearSecrets();
    vscode.postMessage({ type: 'cancel' });
    open(name);
  }));

document.querySelectorAll('[data-retry]').forEach((button) =>
  button.addEventListener('click', () => {
    const name = button.dataset.retry;
    clearSecrets();
    vscode.postMessage({ type: 'cancel' });
    $('outcome').hidden = true;
    reset(name);
    // Retrying a two-step method starts over from a fresh link: its code is
    // single-use, so resubmitting the old one can only fail.
    if (TWO_STEP[name]) { run(name); return; }
    runWithSecret(name);
  }));

document.querySelectorAll('[data-cancel]').forEach((button) =>
  button.addEventListener('click', () => {
    clearSecrets();
    vscode.postMessage({ type: 'cancel' });
    document.querySelectorAll('.card').forEach((element) => {
      element.classList.remove('open');
      element.querySelector('.body').hidden = true;
    });
  }));

document.querySelectorAll('[data-submit]').forEach((button) =>
  button.addEventListener('click', () => runWithSecret(button.dataset.submit)));

// Picking a file lets the extension read it directly, so the credential is
// never pasted into, or held by, this page.
document.querySelectorAll('[data-pick-file]').forEach((button) =>
  button.addEventListener('click', () => {
    $('outcome').hidden = true;
    reset('paste');
    vscode.postMessage({ type: 'pickFile', label: $('label').value });
  }));

Object.entries(SECRET_INPUT).forEach(([name, inputId]) =>
  $(inputId).addEventListener('keydown', (event) => {
    // The pasted credential is multi-line, so Enter must not submit it.
    if (event.key === 'Enter' && $(inputId).tagName !== 'TEXTAREA') runWithSecret(name);
  }));

document.querySelectorAll('[data-verify]').forEach((button) =>
  button.addEventListener('click', () => {
    if (button.dataset.url) vscode.postMessage({ type: 'openExternal', url: button.dataset.url });
  }));
document.querySelectorAll('[data-copy]').forEach((button) =>
  button.addEventListener('click', () =>
    vscode.postMessage({ type: 'copy', value: within(method, '[data-code]').textContent })));

window.addEventListener('message', (event) => {
  const data = event.data || {};
  const name = data.method || method;

  if (data.type === 'ready') {
    $('label').value = data.label || '';
    $('nameField').hidden = Boolean(data.locked);
    return;
  }
  if (data.type === 'running') {
    within(name, '[data-status]').textContent = STARTING[name] || 'Starting…';
    return;
  }
  if (data.type === 'progress') {
    const parsed = data.parsed || {};
    if (parsed.deviceCode) {
      within(name, '[data-code-block]').hidden = false;
      within(name, '[data-code]').textContent = parsed.deviceCode;
      within(name, '[data-hint]').textContent = 'Enter this code after signing in'
        + (parsed.expiresIn ? '. It expires in ' + parsed.expiresIn + '.' : '.');
      within(name, '[data-status]').textContent = 'Waiting for you to enter the code…';
      if (parsed.verificationUrl) within(name, '[data-verify]').dataset.url = parsed.verificationUrl;
    }
    if (parsed.authorizeUrl) {
      const block = within(name, '[data-link]');
      if (block) {
        block.hidden = false;
        const link = within(name, '[data-authlink]');
        link.textContent = parsed.authorizeUrl;
        link.onclick = () => vscode.postMessage({ type: 'openExternal', url: parsed.authorizeUrl });
        const verify = within(name, '[data-verify]');
        if (verify) verify.dataset.url = parsed.authorizeUrl;
      }
      const status = within(name, '.status');
      if (status) status.hidden = TWO_STEP[name] === true;
      within(name, '[data-status]').textContent = 'Waiting for you to finish in the browser…';
    }
    return;
  }
  if (data.type === 'copied') {
    const copy = within(name, '[data-copy]');
    if (copy) copy.textContent = 'Copied';
    return;
  }
  if (data.type === 'done') {
    clearSecrets();
    document.querySelectorAll('.card').forEach((element) => {
      element.classList.remove('open');
      element.querySelector('.body').hidden = true;
    });
    const outcome = $('outcome');
    outcome.hidden = false;
    outcome.innerHTML = '<span class="ok">Connected.</span> '
      + (data.email ? esc(data.email) + ' is now available as “' : '“') + esc(data.label || '') + '”.';
    return;
  }
  if (data.type === 'failed') {
    clearSecrets();
    const status = within(name, '.status');
    if (status) status.hidden = true;
    const busy = within(name, '[data-busy]');
    if (busy) busy.hidden = true;
    const retry = within(name, '[data-retry]');
    if (retry) retry.hidden = false;
    const outcome = $('outcome');
    outcome.hidden = false;
    outcome.innerHTML = '<span class="error">Sign-in did not complete.</span><br>' + esc(data.message || '');
    return;
  }
});

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
</script>
</body>
</html>`;
}

module.exports = { LoginPanel, CodexLoginPanel: LoginPanel };
