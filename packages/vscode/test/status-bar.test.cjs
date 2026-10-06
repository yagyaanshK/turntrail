const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chooseStatusProvider, terminalProvider } = require('../src/status-choice.cjs');
const { AgentActivity } = require('../src/agent-activity.cjs');

test('the bar follows the agent used most recently, not the first in a list', () => {
  const both = ['codex', 'claude'];
  // The reported bug: with both signed in the bar always said Codex.
  assert.deepEqual(chooseStatusProvider({ candidates: both, activity: { claude: 2000, codex: 1000 } }), {
    provider: 'claude',
    reason: 'recent',
    at: 2000
  });
  assert.equal(chooseStatusProvider({ candidates: both, activity: { claude: 1000, codex: 2000 } }).provider, 'codex');
  // Activity of an agent with no account in use cannot win the bar.
  assert.equal(chooseStatusProvider({ candidates: ['codex'], activity: { claude: 9999 } }).provider, 'codex');
});

test('with nothing to go on the bar keeps what it showed, then falls back in order', () => {
  const both = ['claude', 'codex'];
  assert.deepEqual(chooseStatusProvider({ candidates: both, previous: 'claude' }), { provider: 'claude', reason: 'previous' });
  assert.deepEqual(chooseStatusProvider({ candidates: both }), { provider: 'codex', reason: 'default' });
  assert.deepEqual(chooseStatusProvider({ candidates: ['claude'] }), { provider: 'claude', reason: 'only' });
  assert.equal(chooseStatusProvider({ candidates: [] }), undefined);
  // A previous choice that no longer has an account is ignored.
  assert.equal(chooseStatusProvider({ candidates: ['codex'], previous: 'claude' }).provider, 'codex');
  // Garbage timestamps count as no activity.
  assert.equal(chooseStatusProvider({ candidates: both, activity: { claude: NaN, codex: 0 }, previous: 'claude' }).reason, 'previous');
});

test('a terminal says which agent it belongs to only when Turntrail opened it', () => {
  assert.equal(terminalProvider({ name: 'anything' }, 'claude'), 'claude');
  assert.equal(terminalProvider({ name: 'Claude Code · jha' }), 'claude');
  assert.equal(terminalProvider({ name: 'Codex · primary' }), 'codex');
  assert.equal(terminalProvider({ name: 'pwsh' }), undefined);
  assert.equal(terminalProvider(undefined), undefined);
});

test('activity only moves forward and tells its listeners', () => {
  const activity = new AgentActivity({ now: () => 5000 });
  const seen = [];
  activity.onDidChange((latest) => seen.push(latest));
  assert.equal(activity.record('claude', 3000), true);
  assert.equal(activity.record('claude', 2000), false, 'an older signal does not undo a newer one');
  assert.equal(activity.record('codex'), true);
  assert.equal(activity.record('gemini', 9000), false);
  assert.deepEqual(activity.latest(), { claude: 3000, codex: 5000 });
  assert.equal(seen.length, 2);
});

test('a transcript write counts once its file is known to belong to this workspace', async () => {
  let clock = 1000;
  const asked = [];
  const activity = new AgentActivity({
    now: () => clock,
    isWorkspaceTranscript: async (provider, file) => {
      asked.push(path.basename(file));
      return file.includes('this-project');
    }
  });

  assert.equal(await activity.noticeWrite('claude', path.join('projects', 'this-project', 'a.jsonl')), true);
  clock = 2000;
  assert.equal(await activity.noticeWrite('claude', path.join('projects', 'this-project', 'a.jsonl')), true);
  assert.equal(await activity.noticeWrite('codex', path.join('sessions', 'other', 'b.jsonl')), false);
  assert.equal(await activity.noticeWrite('codex', path.join('sessions', 'other', 'notes.txt')), false);
  assert.deepEqual(activity.latest(), { claude: 2000 });
  // The workspace question is asked once per file, not once per write.
  assert.deepEqual(asked, ['a.jsonl', 'b.jsonl']);

  // A check that fails counts as "not this workspace", never as an error.
  const failing = new AgentActivity({ isWorkspaceTranscript: async () => { throw new Error('unreadable'); } });
  assert.equal(await failing.noticeWrite('claude', 'x.jsonl'), false);
});

test('the transcript folders are watched recursively and a missing one is skipped', async () => {
  const calls = [];
  const fake = (dir, options, listener) => {
    if (dir.includes('missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    calls.push({ dir, options, listener });
    return { close() { this.closed = true; }, on() {} };
  };
  const exists = (dir) => !dir.includes('missing');
  const activity = new AgentActivity({ watch: fake, exists, now: () => 7000, isWorkspaceTranscript: async () => true });
  const watched = activity.watchDirs({
    claude: ['claude-projects', 'claude-projects'],
    codex: ['codex-sessions', path.join('missing-home', 'sessions')]
  });
  assert.equal(watched, 2, 'duplicates collapse and a folder with no parent either is skipped');
  assert.deepEqual(calls.map((call) => [call.dir, call.options.recursive]), [['claude-projects', true], ['codex-sessions', true]]);

  calls[1].listener('change', path.join('2026', '10', '07', 'rollout-x.jsonl'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(activity.latest(), { codex: 7000 });

  activity.dispose();
  assert.equal(activity.watchers.length, 0);
});

test('an agent that has never run is watched through its home until its folder appears', async () => {
  const calls = [];
  const fake = (dir, options, listener) => { calls.push({ dir, listener }); return { close() {}, on() {} }; };
  const home = path.join('fixture', '.claude');
  const projects = path.join(home, 'projects');
  // `projects` does not exist yet; `~/.claude` does.
  const activity = new AgentActivity({ watch: fake, exists: (dir) => dir === home, now: () => 9000, isWorkspaceTranscript: async () => true });
  assert.equal(activity.watchDirs({ claude: [projects] }), 1);
  assert.equal(calls[0].dir, home);

  // Writes elsewhere in the agent's home are not transcripts.
  calls[0].listener('change', path.join('todos', 'x.jsonl'));
  calls[0].listener('change', 'history.jsonl');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(activity.latest(), {});

  calls[0].listener('rename', path.join('projects', 'd--work', 'session.jsonl'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(activity.latest(), { claude: 9000 });
});

test('the manifest contributes both logos from a font that exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const icons = manifest.contributes.icons;
  assert.deepEqual(Object.keys(icons).sort(), ['turntrail-claude', 'turntrail-openai']);
  for (const icon of Object.values(icons)) {
    assert.match(icon.default.fontCharacter, /^\\E00[01]$/);
    assert.ok(fs.statSync(path.join(__dirname, '..', icon.default.fontPath)).size > 0);
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.cjs'), 'utf8');
  assert.match(source, /claude: '\$\(turntrail-claude\)', codex: '\$\(turntrail-openai\)'/);
});
