import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  accountDir, accountsRoot, claudeHome, codexHome, consolidateDuplicateAccount,
  createAccount, importClaudeAuth, importClaudeAuthText, importCodexAuth,
  importCodexAuthText, listAccounts, readClaudeAuth, readCodexAuth,
  refreshCodexAccountIdentity, withCodexLoginHome, writeClaudeCredential
} from '../src/index.js';
import { sameAccountIdentity } from '../src/accounts/identity.js';

async function sandbox(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-identity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, agentProcesses: [] };
}

function codexCredential(account = 'workspace-a', user = 'user-a', token = 'session-a') {
  const claims = { sub: user, email: 'person@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: account } };
  return JSON.stringify({ tokens: {
    account_id: account,
    access_token: `${token}-access`,
    refresh_token: `${token}-refresh`,
    id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
  } });
}

function duplicateError(error) {
  assert.equal(error.code, 'DUPLICATE_ACCOUNT');
  assert.ok(error.existingAccountId);
  assert.match(error.message, /already connected.*existing card.*Sign in to existing account.*not changed/);
  assert.doesNotMatch(error.message, /session-[ab]-(?:access|refresh)/);
  return true;
}

test('identity comparison separates workspaces, users, providers and API keys', () => {
  assert.equal(sameAccountIdentity('codex', { accountId: 'a' }, { accountId: 'a' }), true);
  assert.equal(sameAccountIdentity('codex', { accountId: 'a' }, { accountId: 'b' }), false);
  assert.equal(sameAccountIdentity('codex', { accountId: 'a', claims: { sub: 'u' } }, { accountId: 'a', claims: { sub: 'v' } }), false);
  assert.equal(sameAccountIdentity('codex', { apiKey: 'key-a' }, { apiKey: 'key-a' }), true);
  assert.equal(sameAccountIdentity('codex', { apiKey: 'key-a' }, { apiKey: 'key-b' }), false);
  assert.equal(sameAccountIdentity('codex', { apiKey: 'key-a', accountId: 'old' }, { apiKey: 'key-b', accountId: 'old' }), false);
  assert.equal(sameAccountIdentity('codex', { claims: { email: 'person@example.com' } }, { claims: { email: 'person@example.com' } }), false);
  assert.equal(sameAccountIdentity('claude', { organizationUuid: 'a', email: 'Person@example.com' }, { organizationUuid: 'a', email: 'person@example.com' }), true);
  assert.equal(sameAccountIdentity('claude', { organizationUuid: 'a', email: 'person@example.com' }, { organizationUuid: 'b', email: 'person@example.com' }), false);
  assert.equal(sameAccountIdentity('claude', { organizationUuid: 'a', profile: { accountUuid: 'u' } }, { organizationUuid: 'a', profile: { accountUuid: 'v' } }), false);
  assert.equal(sameAccountIdentity('claude', { email: 'person@example.com' }, { email: 'person@example.com' }), false);
  assert.equal(sameAccountIdentity('claude', {}, {}), false);
  assert.equal(sameAccountIdentity('unknown', { accessToken: 'a' }, { accessToken: 'a' }), false);
});

test('Codex duplicate paste is rejected before replacing any managed or live login', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'Existing' }, options);
  const second = await createAccount({ label: 'Other' }, options);
  const original = codexCredential();
  const other = codexCredential('workspace-b', 'user-a', 'other');
  await importCodexAuthText(first.id, original, options);
  await importCodexAuthText(second.id, other, options);
  const live = path.join(options.home, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(live));
  await fs.writeFile(live, original);
  const beforeFirst = await fs.readFile(path.join(codexHome(first.id, options), 'auth.json'));
  const beforeSecond = await fs.readFile(path.join(codexHome(second.id, options), 'auth.json'));
  await assert.rejects(() => importCodexAuthText(second.id, codexCredential('workspace-a', 'user-a', 'session-b'), options), duplicateError);
  assert.deepEqual(await fs.readFile(path.join(codexHome(first.id, options), 'auth.json')), beforeFirst);
  assert.deepEqual(await fs.readFile(path.join(codexHome(second.id, options), 'auth.json')), beforeSecond);
  assert.equal(await fs.readFile(live, 'utf8'), original);
  assert.equal((await listAccounts(options)).length, 2);
});

