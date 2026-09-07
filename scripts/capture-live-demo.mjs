import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const root = process.cwd();
const port = Number(process.env.TURNTRAIL_CAPTURE_PORT || 9333);
const fixture = JSON.parse(await fs.readFile(path.join(root, '.marketing-capture', 'fixture.json'), 'utf8'));
const outputDir = path.join(root, '.marketing-capture', 'live-demo');
const rawVideo = path.join(outputDir, 'turntrail-live-ui.mkv');
const timelinePath = path.join(outputDir, 'timeline.json');
const width = 1920;
const height = 1080;
const captureFps = 12;
const durationSeconds = 36;

await fs.mkdir(outputDir, { recursive: true });
await freshenQuotaCaches(fixture.home);

const targets = await CDP.List({ port });
const pageTarget = targets.find((target) => target.type === 'page' && /Visual Studio Code/i.test(target.title));
if (!pageTarget) {
  throw new Error(`No isolated VS Code workbench found on port ${port}. See docs/SHORT_DEMO_VIDEO.md.`);
}

execFileSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'maximize-capture-window.ps1'),
  '-Port', String(port)
], { cwd: root, stdio: 'inherit' });

const workbench = await CDP({ target: pageTarget, port });
await workbench.Page.enable();

const timeline = {
  schemaVersion: 1,
  width,
  height,
  captureFps,
  durationSeconds,
  cursorKeyframes: [
    point(0, 1280, 600),
    point(1.1, 1280, 600),
    point(2.85, 225, 350),
    point(3.15, 225, 350),
    point(4.05, 260, 391),
    point(4.35, 260, 391),
    point(5.05, 510, 423),
    point(5.35, 510, 423),
    point(6.05, 260, 454),
    point(6.35, 260, 454),
    point(7.75, 350, 486),
    point(8.15, 350, 486),
    point(10.2, 1050, 210),
    point(14.8, 1460, 720),
    point(17.9, 110, 1045),
    point(18.7, 110, 1045),
    point(21.8, 675, 555),
    point(24.7, 690, 870),
    point(27.2, 340, 430),
    point(31.4, 135, 650),
    point(35.8, 1050, 900)
  ],
  clicks: [3, 4.2, 5.2, 6.2, 7.95, 18.45],
  actions: [
    { at: 3, id: 'expand-session-handoff' },
    { at: 4.2, id: 'target-claude' },
    { at: 5.2, id: 'existing-session' },
    { at: 6.2, id: 'clipboard-delivery' },
    { at: 7.95, id: 'create-handoff' },
    { at: 18.45, id: 'open-accounts' },
    { at: 24.9, id: 'scroll-to-claude' }
  ]
};

try {
  await prepareWorkbench();
  await workbench.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
  await wait(500);
  const recorder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(captureFps),
    '-vcodec', 'mjpeg',
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'ffv1',
    '-level', '3',
    rawVideo
  ], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'], shell: false });
  const recorderDone = childResult(recorder);

  const frameCount = durationSeconds * captureFps;
  let actionIndex = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const time = frame / captureFps;
    while (timeline.actions[actionIndex] && timeline.actions[actionIndex].at <= time + 0.0001) {
      await performAction(timeline.actions[actionIndex].id);
      actionIndex += 1;
      await wait(100);
    }
    const screenshot = await workbench.Page.captureScreenshot({
      format: 'jpeg',
      quality: 92,
      fromSurface: true,
      captureBeyondViewport: false
    });
    await write(recorder.stdin, Buffer.from(screenshot.data, 'base64'));
  }
  recorder.stdin.end();
  await recorderDone;
  await fs.writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, 'utf8');
} finally {
  await workbench.close();
}

console.log(`Captured live Turntrail UI to ${rawVideo}`);
console.log(`Cursor and click timeline: ${timelinePath}`);

async function prepareWorkbench() {
  await dismissStartupOverlays(workbench);
  const secondaryVisible = await evaluate(workbench, `(() => {
    const sidebar = document.querySelector('.part.auxiliarybar');
    const rect = sidebar?.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  })()`);
  if (!secondaryVisible) await key(workbench, 'b', 'KeyB', 66, 3);
  await key(workbench, '0', 'Digit0', 48, 2);
  await closeAllEditors(workbench);
  await evaluate(workbench, `
    if (!document.querySelector('[aria-label="Sessions Section"]')) {
      document.querySelector('a[aria-label="Turntrail"]')?.click();
    }
  `);
  await wait(900);
  await openQuick(workbench, 'app.js');
  await resizePrimarySidebar(workbench, 600);
  await resizeAuxiliarySidebar(workbench, 360);
  await setPaneState({ sessions: true, accounts: false });
  await scrollWebview('Managed CLI', 0);
  await collapseSessionHandoff('Refactor the analytics dashboard');
  await dismissNotifications(workbench);
  await wait(700);
}

