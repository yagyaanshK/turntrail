const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { loginNeedsUpdate } = require('../src/accounts-view.cjs');
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
