import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEDGER_DIR = '.turntrail';
export const LEGACY_LEDGER_DIR = '.context-bridge';

export function resolveLedger(root) {
  const canonical = path.resolve(root, LEDGER_DIR);
  const legacy = path.resolve(root, LEGACY_LEDGER_DIR);
  if (fsSync.existsSync(canonical)) return canonical;
  if (fsSync.existsSync(legacy)) return legacy;
  return canonical;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function uniqueArtifactId(date = new Date()) {
  return `${timestampForPath(date)}-${randomUUID()}`;
}

export function validatePathSegment(value, label = 'Path segment') {
  const text = String(value || '');
  if (!text || text === '.' || text === '..' || text.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new Error(`${label} contains characters that are not safe in a filename.`);
  }
  return text;
}

export function resolveInside(base, ...segments) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...segments);
  if (target === root || !isPathInside(root, target)) {
    throw new Error(`Path escapes its allowed directory: ${target}`);
  }
  return target;
}

export async function resolveExistingInside(base, candidate) {
  const root = await fs.realpath(path.resolve(base));
  const target = await fs.realpath(path.resolve(candidate));
  if (!isPathInside(root, target)) throw new Error(`Path escapes its allowed directory: ${target}`);
  return target;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// Like writeFileAtomic, for content produced one line at a time. A large
// session is written in 1 MB pieces instead of being joined into one string
// first, which on a 17,000-turn import was an extra 90 MB held in memory.
export async function writeLinesAtomic(filePath, lines, options = {}) {
  const target = path.resolve(filePath);
  await ensureDir(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', options.mode ?? 0o600);
    let buffer = '';
    for (const line of lines) {
      buffer += `${line}\n`;
      if (buffer.length >= 1024 * 1024) {
        await handle.write(buffer, null, 'utf8');
        buffer = '';
      }
    }
    if (buffer) await handle.write(buffer, null, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeFileAtomic(filePath, content, options = {}) {
  const target = path.resolve(filePath);
  await ensureDir(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', options.mode ?? 0o600);
    await handle.writeFile(content, options.encoding || 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function withFileLock(filePath, operation, options = {}) {
  const lockPath = `${path.resolve(filePath)}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? 10000;
  const staleMs = options.lockStaleMs ?? 30000;
  const startedAt = Date.now();
  await ensureDir(path.dirname(lockPath));

  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
    } catch (error) {
      // Windows can report a sharing violation as EPERM/EACCES, and the owner
      // may remove the lock before our follow-up stat runs. Retry those codes
      // within the bounded lock timeout instead of misclassifying contention.
      const contention = error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES';
      if (!contention) throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for storage lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function listFiles(dir, extension, options = {}) {
  if (!(await pathExists(dir))) return [];
  const maxEntries = options.maxEntries ?? 10000;
  const files = [];
  const directory = await fs.opendir(dir);
  let seen = 0;
  for await (const entry of directory) {
    options.signal?.throwIfAborted();
    seen++;
    if (seen > maxEntries) throw new Error(`Directory contains more than the ${maxEntries}-entry safety limit: ${dir}`);
    if (entry.isFile() && (!extension || entry.name.endsWith(extension))) files.push(path.join(dir, entry.name));
  }
  return files.sort();
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