test('Codex same-email workspaces remain separate and self reauthentication is allowed', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'One' }, options);
  const second = await createAccount({ label: 'Two' }, options);
  await importCodexAuthText(first.id, codexCredential(), options);
  await importCodexAuthText(second.id, codexCredential('workspace-b'), options);
  await importCodexAuthText(first.id, codexCredential('workspace-a', 'user-a', 'session-b'), options);
  assert.equal((await readCodexAuth(codexHome(first.id, options))).refreshToken, 'session-b-refresh');
  assert.equal((await listAccounts(options)).length, 2);
});

test('duplicate API keys and file imports are checked without needing an email', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'Key' }, options);
  const second = await createAccount({ label: 'Key copy' }, options);
  const auth = await importCodexAuthText(first.id, '{"OPENAI_API_KEY":"test-key"}', options);
  assert.ok(auth?.apiKey);
  await assert.rejects(() => importCodexAuth(second.id, codexHome(first.id, options), options), duplicateError);
  await assert.rejects(() => fs.access(path.join(codexHome(second.id, options), 'auth.json')), { code: 'ENOENT' });
  await importCodexAuthText(second.id, '{"OPENAI_API_KEY":"different-key"}', options);
});

test('Codex temporary login homes are removed after success and failure', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'First' }, options);
  const second = await createAccount({ label: 'Second' }, options);
  await importCodexAuthText(first.id, codexCredential(), options);
  await importCodexAuthText(second.id, codexCredential('workspace-b'), options);
  const before = await fs.readFile(path.join(codexHome(second.id, options), 'auth.json'));
  let temporary;
  await assert.rejects(() => withCodexLoginHome(second.id, async (home) => {
    temporary = home;
    await fs.writeFile(path.join(home, 'auth.json'), codexCredential());
    return importCodexAuth(second.id, home, options);
  }, options), duplicateError);
  await assert.rejects(() => fs.access(temporary), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(codexHome(second.id, options), 'auth.json')), before);
  await withCodexLoginHome(second.id, async (home) => { temporary = home; }, options);
  await assert.rejects(() => fs.access(temporary), { code: 'ENOENT' });
});

test('Codex post-login identity recording detects older duplicate entries', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'One' }, options);
  const second = await createAccount({ label: 'Two' }, options);
  await importCodexAuthText(first.id, codexCredential(), options);
  await fs.mkdir(codexHome(second.id, options));
  await fs.writeFile(path.join(codexHome(second.id, options), 'auth.json'), codexCredential());
  await assert.rejects(() => refreshCodexAccountIdentity(second.id, options), duplicateError);
});

test('simultaneous Codex imports cannot register the same identity twice', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'One' }, options);
  const second = await createAccount({ label: 'Two' }, options);
  const result = await Promise.allSettled([
    importCodexAuthText(first.id, codexCredential(), options),
    importCodexAuthText(second.id, codexCredential('workspace-a', 'user-a', 'session-b'), options)
  ]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  duplicateError(result.find(r => r.status === 'rejected').reason);
});

