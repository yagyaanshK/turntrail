// Which agent's limits the status bar shows.
//
// Both agents can have an account in use at once, and the bar has room for
// one. It used to show whichever came first in a fixed list, which was always
// Codex, so a Claude user watched a number that said nothing about the agent
// they were working with. The bar now follows use: the agent most recently
// seen at work in this workspace wins, where "at work" means its transcript
// was written, its terminal was focused, or its account was switched.

const PROVIDER_ORDER = ['codex', 'claude'];

// candidates: providers that have an account in use.
// activity: { codex?: ms, claude?: ms }, the last sign of use of each.
// previous: the provider shown last, kept when nothing says otherwise, so the
// bar does not flip on a refresh.
function chooseStatusProvider({ candidates = [], activity = {}, previous } = {}) {
  const live = PROVIDER_ORDER.filter((provider) => candidates.includes(provider));
  if (live.length === 0) return undefined;
  if (live.length === 1) return { provider: live[0], reason: 'only' };

  const seen = live
    .map((provider) => ({ provider, at: Number(activity[provider]) }))
    .filter((item) => Number.isFinite(item.at) && item.at > 0)
    .sort((a, b) => b.at - a.at);
  if (seen.length > 0) return { provider: seen[0].provider, reason: 'recent', at: seen[0].at };
  if (previous && live.includes(previous)) return { provider: previous, reason: 'previous' };
  return { provider: live[0], reason: 'default' };
}

// The terminal's provider when Turntrail opened it: a managed session records
// it, and an account terminal is named "<Agent> · <account>".
function terminalProvider(terminal, managedProvider) {
  if (managedProvider === 'codex' || managedProvider === 'claude') return managedProvider;
  const name = String(terminal?.name || '');
  if (name.startsWith('Claude Code · ')) return 'claude';
  if (name.startsWith('Codex · ')) return 'codex';
  return undefined;
}

module.exports = { chooseStatusProvider, terminalProvider, PROVIDER_ORDER };
