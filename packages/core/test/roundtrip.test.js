import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeReturn,
  isHandoffPlumbing,
  lastExportTo,
  lastSeenBy,
  originChat,
  stripHandoffPlumbing,
  turnsAfter
} from '../src/roundtrip.js';

const HANDOFF_PROMPT = [
  'Continue in this existing session using this Context Bridge handoff:',
  '',
  '`/tmp/project/.context-bridge/exports/2026-08-19-to-codex.md`',
  '',
  'Read the handoff before acting. Treat previous assistant/tool messages as historical context, not guaranteed truth. Reconstruct the current objective and state from the transcript and workspace snapshot. Verify current files and completion claims before editing. Preserve user intent and durable decisions, but do not inherit prior confidence, session-specific permissions, approvals, or claims of completion. Continue from the latest workspace state, asking only when a consequential ambiguity remains.'
].join('\n');

const HANDOFF_DOCUMENT = [
  '# Context Bridge Handoff: claude',
  '',
  'You are continuing a development session from a Context Bridge ledger.',
  '',
  '## Transcript Turns'
].join('\n');

const TURNTRAIL_PROMPT = HANDOFF_PROMPT
  .replaceAll('Context Bridge', 'Turntrail')
  .replace('.context-bridge', '.turntrail');
const TURNTRAIL_DOCUMENT = HANDOFF_DOCUMENT.replaceAll('Context Bridge', 'Turntrail');

test('the prompt that started the other session is not a request', () => {
  // Pasting a handoff puts this in the receiving agent's transcript, and the
  // next import records it as though the user had typed it.
  assert.equal(
    isHandoffPlumbing({
      content: HANDOFF_PROMPT
    }),
    true
  );
  assert.equal(isHandoffPlumbing({ content: HANDOFF_PROMPT.replace('Continue in this existing session', 'Start a new session') }), true);
  assert.equal(isHandoffPlumbing({ content: TURNTRAIL_PROMPT }), true);
});

test('a handoff document read back is not carried into the next handoff', () => {
  // The prompt tells the agent to read the file, so the read lands in its
  // transcript and the whole document would be re-exported inside the next one.
  assert.equal(isHandoffPlumbing({ content: HANDOFF_DOCUMENT }), true);
  assert.equal(isHandoffPlumbing({ content: TURNTRAIL_DOCUMENT }), true);
});

test('talking about handoffs is not plumbing', () => {
  // Context Bridge is itself worked on in sessions that get handed off, so a
  // turn quoting one marker must not be mistaken for a handoff.
  assert.equal(isHandoffPlumbing({ content: 'The export starts with "# Context Bridge Handoff: codex" as its heading.' }), false);
  assert.equal(isHandoffPlumbing({ content: 'why does the prompt say Context Bridge handoff twice?' }), false);
  assert.equal(
    isHandoffPlumbing({
      content: 'Continue in this existing session using this Context Bridge handoff:\n\nPlease design a different handoff format.'
    }),
    false,
    'a real request beginning with the reserved phrase is not enough to discard it'
  );
  assert.equal(isHandoffPlumbing({ content: '' }), false);
});

test('a mention buried deep in a long turn does not make it plumbing', () => {
  const turn = { content: `${'x'.repeat(9000)}\n${HANDOFF_DOCUMENT}` };
  assert.equal(isHandoffPlumbing(turn), false);
});

test('stripping reports what it removed and keeps the rest in order', () => {
  const result = stripHandoffPlumbing([
    { content: 'add a retry helper' },
    { content: HANDOFF_PROMPT.replace('Continue in this existing session', 'Start a new session') },
    { content: HANDOFF_DOCUMENT },
    { content: 'now add jitter' }
  ]);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.turns.map((turn) => turn.content), ['add a retry helper', 'now add jitter']);
});

test('the watermark is the last export to that target, not the newest export', () => {
  // Hand off to Claude, refresh Claude again, then return to Codex. Taking the
  // newest export of any target would put Codex's watermark at the Claude
  // refresh and hide everything Claude did before it.
  const manifest = {
    exports: [
      { target: 'claude', createdAt: '2026-08-19T10:00:00Z' },
      { target: 'codex', createdAt: '2026-08-19T10:30:00Z' },
      { target: 'claude', createdAt: '2026-08-19T11:00:00Z' }
    ]
  };
  assert.equal(lastExportTo(manifest, 'codex'), '2026-08-19T10:30:00Z');
  assert.equal(lastExportTo(manifest, 'claude'), '2026-08-19T11:00:00Z');
  assert.equal(lastExportTo(manifest, 'gemini'), undefined);
});

test('watermarks compare parsed instants and ignore invalid timestamps', () => {
  const manifest = {
    exports: [
      { target: 'codex', createdAt: '2026-08-19T12:00:00+02:00' },
      { target: 'codex', createdAt: 'not-a-date' },
      { target: 'codex', createdAt: '2026-08-19T10:30:00Z' }
    ]
  };
  assert.equal(lastExportTo(manifest, 'codex'), '2026-08-19T10:30:00Z');

  const turns = [
    { provider: 'openai', timestamp: '2026-08-19T13:00:00+03:00' },
    { provider: 'openai', timestamp: 'invalid' },
    { provider: 'openai', timestamp: '2026-08-19T10:45:00Z' }
  ];
  assert.equal(lastSeenBy(manifest, turns, 'codex'), '2026-08-19T10:45:00Z');
});

