import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';

const root = process.cwd();
const port = Number(process.env.TURNTRAIL_CAPTURE_PORT || 9333);
const fixture = JSON.parse(await fs.readFile(path.join(root, '.marketing-capture', 'fixture.json'), 'utf8'));
const outputDir = path.join(root, 'packages', 'vscode', 'media', 'marketplace');
const extensionPackage = JSON.parse(await fs.readFile(path.join(root, 'packages', 'vscode', 'package.json'), 'utf8'));
const width = 1600;
const height = 900;

await fs.mkdir(outputDir, { recursive: true });
await freshenQuotaCaches(fixture.home);
await fs.access(fixture.handoff);

const targets = await CDP.List({ port });
const pageTarget = targets.find((target) => target.type === 'page' && /Visual Studio Code/i.test(target.title));
if (!pageTarget) throw new Error(`No VS Code workbench target found on port ${port}.`);

const workbench = await CDP({ target: pageTarget, port });
await workbench.Page.enable();
await workbench.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });

try {
  const secondaryVisible = await evaluate(workbench, `(() => {
    const sidebar = document.querySelector('.part.auxiliarybar');
    const rect = sidebar?.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0);
  })()`);
  if (secondaryVisible) await key(workbench, 'b', 'KeyB', 66, 3);
  await closeAllEditors(workbench);
  await evaluate(workbench, `
    if (!document.querySelector('[aria-label="Sessions Section"]')) {
      document.querySelector('a[aria-label="Turntrail"]')?.click();
    }
  `);
  await wait(1200);
  await openQuick(workbench, 'app.js');
  await resizePrimarySidebar(workbench, 570);

  await setPaneState(workbench, { sessions: true, accounts: false });
  await wait(900);
  await clickSessionHandoff('Refactor the analytics dashboard');
  await wait(500);
  await capture(workbench, '01-cross-agent-handoff.png');

  await createSessionHandoff('Refactor the analytics dashboard');
  await waitForWorkbenchText(workbench, 'Turntrail Handoff: claude');
  await waitForWebviewText('4 of 4 sessions');
  await scrollWebview('Managed CLI', 0);
  await wait(900);
  await dismissNotifications(workbench);
  await capture(workbench, '04-local-handoff.png');

  await key(workbench, 'w', 'KeyW', 87, 2);
  await wait(300);
  await openQuick(workbench, 'app.js');
  await setPaneState(workbench, { sessions: false, accounts: true });
  await scrollWebview('Usage remaining', 0);
  await wait(700);
  await capture(workbench, '02-account-quotas.png');

  await scrollWebview('Usage remaining', 760);
  await wait(400);
  await capture(workbench, '03-claude-accounts.png');
} finally {
  await workbench.close();
}

