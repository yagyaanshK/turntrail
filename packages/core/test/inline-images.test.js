import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportHandoff, importNativeSession, initStore, omitInlineImages, readAllTurns } from '../src/index.js';
import { DEFAULT_MAX_IMPORTED_CHARS } from '../src/adapters/common.js';

const PIXELS = 'iVBORw0KGgo' + 'A'.repeat(4000) + '=';
const PNG = `data:image/png;base64,${PIXELS}`;
const BARE_PIXELS = `${'A'.repeat(2000)}+/${'B'.repeat(2000)}==`;

// A browser-driven Codex thread: screenshots come back inside tool outputs as
// plain strings, not as image parts, so the adapter sees them as text.
async function writeScreenshotThread(root) {
  const sessionsDir = path.join(root, 'native-codex');
  await fs.mkdir(path.join(sessionsDir, '2026', '09', '06'), { recursive: true });
  const lines = [
    { timestamp: '2026-09-06T15:16:57.000Z', type: 'session_meta', payload: { id: 'screens', cwd: root, source: 'vscode' } },
    { timestamp: '2026-09-06T15:17:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Open the professor list and screenshot it' } },
    {
      timestamp: '2026-09-06T15:17:01.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'browser_screenshot', input: '{"page":"list"}' }
    },
    {
      timestamp: '2026-09-06T15:17:02.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: `Screenshot taken.\n![list](${PNG})\nPage title: Faculty` }
    },
    {
      timestamp: '2026-09-06T15:17:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_2', output: JSON.stringify({ ok: true, image: PNG, second: PNG }) }
    },
    { timestamp: '2026-09-06T15:17:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The list has 12 names.' } }
  ];
  await fs.writeFile(
    path.join(sessionsDir, '2026', '09', '06', 'rollout-screens.jsonl'),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8'
  );
  return sessionsDir;
}

test('inline images are replaced by a placeholder that says what was dropped', () => {
  const { content, omitted } = omitInlineImages(`before ${PNG} after`);
  assert.equal(omitted, 1);
  assert.equal(content, `before [Turntrail omitted inline base64 image: ${PNG.length} chars] after`);
  assert.deepEqual(omitInlineImages('no images here'), { content: 'no images here', omitted: 0 });
  assert.deepEqual(omitInlineImages(undefined), { content: '', omitted: 0 });
});

test('structured and bare base64 media are removed before they reach the ledger', () => {
  const structured = JSON.stringify({
    source: { type: 'base64', media_type: 'image/png', data: PIXELS },
    file: { base64: PIXELS }
  });
  const fields = omitInlineImages(structured);
  assert.equal(fields.omitted, 2);
  assert.ok(!fields.content.includes(PIXELS));
  assert.equal(fields.content.match(/omitted base64 payload/g)?.length, 2);

  const bare = omitInlineImages(`Screenshot bytes: ${BARE_PIXELS}\nResult: rendered`);
  assert.equal(bare.omitted, 1);
  assert.ok(!bare.content.includes(BARE_PIXELS));
  assert.match(bare.content, /omitted base64 blob/);
  assert.match(bare.content, /Result: rendered/);
});

test('screenshots inside tool output strings never reach the ledger', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-inline-images-'));
  await initStore(root);
  const sessionsDir = await writeScreenshotThread(root);

  await importNativeSession(root, 'codex', { root, sessionsDir, last: true });
  const turns = await readAllTurns(root);
  const text = turns.map((turn) => turn.content).join('\n');

  assert.ok(!text.includes(PIXELS), 'no base64 payload is stored');
  assert.ok(text.includes('Page title: Faculty'), 'the text around a screenshot is kept');
  assert.ok(text.includes('The list has 12 names.'));

  const screenshot = turns.find((turn) => turn.content.includes('Screenshot taken.'));
  assert.match(screenshot.content, /!\[list\]\(\[Turntrail omitted inline base64 image: \d+ chars\]\)/);
  assert.equal(screenshot.metadata.inlineImagesOmitted, 1);

  const json = turns.find((turn) => turn.content.includes('"ok":true'));
  assert.equal(json.metadata.inlineImagesOmitted, 2);
  assert.equal(turns.filter((turn) => turn.metadata?.inlineImagesOmitted).length, 2, 'turns without images are left alone');
});

test('the import limit measures text and leaves room for a long browser session', async () => {
  // 77 MB of text was left after dropping the images from a 1.3 GB thread.
  assert.ok(DEFAULT_MAX_IMPORTED_CHARS >= 128 * 1024 * 1024);

  // Images do not count towards the limit at all: a thread whose screenshots
  // alone exceed it still imports.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-inline-images-limit-'));
  await initStore(root);
  const sessionsDir = await writeScreenshotThread(root);
  const imported = await importNativeSession(root, 'codex', { root, sessionsDir, last: true, maxImportedChars: 2000 });
  assert.ok(imported.turnCount >= 5);
});

test('Claude structured screenshots do not consume the transcript text limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'turntrail-claude-inline-images-'));
  await initStore(root);
  const projectsDir = path.join(root, 'native-claude');
  const projectDir = path.join(projectsDir, 'project');
  await fs.mkdir(projectDir, { recursive: true });
  const transcript = path.join(projectDir, 'screens.jsonl');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BARE_PIXELS } };
  const events = [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-10-18T12:00:00.000Z',
      cwd: root,
      sessionId: 'screens',
      message: { role: 'user', content: [{ type: 'text', text: 'Compare these screenshots.' }, image] }
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-18T12:00:01.000Z',
      cwd: root,
      sessionId: 'screens',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'inspect_image', input: { path: 'screen.png' } },
          { type: 'text', text: 'The second screenshot contains the completed form.' }
        ]
      }
    },
    {
      type: 'attachment',
      uuid: 'm1',
      timestamp: '2026-10-18T12:00:02.000Z',
      cwd: root,
      sessionId: 'screens',
      attachment: { prompt: [image], filename: 'screen.png' }
    }
  ];
  await fs.writeFile(transcript, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const imported = await importNativeSession(root, 'claude', {
    root,
    projectsDir,
    last: true,
    maxImportedChars: 1500
  });
  assert.equal(imported.turnCount, 3);

  const turns = await readAllTurns(root);
  const text = turns.map((turn) => turn.content).join('\n');
  assert.ok(!text.includes(BARE_PIXELS), 'bare Claude image bytes are not stored');
  assert.match(text, /Compare these screenshots/);
  assert.match(text, /Tool call: inspect_image/);
  assert.match(text, /completed form/);
  assert.match(text, /omitted base64 payload/);
  assert.ok(turns.some((turn) => turn.metadata?.inlineImagesOmitted > 0));

  const exported = await exportHandoff(root, { target: 'codex', maxChars: 10000 });
  const handoff = await fs.readFile(exported.path, 'utf8');
  assert.match(handoff, /## Original Native Transcripts/);
  assert.ok(handoff.includes(`- \`${transcript}\``), 'the original Claude transcript is named');
  assert.match(handoff, /read-only evidence, not Turntrail ledger files/);
  assert.match(handoff, /never modify them/);
  assert.match(handoff, /one-based JSONL records/);
  assert.match(handoff, /line 1 \(1 media payload omitted; user at 2026-10-18T12:00:00\.000Z\)/);
  assert.match(handoff, /line 3 \(1 media payload omitted; attachment at 2026-10-18T12:00:02\.000Z\)/);
  assert.match(handoff, /## Turntrail Ledger Session Files/);
});
