import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  carryClaudeRetention,
  claudeHome,
  claudeSettingsPath,
  ensureClaudeHome,
  managedClaudeSettingsPath,
  readClaudeRetention,
  setClaudeRetention,
  CLAUDE_DEFAULT_RETENTION_DAYS
} from '../src/index.js';

// The default home is resolved from this variable, so a value inherited from
// the shell running the tests would silently change what is under test.
delete process.env.CLAUDE_CONFIG_DIR;

async function sandbox(settings, managed) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-settings-'));
  const managedSettingsPath = path.join(home, 'managed', 'managed-settings.json');
  const options = { home, managedSettingsPath, agentProcesses: [] };
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  if (settings !== undefined) {
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  if (managed !== undefined) {
    await fs.mkdir(path.dirname(managedSettingsPath), { recursive: true });
    await fs.writeFile(managedSettingsPath, JSON.stringify(managed));
  }
  return options;
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('retention says where it comes from, and falls back to Claude\'s 30 days', async () => {
  const unset = await readClaudeRetention(await sandbox({ model: 'opus' }));
  assert.equal(unset.source, 'default');
  assert.equal(unset.days, CLAUDE_DEFAULT_RETENTION_DAYS);
  assert.equal(unset.settingsState, 'ok');

  const user = await readClaudeRetention(await sandbox({ cleanupPeriodDays: 3650 }));
  assert.deepEqual([user.source, user.days, user.userDays], ['user', 3650, 3650]);

  // The machine-wide file wins over the user's own, as Claude applies it.
  const managed = await readClaudeRetention(await sandbox({ cleanupPeriodDays: 90 }, { cleanupPeriodDays: 3650 }));
  assert.deepEqual([managed.source, managed.days, managed.userDays], ['managed', 3650, 90]);

  const missing = await readClaudeRetention(await sandbox());
  assert.equal(missing.settingsState, 'missing');
  assert.equal(missing.source, 'default');

  const broken = await readClaudeRetention(await sandbox('{ not json'));
  assert.equal(broken.settingsState, 'unreadable');

  // Values Claude rejects do not count as set.
  for (const value of [0, -5, '3650', null]) {
    assert.equal((await readClaudeRetention(await sandbox({ cleanupPeriodDays: value }))).source, 'default');
  }
});

test('the managed settings path is the one the Claude binary names on each platform', () => {
  assert.equal(managedClaudeSettingsPath('win32'), 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
  assert.equal(managedClaudeSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(managedClaudeSettingsPath('linux'), '/etc/claude-code/managed-settings.json');
});

test('an account folder gets the user\'s retention, and keeps everything else it has', async () => {
  const options = await sandbox({ cleanupPeriodDays: 3650, model: 'opus' });
  const file = claudeSettingsPath(claudeHome('work', options));

  // A new account folder has no settings at all: one is created with only the
  // retention, so nothing else of the user's leaks into it.
  await fs.mkdir(path.dirname(file), { recursive: true });
  assert.deepEqual(await carryClaudeRetention('work', options), { carried: true, days: 3650, path: file });
  assert.deepEqual(await readJsonFile(file), { cleanupPeriodDays: 3650 });

  // Something the account folder set for itself survives.
  await fs.writeFile(file, JSON.stringify({ cleanupPeriodDays: 30, model: 'sonnet' }));
  await carryClaudeRetention('work', options);
  assert.deepEqual(await readJsonFile(file), { cleanupPeriodDays: 3650, model: 'sonnet' });

  // A longer retention already there is not shortened.
  await fs.writeFile(file, JSON.stringify({ cleanupPeriodDays: 9999 }));
  const kept = await carryClaudeRetention('work', options);
  assert.equal(kept.carried, false);
  assert.equal(kept.reason, 'already-kept');
  assert.deepEqual(await readJsonFile(file), { cleanupPeriodDays: 9999 });

  // A file Claude itself could not read is the user's to fix, not ours to replace.
  await fs.writeFile(file, '{ broken');
  assert.equal((await carryClaudeRetention('work', options)).reason, 'unreadable');
  assert.equal(await fs.readFile(file, 'utf8'), '{ broken');
});

test('nothing is carried when the user has not set a retention', async () => {
  const options = await sandbox({ model: 'opus' });
  await fs.mkdir(claudeHome('work', options), { recursive: true });
  assert.deepEqual(await carryClaudeRetention('work', options), { carried: false, reason: 'not-set' });
  await assert.rejects(fs.access(claudeSettingsPath(claudeHome('work', options))));
});

test('preparing an account folder carries the retention, and never fails because of it', async () => {
  const options = await sandbox({ cleanupPeriodDays: 3650 });
  const home = await ensureClaudeHome('fresh', options);
  assert.deepEqual(await readJsonFile(claudeSettingsPath(home)), { cleanupPeriodDays: 3650 });

  // An unreadable account settings file is left alone and the folder is still prepared.
  await fs.writeFile(claudeSettingsPath(home), '{ broken');
  assert.equal(await ensureClaudeHome('fresh', options), home);
  assert.equal(await fs.readFile(claudeSettingsPath(home), 'utf8'), '{ broken');
});

test('setting the retention keeps every other setting and backs up the file first', async () => {
  const original = { model: 'opus', effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } };
  const options = await sandbox(original);
  options.now = () => Date.parse('2026-10-05T08:00:00.000Z');

  const result = await setClaudeRetention(3650, options);
  const file = path.join(options.home, '.claude', 'settings.json');
  assert.equal(result.path, file);
  assert.deepEqual(await readJsonFile(file), { ...original, cleanupPeriodDays: 3650 });
  assert.equal(path.basename(result.backupPath), 'settings.json.turntrail-backup-2026-10-05T08-00-00-000Z');
  assert.deepEqual(await readJsonFile(result.backupPath), original);
  assert.equal((await readClaudeRetention(options)).source, 'user');
});

test('setting the retention creates the file when Claude has none, and refuses a broken one', async () => {
  const fresh = await sandbox();
  const created = await setClaudeRetention(3650, fresh);
  assert.equal(created.backupPath, undefined);
  assert.deepEqual(await readJsonFile(created.path), { cleanupPeriodDays: 3650 });

  const broken = await sandbox('{ not json');
  await assert.rejects(setClaudeRetention(3650, broken), /is not valid JSON, so Turntrail left it alone/);
  assert.equal(await fs.readFile(path.join(broken.home, '.claude', 'settings.json'), 'utf8'), '{ not json');

  for (const days of [0, 1.5, -1, '3650']) {
    await assert.rejects(setClaudeRetention(days, fresh), /whole number of days/);
  }
});
