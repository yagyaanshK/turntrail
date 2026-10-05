import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, writeFileAtomic } from '../fs-utils.js';
import { claudeHome, defaultClaudeHome } from './claude.js';

// Claude Code deletes a chat transcript once it has gone this many days
// without activity, unless `cleanupPeriodDays` says otherwise. It is the only
// Claude setting whose absence destroys data, which is why Turntrail watches
// it and nothing else in the settings file.
export const CLAUDE_DEFAULT_RETENTION_DAYS = 30;
// What Turntrail offers when the setting is missing: about ten years.
export const CLAUDE_KEEP_CHATS_DAYS = 3650;

// Settings live inside the config directory for both the stock `~/.claude`
// home and a CLAUDE_CONFIG_DIR one, unlike `.claude.json`.
export function claudeSettingsPath(home) {
  return path.join(home, 'settings.json');
}

// The machine-wide file Claude Code reads on top of every config directory,
// including Turntrail's per-account ones. Paths as the installed Claude binary
// names them; Windows also honours a registry policy, which is not read here.
export function managedClaudeSettingsPath(platform = process.platform) {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// A settings file as Claude would see it: missing, unreadable, or an object.
async function readSettingsFile(file) {
  if (!(await pathExists(file))) return { state: 'missing' };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable' };
    return { state: 'ok', settings: parsed };
  } catch {
    return { state: 'unreadable' };
  }
}

function retentionOf(settings) {
  const value = settings?.cleanupPeriodDays;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

// How long Claude Code keeps chats in the default config directory, and why.
// `source` is 'managed' when the machine-wide file sets it (it then wins over
// every per-user file), 'user' when the user's own settings do, and 'default'
// when neither does and Claude falls back to 30 days.
export async function readClaudeRetention(options = {}) {
  const home = defaultClaudeHome(options);
  const settingsPath = claudeSettingsPath(home);
  const managedPath = options.managedSettingsPath || managedClaudeSettingsPath(options.platform);
  const [user, managed] = await Promise.all([readSettingsFile(settingsPath), readSettingsFile(managedPath)]);
  const managedDays = retentionOf(managed.settings);
  const userDays = retentionOf(user.settings);
  const source = managedDays !== undefined ? 'managed' : userDays !== undefined ? 'user' : 'default';
  return {
    days: managedDays ?? userDays ?? CLAUDE_DEFAULT_RETENTION_DAYS,
    source,
    userDays,
    managedDays,
    settingsPath,
    managedPath,
    settingsState: user.state
  };
}

// Give an account's config directory the retention of the default one.
//
// A chat started through Turntrail as a managed account runs with that
// account's directory as its whole world, settings included. Without this its
// chats would be swept after 30 days even though the user had asked Claude to
// keep them. Only `cleanupPeriodDays` is carried; a longer value already in the
// account directory is kept, and a file Claude itself could not read is left
// for the user rather than overwritten.
export async function carryClaudeRetention(accountId, options = {}) {
  const retention = await readClaudeRetention(options);
  if (retention.userDays === undefined) return { carried: false, reason: 'not-set' };
  const days = retention.userDays;

  const file = claudeSettingsPath(claudeHome(accountId, options));
  const current = await readSettingsFile(file);
  if (current.state === 'unreadable') return { carried: false, reason: 'unreadable', path: file };
  const existing = retentionOf(current.settings);
  if (existing !== undefined && existing >= days) return { carried: false, reason: 'already-kept', days: existing, path: file };

  const next = { ...(current.settings || {}), cleanupPeriodDays: days };
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  return { carried: true, days, path: file };
}

// Set how long Claude Code keeps chats, in the user's own settings.
//
// Only on an explicit request. The file is Claude's, so every other key is
// left as it was, the previous file is copied aside first, and a file that does
// not parse is refused rather than replaced.
export async function setClaudeRetention(days, options = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error('Chat retention must be a whole number of days, at least 1.');
  const file = claudeSettingsPath(defaultClaudeHome(options));
  const current = await readSettingsFile(file);
  if (current.state === 'unreadable') {
    throw new Error(`${file} is not valid JSON, so Turntrail left it alone. Fix it, or set "cleanupPeriodDays" by hand.`);
  }

  let backupPath;
  if (current.state === 'ok') {
    const stamp = new Date((options.now || Date.now)()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${file}.turntrail-backup-${stamp}`;
    await fs.copyFile(file, backupPath);
  }
  const next = { ...(current.settings || {}), cleanupPeriodDays: days };
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  return { days, path: file, backupPath };
}
