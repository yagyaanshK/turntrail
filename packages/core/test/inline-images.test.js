import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importNativeSession, initStore, omitInlineImages, readAllTurns } from '../src/index.js';
import { DEFAULT_MAX_IMPORTED_CHARS } from '../src/adapters/common.js';

const PIXELS = 'iVBORw0KGgo' + 'A'.repeat(4000) + '=';
const PNG = `data:image/png;base64,${PIXELS}`;

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