async function dismissStartupOverlays(client) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const visible = await evaluate(client, `(() => {
      const overlay = document.querySelector('.onboarding-a-overlay.visible');
      if (!overlay) return false;
      overlay.querySelector('.onboarding-a-close-btn, button[aria-label="Close"]')?.click();
      return true;
    })()`);
    if (!visible) return;
    await wait(200);
  }
  const stillVisible = await evaluate(client, `Boolean(document.querySelector('.onboarding-a-overlay.visible'))`);
  if (stillVisible) throw new Error('VS Code startup overlay could not be dismissed.');
}

async function resizeAuxiliarySidebar(client, desiredWidth) {
  const rect = await evaluate(client, `(() => {
    const sidebar = document.querySelector('.part.auxiliarybar');
    if (!sidebar) return null;
    const value = sidebar.getBoundingClientRect();
    return {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      viewportWidth: document.documentElement.clientWidth
    };
  })()`);
  if (!rect || rect.width === 0) throw new Error('Auxiliary sidebar was not found.');
  const startX = Math.round(rect.x);
  const endX = Math.round(rect.viewportWidth - desiredWidth);
  const y = Math.round(rect.y + Math.min(220, rect.height / 2));
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: endX, y, button: 'left', buttons: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: endX, y, button: 'left', buttons: 0, clickCount: 1 });
  await wait(400);
}

async function performAction(id) {
  if (id === 'expand-session-handoff') return clickSessionAction('Refactor the analytics dashboard', 'handoff');
  if (id === 'target-claude') return clickChoice('target', 'claude');
  if (id === 'existing-session') return clickChoice('mode', 'existing');
  if (id === 'clipboard-delivery') return clickChoice('delivery', 'clipboard');
  if (id === 'create-handoff') return createSessionHandoff('Refactor the analytics dashboard');
  if (id === 'open-accounts') return setPaneState({ sessions: false, accounts: true });
  if (id === 'scroll-to-claude') return scrollWebview('Usage remaining', 760, true);
  throw new Error(`Unknown demo action: ${id}`);
}

async function clickSessionAction(title, action) {
  const client = await sessionClient(title);
  try {
    const clicked = await evaluate(client, `(() => {
      const doc = document.getElementById('active-frame')?.contentDocument;
      const cards = [...(doc?.querySelectorAll('article.session') || [])];
      const card = cards.find((item) => item.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)});
      const button = card?.querySelector('[data-act=${JSON.stringify(action)}]');
      button?.focus();
      button?.click();
      return Boolean(button);
    })()`);
    if (!clicked) throw new Error(`Could not click ${action} for ${title}.`);
  } finally {
    await client.close();
  }
}

async function clickChoice(group, value) {
  const client = await sessionClient('Refactor the analytics dashboard');
  try {
    const clicked = await evaluate(client, `(() => {
      const button = document.getElementById('active-frame')?.contentDocument
        ?.querySelector('[data-choice=${JSON.stringify(group)}][data-value=${JSON.stringify(value)}]');
      button?.focus();
      button?.click();
      return Boolean(button);
    })()`);
    if (!clicked) throw new Error(`Could not select ${group}=${value}.`);
  } finally {
    await client.close();
  }
}

async function createSessionHandoff(title) {
  const client = await sessionClient(title);
  try {
    const clicked = await evaluate(client, `(() => {
      const doc = document.getElementById('active-frame')?.contentDocument;
      const cards = [...(doc?.querySelectorAll('article.session') || [])];
      const card = cards.find((item) => item.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)});
      const button = card?.querySelector('[data-act="create-handoff"]');
      button?.focus();
      button?.click();
      return Boolean(button);
    })()`);
    if (!clicked) throw new Error(`Could not create handoff for ${title}.`);
  } finally {
    await client.close();
  }
}

