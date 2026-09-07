const DEFAULT_USAGE_STALE_MS = 6 * 60 * 60 * 1000;

const HEALTH = Object.freeze({
  healthy: { id: 'healthy', label: 'Healthy', tone: 'ok', selectionRank: 3 },
  low: { id: 'low-quota', label: 'Low quota', tone: 'warn', selectionRank: 3 },
  unknown: { id: 'quota-unknown', label: 'Quota unknown', tone: 'neutral', selectionRank: 2 },
  stale: { id: 'usage-stale', label: 'Usage stale', tone: 'warn', selectionRank: 1 },
  unavailable: { id: 'usage-unavailable', label: 'Usage unavailable', tone: 'warn', selectionRank: 1 },
  exhausted: { id: 'limit-reached', label: 'Limit reached', tone: 'crit', selectionRank: 0 },
  verification: { id: 'needs-verification', label: 'Verification required', tone: 'crit', selectionRank: 0 },
  signin: { id: 'needs-sign-in', label: 'Sign in required', tone: 'crit', selectionRank: 0 }
});

function classifyAccountHealth(row, options = {}) {
  if (row?.requiresRevalidation) return HEALTH.verification;
  if (row?.requiresSignIn || !row?.signedIn) return HEALTH.signin;
  if (row?.limitReached || row?.remaining === 0) return HEALTH.exhausted;

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleAfterMs = Number.isFinite(options.staleAfterMs)
    ? Math.max(0, options.staleAfterMs)
    : DEFAULT_USAGE_STALE_MS;
  const fetchedAt = Date.parse(row?.fetchedAt || '');
  const staleByAge = Number.isFinite(fetchedAt) && now - fetchedAt > staleAfterMs;
  if (row?.staleReason || staleByAge) return HEALTH.stale;
  if (row?.error) return HEALTH.unavailable;
  if (typeof row?.remaining !== 'number' || !Number.isFinite(row.remaining)) return HEALTH.unknown;
  if (row.remaining <= 20) return HEALTH.low;
  return HEALTH.healthy;
}

function recommendAccount(rows, options = {}) {
  const candidates = (rows || [])
    .map((row) => ({ row, health: row.health || classifyAccountHealth(row, options) }))
    .filter(({ health }) => health.selectionRank > 0)
    .sort((left, right) => {
      if (left.health.selectionRank !== right.health.selectionRank) {
        return right.health.selectionRank - left.health.selectionRank;
      }

      const leftRemaining = finiteRemaining(left.row.remaining);
      const rightRemaining = finiteRemaining(right.row.remaining);
      if (leftRemaining !== rightRemaining) return rightRemaining - leftRemaining;
      if (left.row.active !== right.row.active) return left.row.active ? -1 : 1;
      return String(left.row.id || '').localeCompare(String(right.row.id || ''));
    });
  return candidates[0]?.row;
}

function finiteRemaining(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

module.exports = {
  DEFAULT_USAGE_STALE_MS,
  HEALTH,
  classifyAccountHealth,
  recommendAccount
};
