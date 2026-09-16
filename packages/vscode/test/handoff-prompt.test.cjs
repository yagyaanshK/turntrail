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