async function collapseSessionHandoff(title) {
  const client = await sessionClient(title);
  try {
    await evaluate(client, `(() => {
      const doc = document.getElementById('active-frame')?.contentDocument;
      const cards = [...(doc?.querySelectorAll('article.session') || [])];
      const card = cards.find((item) => item.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)});
      if (card?.querySelector('.handoff-controls')) card.querySelector('[data-act="handoff"]')?.click();
    })()`);
  } finally {
    await client.close();
  }
}

async function sessionClient(expectedText) {
  return CDP({ target: await webviewTarget(expectedText), port });
}

async function webviewTarget(expectedText) {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const target of (await CDP.List({ port })).filter((item) => item.type === 'iframe')) {
      const client = await CDP({ target, port });
      try {
        const contents = await evaluate(client, `document.getElementById('active-frame')?.contentDocument?.body?.innerText || ''`);
        if (contents.includes(expectedText)) return target;
      } finally {
        await client.close();
      }
    }
    await wait(250);
  }
  throw new Error(`Turntrail webview containing "${expectedText}" was not found.`);
}

async function setPaneState(state) {
  await evaluate(workbench, `(() => {
    const sessions = document.querySelector('[aria-label="Sessions Section"]');
    const accounts = document.querySelector('[aria-label="Accounts Section"]');
    if (sessions && sessions.classList.contains('expanded') !== ${Boolean(state.sessions)}) sessions.click();
    if (accounts && accounts.classList.contains('expanded') !== ${Boolean(state.accounts)}) accounts.click();
  })()`);
  await wait(500);
}

async function scrollWebview(text, top, smooth = false) {
  const client = await CDP({ target: await webviewTarget(text), port });
  try {
    await evaluate(client, `(() => {
      const doc = document.getElementById('active-frame')?.contentDocument;
      doc?.scrollingElement?.scrollTo({ top: ${Number(top)}, behavior: ${JSON.stringify(smooth ? 'smooth' : 'instant')} });
    })()`);
  } finally {
    await client.close();
  }
}

async function resizePrimarySidebar(client, desiredWidth) {
  const rect = await evaluate(client, `(() => {
    const sidebar = document.querySelector('.part.sidebar.left');
    if (!sidebar) return null;
    const value = sidebar.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  })()`);
  if (!rect) throw new Error('Primary sidebar was not found.');
  const startX = Math.round(rect.x + rect.width);
  const endX = Math.round(rect.x + desiredWidth);
  const y = Math.round(rect.y + Math.min(220, rect.height / 2));
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: startX, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: startX, y, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: endX, y, button: 'left', buttons: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: endX, y, button: 'left', buttons: 0, clickCount: 1 });
  await wait(400);
}

async function openQuick(client, query) {
  await key(client, 'Escape', 'Escape', 27, 0);
  await key(client, 'p', 'KeyP', 80, 2);
  await wait(200);
  await client.Input.insertText({ text: query });
  await wait(500);
  await key(client, 'Enter', 'Enter', 13, 0);
  await wait(700);
}

async function closeAllEditors(client) {
  await key(client, 'k', 'KeyK', 75, 2);
  await wait(80);
  await key(client, 'w', 'KeyW', 87, 0);
  await wait(250);
}

async function key(client, keyValue, code, windowsVirtualKeyCode, modifiers) {
  await client.Input.dispatchKeyEvent({
    type: 'keyDown', key: keyValue, code, windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers
  });
  await client.Input.dispatchKeyEvent({
    type: 'keyUp', key: keyValue, code, windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers
  });
}

async function dismissNotifications(client) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await evaluate(client, `(() => {
      const selectors = ['.notifications-toasts .codicon-close', '.notification-toast .codicon-close'];
      for (const element of document.querySelectorAll(selectors.join(','))) element.click();
    })()`);
    await wait(100);
  }
}

async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluation failed.');
  return result.result.value;
}

async function freshenQuotaCaches(home) {
  const accountsRoot = path.join(home, '.turntrail', 'accounts');
  for (const account of await fs.readdir(accountsRoot, { withFileTypes: true })) {
    if (!account.isDirectory()) continue;
    const file = path.join(accountsRoot, account.name, 'quota.json');
    try {
      const quota = JSON.parse(await fs.readFile(file, 'utf8'));
      quota.fetchedAt = new Date().toISOString();
      await fs.writeFile(file, `${JSON.stringify(quota, null, 2)}\n`, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function point(at, x, y) {
  return { at, x, y };
}

function write(stream, buffer) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    stream.once('error', onError);
    if (stream.write(buffer)) {
      stream.off('error', onError);
      resolve();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
