const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { loginNeedsUpdate } = require('../src/accounts-view.cjs');
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
  assert.equal(classifyAccountHealth({ signedIn: true, limitReached: true, remaining: 80 }, { now }).id, 'limit-reached');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 12, fetchedAt: fresh }, { now }).id, 'low-quota');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 70, fetchedAt: fresh }, { now }).id, 'healthy');
  assert.equal(classifyAccountHealth({ signedIn: true, remaining: 70, fetchedAt: '2026-09-07T04:00:00.000Z' }, { now }).id, 'usage-stale');
  assert.equal(classifyAccountHealth({ signedIn: true }, { now }).id, 'quota-unknown');
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