test('Claude OAuth, paste and current-login imports reject known duplicates before writing', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'Claude one', provider: 'claude' }, options);
  const second = await createAccount({ label: 'Claude two', provider: 'claude' }, options);
  const profile = { emailAddress: 'person@example.com', accountUuid: 'u', organizationUuid: 'org-a' };
  const tokens = { accessToken: 'session-a-access', refreshToken: 'session-a-refresh' };
  await writeClaudeCredential(first.id, tokens, profile, options);
  await writeClaudeCredential(second.id, { accessToken: 'other', refreshToken: 'other-refresh' }, { ...profile, organizationUuid: 'org-b' }, options);
  const before = await fs.readFile(path.join(claudeHome(second.id, options), '.credentials.json'));
  await assert.rejects(() => writeClaudeCredential(second.id, { accessToken: 'session-b-access' }, profile, options), duplicateError);
  await assert.rejects(() => importClaudeAuth(second.id, claudeHome(first.id, options), options), duplicateError);
  const paste = await fs.readFile(path.join(claudeHome(first.id, options), '.credentials.json'), 'utf8');
  await assert.rejects(() => importClaudeAuthText(second.id, paste, options), duplicateError);
  assert.deepEqual(await fs.readFile(path.join(claudeHome(second.id, options), '.credentials.json')), before);
  assert.equal((await readClaudeAuth(claudeHome(second.id, options), options)).organizationUuid, 'org-b');
});

test('consolidation backs up the registry, retains credential trees and never writes the live login', async (t) => {
  const options = await sandbox(t);
  const keep = await createAccount({ label: 'Keep' }, options);
  const duplicate = await createAccount({ label: 'Duplicate' }, options);
  const auth = codexCredential();
  for (const a of [keep, duplicate]) {
    await fs.mkdir(codexHome(a.id, options));
    await fs.writeFile(path.join(codexHome(a.id, options), 'auth.json'), auth);
  }
  await fs.writeFile(path.join(accountDir(duplicate.id, options), 'preserved-session.jsonl'), 'history');
  const live = path.join(options.home, '.codex', 'auth.json');
  await fs.mkdir(path.dirname(live));
  await fs.writeFile(live, auth);
  const result = await consolidateDuplicateAccount(keep.id, duplicate.id, options);
  assert.equal(result.credentialsPreserved, true);
  assert.ok(result.backup.startsWith(accountsRoot(options) + path.sep));
  assert.equal(JSON.parse(await fs.readFile(result.backup, 'utf8')).accounts.length, 2);
  assert.deepEqual((await listAccounts(options)).map(a => a.id), [keep.id]);
  assert.equal(await fs.readFile(path.join(codexHome(duplicate.id, options), 'auth.json'), 'utf8'), auth);
  assert.equal(await fs.readFile(path.join(accountDir(duplicate.id, options), 'preserved-session.jsonl'), 'utf8'), 'history');
  assert.equal(await fs.readFile(live, 'utf8'), auth);
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
});

test('consolidation refuses different identities, sessions, providers, and missing entries', async (t) => {
  const options = await sandbox(t);
  const first = await createAccount({ label: 'First' }, options);
  const second = await createAccount({ label: 'Second' }, options);
  const claude = await createAccount({ label: 'Claude', provider: 'claude' }, options);
  for (const a of [first, second]) await fs.mkdir(codexHome(a.id, options));
  await fs.writeFile(path.join(codexHome(first.id, options), 'auth.json'), codexCredential());
  await fs.writeFile(path.join(codexHome(second.id, options), 'auth.json'), codexCredential('workspace-b'));
  await assert.rejects(() => consolidateDuplicateAccount(first.id, second.id, options), /same confirmed provider identity/);
  await fs.writeFile(path.join(codexHome(second.id, options), 'auth.json'), codexCredential('workspace-a', 'user-a', 'session-b'));
  await assert.rejects(() => consolidateDuplicateAccount(first.id, second.id, options), /credentials differ/);
  await assert.rejects(() => consolidateDuplicateAccount(first.id, claude.id, options), /same provider/);
  await assert.rejects(() => consolidateDuplicateAccount(first.id, 'missing', options), /must exist/);
  await assert.rejects(() => consolidateDuplicateAccount(first.id, first.id, options), /two different/);
  assert.equal((await listAccounts(options)).length, 3);
});
