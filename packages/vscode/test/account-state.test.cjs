const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => this.listeners.push(listener);
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  AccountsStore,
  authenticationFailureLabel,
  effectivePlan,
  summarizeAccounts,
  loginNeedsUpdate
} = require('../src/accounts-view.cjs');
const { classifyAccountHealth, recommendAccount } = require('../src/account-health.cjs');
Module._load = originalLoad;

test('an imported active login with no prior application timestamp needs no update', () => {
  const account = { id: 'claude-1', signedInAt: '2026-09-06T10:00:00.000Z' };
  assert.equal(loginNeedsUpdate(account, account.id), false);
});

test('a newly signed-in active account needs its official login updated', () => {
  const account = {
    id: 'claude-1',
    lastUsedAt: '2026-09-05T10:00:00.000Z',
    signedInAt: '2026-09-06T10:00:00.000Z'
  };
  assert.equal(loginNeedsUpdate(account, account.id), true);
  assert.equal(loginNeedsUpdate(account, 'another-account'), false);
  assert.equal(loginNeedsUpdate(account, account.id, true), false);
});

test('account health distinguishes authentication, quota, and stale evidence', () => {
  const now = Date.parse('2026-09-07T12:00:00.000Z');
  const fresh = '2026-09-07T11:59:00.000Z';
  assert.equal(classifyAccountHealth({ signedIn: false }, { now }).id, 'needs-sign-in');
  assert.equal(classifyAccountHealth({ signedIn: true, requiresRevalidation: true }, { now }).id, 'needs-verification');
  assert.equal(classifyAccountHealth({ signedIn: true, usageAccessFailure: 'USAGE_PERMISSION_DENIED' }, { now }).id, 'subscription-unavailable');
  assert.equal(classifyAccountHealth({ signedIn: true, limitReached: true, remaining: 80 }, { now }).id, 'limit-reached');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 12, fetchedAt: fresh }, { now }).id, 'low-quota');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 70, fetchedAt: fresh }, { now }).id, 'healthy');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 70, fetchedAt: '2026-09-07T04:00:00.000Z' }, { now }).id, 'usage-stale');
  assert.equal(classifyAccountHealth({ signedIn: true }, { now }).id, 'quota-unknown');
});

test('only confirmed authentication failures receive explicit sign-in labels', () => {
  assert.equal(authenticationFailureLabel(undefined), undefined);
  assert.equal(authenticationFailureLabel('ETIMEDOUT'), undefined);
  assert.equal(authenticationFailureLabel('AUTH_EXPIRED'), 'Authentication expired (AUTH_EXPIRED)');
  assert.equal(authenticationFailureLabel('AUTH_REJECTED'), 'Authentication rejected (AUTH_REJECTED)');
});

test('the account store records only coded authentication failures', async () => {
  const account = { id: 'claude-1', provider: 'claude', label: 'Personal' };
  const api = {
    listAccounts: async ({ provider } = {}) => provider === 'claude' ? [account] : [],
    activeCodexAccountId: async () => undefined,
    activeClaudeAccountId: async () => account.id,
    isSignedIn: async () => false,
    isClaudeSignedIn: async () => true,
    resumesAt: () => undefined
  };
  const store = new AccountsStore(async () => api);
  store.usage.set(account.id, {
    accountId: account.id,
    fetchedAt: new Date().toISOString(),
    staleReason: 'Old reading',
    windows: [{ label: '5h', remainingPercent: 80 }]
  });

  assert.equal(await store.markAuthenticationFailure(account.id, {
    code: 'ETIMEDOUT',
    message: 'Temporary network failure'
  }), false);
  assert.equal(store.usage.get(account.id).requiresSignIn, undefined);

  let model;
  store.onDidChange((next) => { model = next; });
  assert.equal(await store.markAuthenticationFailure(account.id, {
    code: 'AUTH_EXPIRED',
    message: 'Sign in again.'
  }), true);
  const row = model.sections.find((section) => section.id === 'claude').rows[0];
  assert.equal(row.requiresSignIn, true);
  assert.equal(row.requiresRevalidation, false);
  assert.equal(row.authenticationFailure, 'AUTH_EXPIRED');
  assert.equal(row.authenticationFailureLabel, 'Authentication expired (AUTH_EXPIRED)');
  assert.equal(row.signedIn, false);
  assert.equal(row.health.id, 'needs-sign-in');
  assert.deepEqual(row.windows, []);
});

test('a Claude usage permission failure is presented as an unavailable subscription', async () => {
  const account = { id: 'claude-ended', provider: 'claude', label: 'Ended plan' };
  const api = {
    listAccounts: async ({ provider } = {}) => provider === 'claude' ? [account] : [],
    activeCodexAccountId: async () => undefined,
    activeClaudeAccountId: async () => undefined,
    isSignedIn: async () => false,
    isClaudeSignedIn: async () => true,
    resumesAt: () => undefined
  };
  const store = new AccountsStore(async () => api);
  store.usage.set(account.id, {
    accountId: account.id,
    usageAccessFailure: 'USAGE_PERMISSION_DENIED',
    error: 'Claude denied access to subscription usage.',
    fetchedAt: new Date().toISOString(),
    windows: []
  });

  const row = (await store.viewModel()).sections.find((section) => section.id === 'claude').rows[0];
  assert.equal(row.signedIn, true);
  assert.equal(row.health.id, 'subscription-unavailable');
  assert.equal(row.remaining, undefined);
  assert.equal(row.recommended, false);
});