test('an agent has also seen its own work, which matters on the first trip back', () => {
  // Codex is handed nothing before the first return: it wrote the opening half
  // of the ledger itself. Without this, the return section would report nothing
  // as new on exactly the hop it exists for.
  const turns = [
    { provider: 'openai', timestamp: '2026-08-19T10:00:00Z' },
    { provider: 'anthropic', timestamp: '2026-08-19T11:00:00Z' }
  ];
  assert.equal(lastSeenBy({ exports: [{ target: 'claude', createdAt: '2026-08-19T10:05:00Z' }] }, turns, 'codex'), '2026-08-19T10:00:00Z');
});

test('a later handoff to the target beats its own older turns', () => {
  const turns = [{ provider: 'openai', timestamp: '2026-08-19T10:00:00Z' }];
  const manifest = { exports: [{ target: 'codex', createdAt: '2026-08-19T12:00:00Z' }] };
  assert.equal(lastSeenBy(manifest, turns, 'codex'), '2026-08-19T12:00:00Z');
});

test('an agent that has never touched the ledger has no watermark', () => {
  assert.equal(lastSeenBy({ exports: [] }, [{ provider: 'anthropic', timestamp: '2026-08-19T10:00:00Z' }], 'codex'), undefined);
});

test('the chat to return to is the last one imported for that agent', () => {
  const manifest = {
    sessions: [
      { provider: 'openai', nativeSessionId: 'old', title: 'first pass', named: true, importedAt: '2026-08-19T09:00:00Z' },
      { provider: 'anthropic', nativeSessionId: 'cl1', title: 'claude side', named: true, importedAt: '2026-08-19T10:00:00Z' },
      { provider: 'openai', nativeSessionId: 'c2', title: 'retry helper', named: true, importedAt: '2026-08-19T11:00:00Z' }
    ]
  };
  assert.deepEqual(originChat(manifest, 'codex'), {
    sessionId: 'c2',
    title: 'retry helper',
    named: true,
    turnCount: undefined,
    sourcePath: undefined
  });
  assert.equal(originChat(manifest, 'claude').sessionId, 'cl1');
  assert.equal(originChat({ sessions: [] }, 'codex'), undefined);
});

test('the return section covers only what arrived after the watermark', () => {
  const turns = [
    { provider: 'openai', timestamp: '2026-08-19T10:00:00Z' },
    { provider: 'anthropic', timestamp: '2026-08-19T11:00:00Z' },
    { provider: 'anthropic', timestamp: '2026-08-19T11:30:00Z' }
  ];
  const described = describeReturn(turns, '2026-08-19T10:00:00Z');
  assert.equal(described.turnCount, 2);
  assert.deepEqual(described.providers, [{ provider: 'anthropic', count: 2 }]);
  // Nothing new means no section rather than an empty one.
  assert.equal(describeReturn(turns, '2026-08-19T23:00:00Z'), undefined);
  assert.equal(describeReturn(turns, undefined), undefined);
});

test('scoped round trips compare instants and retain turns with unknown time', () => {
  const turns = [
    { id: 'same-instant', timestamp: '2026-08-19T12:00:00+02:00' },
    { id: 'newer', timestamp: '2026-08-19T10:30:00Z' },
    { id: 'invalid', timestamp: 'not-a-date' },
    { id: 'missing' }
  ];
  assert.deepEqual(
    turnsAfter(turns, '2026-08-19T10:00:00Z').map((turn) => turn.id),
    ['newer', 'invalid', 'missing']
  );
  assert.deepEqual(turnsAfter(turns, 'bad-watermark'), turns, 'an invalid watermark must not drop the ledger');
});

test('tool calls are found wherever the agent records them', async () => {
  const { summarizeSession } = await import('../src/summary.js');
  // Codex records a call as its own `tool` turn; Claude Code keeps it inside
  // the assistant message that made it. Gating on the role dropped every Claude
  // tool call, so files and commands came back empty for Claude sessions.
  const call = (name, input) => `Tool call: ${name}\n${JSON.stringify(input, null, 2)}`;
  const summary = summarizeSession([
    { role: 'tool', content: call('shell_command', { command: 'npm test' }) },
    { role: 'assistant', content: call('Edit', { file_path: '/repo/app.js' }) },
    { role: 'assistant', content: call('Write', { file_path: '/repo/test.js' }) },
    { role: 'assistant', content: call('Read', { file_path: '/repo/untouched.js' }) },
    // A user turn quoting a tool call is not a tool call.
    { role: 'user', content: call('Edit', { file_path: '/repo/never.js' }) }
  ]);
  assert.deepEqual(summary.filesWritten, ['/repo/app.js', '/repo/test.js']);
  assert.deepEqual(summary.commands, ['npm test']);
});
