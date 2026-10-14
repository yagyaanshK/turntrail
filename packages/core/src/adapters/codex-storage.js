import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homePath } from './common.js';

// Codex chats that exist but that Turntrail cannot read.
//
// Turntrail reads Codex's plain JSONL rollouts. Codex owns that format and has
// been reshaping its storage (a SQLite thread index beside the rollouts, a
// "paginated" rollout migration, and announced cuts to what it keeps on disk).
// Should a build compress rollouts or keep chats only in its database, those
// chats would silently drop out of Sessions and Usage. This makes that loud.
// Each check is deterministic and reads at most the first bytes of a file.
//
// `homes` replaces the Codex homes to check; `extraHomes` adds to the stock one.
export async function checkCodexStorage(options = {}) {
  const requested = options.homes || [defaultHome(), ...(options.extraHomes || [])];
  const homes = [...new Set(requested.map((home) => path.resolve(home)))];
  const problems = { format: [], unrecognised: [], missing: [] };

  for (const home of homes) {
    for (const dir of ['sessions', 'archived_sessions']) {
      for (const file of await rolloutFiles(path.join(home, dir))) {
        if (!file.toLowerCase().endsWith('.jsonl')) problems.format.push(file);
        else if (!(await startsWithSessionMeta(file))) problems.unrecognised.push(file);
      }
    }
    problems.missing.push(...(await threadsWithoutRollout(home, options)));
  }

  return Object.entries(problems)
    .filter(([, files]) => files.length > 0)
    .map(([reason, files]) => ({ reason, count: files.length, examples: files.slice(0, 3), message: describe(reason, files) }));
}

function defaultHome() {
  return process.env.CODEX_HOME || homePath('.codex');
}

const REPORT = 'They are left out of Sessions and Usage. Update Turntrail, or report it at ' +
  'https://github.com/yagyaanshK/turntrail/issues if you already have the latest version.';

function describe(reason, files) {
  const count = files.length;
  const chats = `${count} Codex chat${count === 1 ? '' : 's'}`;
  const example = path.basename(files[0]);
  if (reason === 'format') {
    return `${chats} ${count === 1 ? 'is' : 'are'} stored in a format Turntrail cannot read yet (${example}). ${REPORT}`;
  }
  if (reason === 'unrecognised') {
    return `${chats} ${count === 1 ? 'has' : 'have'} a transcript that does not start the way Turntrail expects (${example}). ${REPORT}`;
  }
  return `Codex lists ${chats} with no transcript file, so Codex may now keep ${count === 1 ? 'it' : 'them'} only in its own database (${example}). ${REPORT}`;
}

// Every file Codex named as a rollout, whatever its extension.
async function rolloutFiles(dir) {
  const found = [];
  const walk = async (current, depth) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-/i.test(entry.name)) found.push(full);
    }
  };
  await walk(dir, 0);
  return found;
}

async function startsWithSessionMeta(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // An empty file is a rollout Codex has not written to yet, not a new format.
    if (bytesRead === 0) return true;
    return /^\{[^\n]{0,300}?"type":"session_meta"/.test(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Threads in Codex's own index whose rollout file does not exist. Codex creates
// a rollout once the first message is sent, so threads with no user message
// yet, and any touched in the last few minutes, are left alone.
async function threadsWithoutRollout(home, options) {
  const database = newestStateDatabase(home);
  if (!database) return [];
  const sqlite = await loadSqlite();
  if (!sqlite?.DatabaseSync) return [];

  let db;
  try {
    db = new sqlite.DatabaseSync(database, { readOnly: true });
    const rows = db.prepare('SELECT * FROM threads').all();
    const now = (options.now || Date.now)() / 1000;
    const missing = [];
    for (const row of rows) {
      const rollout = typeof row.rollout_path === 'string' ? row.rollout_path : '';
      if (!rollout) continue;
      if (row.has_user_event === 0) continue;
      const updatedAt = Number(row.updated_at);
      if (Number.isFinite(updatedAt) && now - updatedAt < 300) continue;
      const file = path.isAbsolute(rollout) ? rollout : path.join(home, rollout);
      if (!fsSync.existsSync(file)) missing.push(file);
    }
    return missing;
  } catch {
    // A locked, reshaped or unreadable index proves nothing either way.
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

function newestStateDatabase(home) {
  let names;
  try {
    names = fsSync.readdirSync(home);
  } catch {
    return undefined;
  }
  const versions = names
    .map((name) => /^state_(\d+)\.sqlite$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return versions.length > 0 ? path.join(home, versions[0][0]) : undefined;
}

// `node:sqlite` exists from Node 22.5 and announces itself as experimental on
// load. That notice is about Node, not about anything the user can act on, so
// it is kept out of the CLI's output. Older runtimes simply skip this check.
async function loadSqlite() {
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/i.test(String(text || ''))) return undefined;
    return original.call(this, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } catch {
    return undefined;
  } finally {
    process.emitWarning = original;
  }
}