const files = [
  '01-cross-agent-handoff.png',
  '02-account-quotas.png',
  '03-claude-accounts.png',
  '04-local-handoff.png'
];
const entries = [];
for (const file of files) {
  const contents = await fs.readFile(path.join(outputDir, file));
  entries.push({ file, sha256: crypto.createHash('sha256').update(contents).digest('hex'), bytes: contents.length });
}
await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  product: 'Turntrail',
  extensionVersion: extensionPackage.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  createdAt: new Date().toISOString(),
  syntheticData: true,
  viewport: { width, height },
  files: entries
}, null, 2)}\n`, 'utf8');

console.log(`Captured ${files.length} Marketplace screenshots in ${outputDir}`);

async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP evaluation failed.');
  return result.result.value;
}

async function setPaneState(client, state) {
  await evaluate(client, `(() => {
    const sessions = document.querySelector('[aria-label="Sessions Section"]');
    const accounts = document.querySelector('[aria-label="Accounts Section"]');
    if (sessions && sessions.classList.contains('expanded') !== ${Boolean(state.sessions)}) sessions.click();
    if (accounts && accounts.classList.contains('expanded') !== ${Boolean(state.accounts)}) accounts.click();
  })()`);
  await wait(500);
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
  await wait(500);
}

async function openQuick(client, query) {
  await key(client, 'Escape', 'Escape', 27, 0);
  await wait(100);
  await key(client, 'p', 'KeyP', 80, 2);
  await wait(250);
  await client.Input.insertText({ text: query });
  await wait(700);
  await key(client, 'Enter', 'Enter', 13, 0);
  await wait(900);
}

async function closeAllEditors(client) {
  await key(client, 'k', 'KeyK', 75, 2);
  await wait(100);
  await key(client, 'w', 'KeyW', 87, 0);
  await wait(300);
}

async function key(client, keyValue, code, windowsVirtualKeyCode, modifiers) {
  await client.Input.dispatchKeyEvent({
    type: 'keyDown', key: keyValue, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers
  });
  await client.Input.dispatchKeyEvent({
    type: 'keyUp', key: keyValue, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers
  });
}

async function clickSessionHandoff(title) {
  const target = await webviewTarget(title);
  const client = await CDP({ target, port });
  try {
    let found = false;
    for (let attempt = 0; attempt < 12 && !found; attempt++) {
      found = await evaluate(client, `(() => {
        const doc = document.getElementById('active-frame')?.contentDocument;
        const cards = [...(doc?.querySelectorAll('article.session') || [])];
        const card = cards.find((item) => item.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)});
        if (card && !card.querySelector('.handoff-controls')) card.querySelector('[data-act="handoff"]')?.click();
        return Boolean(card);
      })()`);
      if (!found) await wait(250);
    }
    if (!found) throw new Error(`Session card not found: ${title}`);
    await wait(150);
    await evaluate(client, `document.getElementById('active-frame')?.contentDocument?.querySelector('[data-choice="delivery"][data-value="managed"]')?.click()`);
  } finally {
    await client.close();
  }
}

async function createSessionHandoff(title) {
  const target = await webviewTarget(title);
  const client = await CDP({ target, port });
  try {
    await evaluate(client, `document.getElementById('active-frame')?.contentDocument?.querySelector('[data-choice="mode"][data-value="existing"]')?.click()`);
    await wait(150);
    await evaluate(client, `document.getElementById('active-frame')?.contentDocument?.querySelector('[data-choice="delivery"][data-value="clipboard"]')?.click()`);
    await wait(150);
    const created = await evaluate(client, `(() => {
      const doc = document.getElementById('active-frame')?.contentDocument;
      const cards = [...(doc?.querySelectorAll('article.session') || [])];
      const card = cards.find((item) => item.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)});
      const button = card?.querySelector('[data-act="create-handoff"]');
      button?.click();
      return Boolean(button);
    })()`);
    if (!created) throw new Error(`Could not create handoff for session: ${title}`);
  } finally {
    await client.close();
  }
}

async function scrollWebview(text, top) {
  const target = await webviewTarget(text);
  const client = await CDP({ target, port });
  try {
    await evaluate(client, `(() => {
      const frame = document.getElementById('active-frame');
      const doc = frame?.contentDocument;
      if (doc?.scrollingElement) doc.scrollingElement.scrollTop = ${Number(top)};
      if (doc?.body) doc.body.scrollTop = ${Number(top)};
    })()`);
  } finally {
    await client.close();
  }
}

async function webviewTarget(expectedText) {
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const target of (await CDP.List({ port })).filter((item) => item.type === 'iframe')) {
      const client = await CDP({ target, port });
      try {
        const text = await evaluate(client, `document.getElementById('active-frame')?.contentDocument?.body?.innerText || ''`);
        if (text.includes(expectedText)) return target;
      } finally {
        await client.close();
      }
    }
    await wait(250);
  }
  throw new Error(`Turntrail webview containing "${expectedText}" was not found.`);
}

async function waitForWebviewText(expectedText) {
  const target = await webviewTarget(expectedText);
  const client = await CDP({ target, port });
  await client.close();
}

async function waitForWorkbenchText(client, expectedText) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const found = await evaluate(client, `document.body?.innerText?.includes(${JSON.stringify(expectedText)}) || false`);
    if (found) return;
    await wait(250);
  }
  throw new Error(`VS Code workbench text was not found: ${expectedText}`);
}

async function capture(client, file) {
  const screenshot = await client.Page.captureScreenshot({ format: 'png', fromSurface: true, captureBeyondViewport: false });
  await fs.writeFile(path.join(outputDir, file), Buffer.from(screenshot.data, 'base64'));
}

async function dismissNotifications(client) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await evaluate(client, `(() => {
      const selectors = [
        '.notifications-toasts .codicon-close',
        '.notifications-toasts .codicon-notifications-clear',
        '.notification-toast .codicon-close',
        '.notifications-center .codicon-clear-all'
      ];
      for (const element of document.querySelectorAll(selectors.join(','))) element.click();
    })()`);
    await wait(150);
  }
}

async function freshenQuotaCaches(home) {
  const accountsRoot = path.join(home, '.turntrail', 'accounts');
  const accountDirs = await fs.readdir(accountsRoot, { withFileTypes: true });
  for (const account of accountDirs) {
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
