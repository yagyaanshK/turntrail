const fs = require('node:fs');
const path = require('node:path');

// The last time each agent was seen at work in this workspace.
//
// Claude Code and Codex append to a JSONL transcript as a conversation runs,
// so a write to one of them is the plainest sign of which agent is in use. The
// store's folders are watched, and a write counts only when the transcript
// belongs to this workspace; that is decided once per file by the caller's
// `isWorkspaceTranscript`, which reads the file's recorded working directory.
// Other signs of use, a terminal focused or an account switched, are recorded
// directly.
class AgentActivity {
  constructor(options = {}) {
    this.isWorkspaceTranscript = options.isWorkspaceTranscript || (async () => true);
    this.watch = options.watch || fs.watch;
    this.exists = options.exists || fs.existsSync;
    this.now = options.now || Date.now;
    this.times = {};
    this.listeners = [];
    this.watchers = [];
    this.verdicts = new Map();
  }

  onDidChange(listener) {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((item) => item !== listener); } };
  }

  latest() {
    return { ...this.times };
  }

  // Only ever moves forward, so a late-arriving older signal cannot undo a newer one.
  record(provider, at = this.now()) {
    if (provider !== 'codex' && provider !== 'claude') return false;
    if (!Number.isFinite(at) || (this.times[provider] || 0) >= at) return false;
    this.times[provider] = at;
    for (const listener of this.listeners) {
      try { listener(this.latest()); } catch { /* a listener's failure is its own */ }
    }
    return true;
  }

  // dirs: { claude: [projectsDir, ...], codex: [sessionsDir, ...] }. Replaces
  // whatever was watched before. An agent that has never run has no such
  // folder yet; its parent (`~/.claude`, `~/.codex`) is watched instead and
  // only writes beneath the intended folder count. With neither, it is skipped
  // until the next call.
  watchDirs(dirs = {}) {
    this.disposeWatchers();
    for (const provider of ['claude', 'codex']) {
      for (const dir of [...new Set(dirs[provider] || [])]) {
        let root = dir;
        let prefix = '';
        if (!this.exists(dir)) {
          const parent = path.dirname(dir);
          if (!this.exists(parent)) continue;
          root = parent;
          prefix = path.basename(dir);
        }
        try {
          const watcher = this.watch(root, { recursive: true, persistent: false }, (event, filename) => {
            if (!filename) return;
            const relative = String(filename);
            if (prefix && relative.split(/[\\/]/)[0] !== prefix) return;
            this.noticeWrite(provider, path.join(root, relative));
          });
          watcher.on?.('error', () => watcher.close?.());
          this.watchers.push(watcher);
        } catch {
          // A platform without recursive watching.
        }
      }
    }
    return this.watchers.length;
  }

  async noticeWrite(provider, file) {
    if (!/\.jsonl$/i.test(file)) return false;
    const at = this.now();
    let verdict = this.verdicts.get(file);
    if (verdict === undefined) {
      verdict = Promise.resolve()
        .then(() => this.isWorkspaceTranscript(provider, file))
        .then(Boolean, () => false);
      this.verdicts.set(file, verdict);
      if (this.verdicts.size > 2000) this.verdicts.delete(this.verdicts.keys().next().value);
    }
    return (await verdict) ? this.record(provider, at) : false;
  }

  disposeWatchers() {
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.watchers = [];
  }

  dispose() {
    this.disposeWatchers();
    this.listeners = [];
  }
}

module.exports = { AgentActivity };
