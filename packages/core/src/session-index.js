import crypto from 'node:crypto';
import { discoverNativeSessions, normalizeNativeProvider } from './adapters/index.js';
import { normalizePath } from './adapters/common.js';
import { readManifest } from './store.js';

export const NATIVE_SESSION_PROVIDERS = ['claude', 'codex', 'gemini', 'cursor'];
export const DEFAULT_SESSION_INDEX_LIMIT = 100;
export const MAX_ADDITIONAL_DISCOVERY_LOCATIONS = 50;

export async function listSessionIndex(root, options = {}) {
  const providers = normalizeProviders(options.providers);
  const errors = [];
  const nativeByProvider = {};

  await Promise.all(providers.map(async (provider) => {
    try {
      const discoveryOptions = options.discoveryOptions?.[provider] || {};
      const { additionalLocations: requestedLocations, ...baseDiscoveryOptions } = discoveryOptions;
      const additionalLocations = Array.isArray(requestedLocations)
        ? requestedLocations.slice(0, MAX_ADDITIONAL_DISCOVERY_LOCATIONS)
        : [];
      if (Array.isArray(requestedLocations) && requestedLocations.length > additionalLocations.length) {
        errors.push({
          provider,
          message: `Skipped ${requestedLocations.length - additionalLocations.length} extra account homes above the discovery limit.`
        });
      }
      let providerErrors = 0;
      const discovered = [];
      for (const location of [{}, ...additionalLocations]) {
        try {
          const rows = await discoverNativeSessions(provider, {
            root,
            all: Boolean(options.all),
            includeArchived: true,
            limit: options.perProviderLimit || DEFAULT_SESSION_INDEX_LIMIT,
            signal: options.signal,
            ...baseDiscoveryOptions,
            ...location,
            onDiscoveryError(details) {
              discoveryOptions.onDiscoveryError?.(details);
              if (providerErrors++ < 3) {
                const message = details.error instanceof Error ? details.error.message : String(details.error);
                errors.push({ provider, message: `Skipped one unreadable transcript: ${message}` });
              }
            }
          });
          discovered.push(...rows);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (providerErrors++ < 3) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ provider, message: `Skipped one unreadable session store: ${message}` });
          }
        }
      }
      nativeByProvider[provider] = discovered;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      nativeByProvider[provider] = [];
      errors.push({ provider, message: error instanceof Error ? error.message : String(error) });
    }
  }));

  let manifest = { sessions: [] };
  try {
    manifest = await readManifest(root);
  } catch (error) {
    if (!String(error?.message || error).includes('Turntrail is not initialized')) {
      errors.push({ provider: 'ledger', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    sessions: await mergeSessionIndex(nativeByProvider, manifest, {
      ...options,
      limit: options.limit || DEFAULT_SESSION_INDEX_LIMIT
    }),
    errors
  };
}

export async function mergeSessionIndex(nativeByProvider, manifest, options = {}) {
  const ledgerEntries = Array.isArray(manifest?.sessions) ? manifest.sessions : [];
  const ledgerBySource = new Map();
  const ledgerByNativeId = new Map();
  const normalizedSources = await Promise.all(ledgerEntries.map(async (entry) => {
    if (!entry?.sourcePath) return undefined;
    try {
      return await normalizePath(entry.sourcePath, options);
    } catch {
      return undefined;
    }
  }));

  ledgerEntries.forEach((entry, index) => {
    if (!entry?.id) return;
    const provider = normalizeNativeProvider(entry.provider);
    const normalizedSource = normalizedSources[index];
    if (normalizedSource) ledgerBySource.set(`${provider}\0${normalizedSource}`, entry);
    if (entry.nativeSessionId) ledgerByNativeId.set(`${provider}\0${entry.nativeSessionId}`, entry);
  });

  const rows = [];
  const matchedLedgerIds = new Set();
  const seenNative = new Set();

  for (const [providerName, sessions] of Object.entries(nativeByProvider || {})) {
    const provider = normalizeNativeProvider(providerName);
    for (const session of Array.isArray(sessions) ? sessions : []) {
      options.signal?.throwIfAborted();
      if (!session?.path || !session?.sessionId) continue;
      let normalizedSource;
      try {
        normalizedSource = await normalizePath(session.path, options);
      } catch {
        continue;
      }
      const nativeKey = `${provider}\0${normalizedSource}`;
      if (seenNative.has(nativeKey)) continue;
      seenNative.add(nativeKey);

      const imported = ledgerBySource.get(nativeKey) || ledgerByNativeId.get(`${provider}\0${session.sessionId}`);
      if (imported?.id) matchedLedgerIds.add(imported.id);
      rows.push({
        id: nativeRowId(provider, normalizedSource),
        kind: 'native',
        provider,
        surface: session.surface || 'unknown',
        sessionId: session.sessionId,
        title: session.title || session.latest || session.sessionId,
        latest: session.latest,
        opening: session.opening,
        named: Boolean(session.named),
        modifiedAt: session.modifiedAt,
        cwd: session.cwd,
        size: session.size,
        matchesProject: session.matchesProject !== false,
        imported: Boolean(imported),
        importedAt: imported?.importedAt,
        ledgerSessionId: imported?.id,
        path: session.path,
        native: session
      });
    }
  }

  for (const entry of ledgerEntries) {
    if (!entry?.id || matchedLedgerIds.has(entry.id)) continue;
    rows.push({
      id: `ledger:${entry.id}`,
      kind: 'ledger',
      provider: normalizeNativeProvider(entry.provider) || 'unknown',
      surface: entry.surface || 'unknown',
      sessionId: entry.nativeSessionId || entry.id,
      title: entry.title || entry.nativeSessionId || entry.id,
      modifiedAt: entry.importedAt,
      imported: true,
      importedAt: entry.importedAt,
      ledgerSessionId: entry.id,
      sourcePath: entry.sourcePath
    });
  }

  return rows
    .sort((left, right) => sessionTime(right) - sessionTime(left) || left.id.localeCompare(right.id))
    .slice(0, positiveLimit(options.limit, DEFAULT_SESSION_INDEX_LIMIT));
}

function normalizeProviders(providers) {
  const values = Array.isArray(providers) && providers.length > 0 ? providers : NATIVE_SESSION_PROVIDERS;
  return [...new Set(values.map(normalizeNativeProvider).filter((provider) => NATIVE_SESSION_PROVIDERS.includes(provider)))];
}

function nativeRowId(provider, normalizedPath) {
  const digest = crypto.createHash('sha256').update(`${provider}\0${normalizedPath}`).digest('hex').slice(0, 24);
  return `native:${provider}:${digest}`;
}

function sessionTime(row) {
  const value = Date.parse(row?.modifiedAt || row?.importedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
