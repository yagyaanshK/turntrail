const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

// Enough of the VS Code API for the extension module to load; nothing here is
// activated.
class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => this.listeners.push(listener);
  }
  fire(value) { for (const listener of this.listeners) listener(value); }
}
const vscode = {
  EventEmitter,
  window: {},
  workspace: {},
  commands: { executeCommand: async () => {} },
  env: {},
  Uri: { parse: (value) => value, file: (value) => value },
  ViewColumn: { Active: 1 },
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 }
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handoffPrompt } = require('../src/extension.cjs');
Module._load = originalLoad;

const HANDOFF = 'C:\\repo\\.turntrail\\exports\\2026-09-17-to-claude.md';

test('a handoff into a new chat tells it what to be called', () => {
  const prompt = handoffPrompt('claude', 'new', HANDOFF, undefined, { title: 'sorted inference', named: true });
  const lines = prompt.split('\n');
  assert.equal(lines[0], 'Start a new session using this Turntrail handoff:');
  assert.equal(lines[2], 'This chat should be named "sorted inference (handoff)".');
  assert.equal(lines[4], `\`${HANDOFF}\``);
  assert.match(lines[6], /^Read the handoff before acting\./);
});

test('every handoff prompt leaves two decisions to the user', () => {
  for (const mode of ['new', 'existing']) {
    const prompt = handoffPrompt('claude', mode, HANDOFF, { title: 'x', named: true }, { title: 'y', named: true });
    const tail = prompt.slice(prompt.indexOf('Before doing anything else:'));
    assert.match(tail, /^Before doing anything else:\n1\. Check whether `\.turntrail\/` is already tracked or ignored in this repository's git history\. If it is neither, ask the user whether to commit it or add it to `\.gitignore`/);
    assert.match(tail, /\n2\. Do not start on the task the transcript implies\. Once you have the project context, ask the user whether to continue where the source chat left off or whether there is a new standing instruction to follow, and wait for the answer\.$/);
    // The old closing clause told the agent to ask only in doubt, which is the
    // opposite of what item 2 says.
    assert.doesNotMatch(prompt, /asking only when a consequential ambiguity remains/);
  }
});

test('an unnamed source chat, whose title is only its opening request, names nothing', () => {
  const prompt = handoffPrompt('codex', 'new', HANDOFF, undefined, { title: 'fix the failing build please', named: false });
  assert.doesNotMatch(prompt, /should be named/);
  assert.doesNotMatch(handoffPrompt('codex', 'new', HANDOFF, undefined, undefined), /should be named/);
});

test('a handoff into an existing chat names the chat it continues, not a new one', () => {
  const prompt = handoffPrompt('codex', 'existing', HANDOFF, { title: 'sorted inference', named: true }, { title: 'CV final context bridge', named: true });
  assert.match(prompt, /^Continue in this existing session using this Turntrail handoff:/);
  assert.match(prompt, /This is a continuation of the chat named "sorted inference"\./);
  assert.doesNotMatch(prompt, /should be named/);
});