test('the account store refreshes stale usage without polling fresh accounts', async () => {
  const old = { id: 'claude-old', provider: 'claude', label: 'Old' };
  const fresh = { id: 'claude-fresh', provider: 'claude', label: 'Fresh' };
  const reads = [];
  const api = {
    listAccounts: async ({ provider } = {}) => provider === 'claude' ? [old, fresh] : [],
    activeCodexAccountId: async () => undefined,
    activeClaudeAccountId: async () => old.id,
    isSignedIn: async () => false,
    isClaudeSignedIn: async () => true,
    getCodexUsage: async () => { throw new Error('Codex must not be read'); },
    getClaudeUsage: async (accountId, options) => {
      reads.push({ accountId, force: options.force });
      return {
        accountId,
        fetchedAt: new Date().toISOString(),
        windows: [{ label: '5h', remainingPercent: 90 }]
      };
    },
    resumesAt: () => undefined
  };
  const store = new AccountsStore(async () => api);
  store.usage.set(old.id, {
    accountId: old.id,
    fetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    windows: [{ label: '5h', remainingPercent: 40 }]
  });
  store.usage.set(fresh.id, {
    accountId: fresh.id,
    fetchedAt: new Date().toISOString(),
    windows: [{ label: '5h', remainingPercent: 80 }]
  });

  assert.deepEqual(await store.reloadStaleUsage(), [old.id]);
  assert.deepEqual(reads, [{ accountId: old.id, force: true }]);
});

test('recommendation prefers fresh capacity and uses unknown quota only as a fallback', () => {
  const now = Date.parse('2026-09-07T12:00:00.000Z');
  const fresh = '2026-09-07T11:59:00.000Z';
  const rows = [
    { id: 'stale', signedIn: true, remaining: 100, fetchedAt: '2026-09-07T04:00:00.000Z' },
    { id: 'unknown', signedIn: true },
    { id: 'low', signedIn: true, remaining: 18, fetchedAt: fresh },
    { id: 'best', signedIn: true, remaining: 72, fetchedAt: fresh },
    { id: 'blocked', signedIn: true, remaining: 99, limitReached: true, fetchedAt: fresh }
  ];
  assert.equal(recommendAccount(rows, { now }).id, 'best');
  assert.equal(recommendAccount(rows.filter((row) => !['best', 'low'].includes(row.id)), { now }).id, 'unknown');
  assert.equal(recommendAccount([{ id: 'blocked', signedIn: true, limitReached: true }], { now }), undefined);
});

test('recommendation is deterministic and prefers the active account on an exact tie', () => {
  const fetchedAt = new Date().toISOString();
  const recommended = recommendAccount([
    { id: 'account-b', signedIn: true, remaining: 60, fetchedAt },
    { id: 'account-a', signedIn: true, remaining: 60, fetchedAt, active: true }
  ]);
  assert.equal(recommended.id, 'account-a');
});

test('recommendation prefers broader known capability before remaining quota', () => {
  const fetchedAt = new Date().toISOString();
  const recommended = recommendAccount([
    { id: 'free', plan: 'Free', signedIn: true, remaining: 100, fetchedAt },
    { id: 'unknown', plan: 'Prolite', signedIn: true, remaining: 100, fetchedAt },
    { id: 'plus', plan: 'Plus', signedIn: true, remaining: 30, fetchedAt }
  ]);
  assert.equal(recommended.id, 'plus');
});

test('the newest known plan source wins without guessing from limit windows', () => {
  assert.equal(effectivePlan(
    { plan: 'plus' },
    { plan: 'free', fetchedAt: '2026-10-03T12:00:00.000Z' }
  ), 'Free');
  assert.equal(effectivePlan(
    { plan: 'plus', planUpdatedAt: '2026-10-03T13:00:00.000Z' },
    { plan: 'free', fetchedAt: '2026-10-03T12:00:00.000Z' }
  ), 'Plus');
  assert.equal(effectivePlan(
    { plan: 'plus', signedInAt: '2026-10-03T13:00:00.000Z' },
    { plan: 'free', fetchedAt: '2026-10-03T12:00:00.000Z' }
  ), 'Plus');
  assert.equal(effectivePlan({ plan: 'edu' }, { windows: [{ label: 'monthly' }] }), 'Edu');
});

test('account summary reports readiness and comparable limit families without pooling percentages', () => {
  const summary = summarizeAccounts([
    {
      id: 'plus', label: 'Primary', plan: 'Plus', recommended: true,
      health: { id: 'healthy' },
      windows: [{ label: '5h', remaining: 40 }, { label: 'weekly', remaining: 70 }]
    },
    {
      id: 'free', label: 'Free', plan: 'Free',
      health: { id: 'healthy' },
      windows: [{ label: 'monthly', remaining: 100 }]
    },
    {
      id: 'expired', label: 'Expired',
      health: { id: 'needs-sign-in' }, windows: []
    },
    {
      id: 'stale', label: 'Stale',
      health: { id: 'usage-stale' },
      windows: [{ label: 'weekly', remaining: 90 }]
    }
  ]);

  assert.deepEqual(
    { count: summary.count, ready: summary.ready, stale: summary.stale, signIn: summary.signIn },
    { count: 4, ready: 2, stale: 1, signIn: 1 }
  );
  assert.deepEqual(summary.suggested, { label: 'Primary', plan: 'Plus' });
  assert.deepEqual(summary.limits, [
    { label: '5h', eligible: 1, ready: 1, best: 40 },
    { label: 'weekly', eligible: 2, ready: 1, best: 70 },
    { label: 'monthly', eligible: 1, ready: 1, best: 100 }
  ]);
  assert.equal('total' in summary, false);
  assert.equal('average' in summary, false);
});
