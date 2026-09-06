import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureSnapshot, exportHandoff } from '../packages/core/src/index.js';

const root = process.cwd();
const captureRoot = path.join(root, '.marketing-capture');
const home = path.join(captureRoot, 'home');
const workspace = path.join(captureRoot, 'workspace', 'launchpad');
const store = path.join(home, '.turntrail');
const now = new Date();

await fs.rm(captureRoot, { recursive: true, force: true });
await Promise.all([
  fs.mkdir(path.join(workspace, '.turntrail', 'sessions'), { recursive: true }),
  fs.mkdir(path.join(workspace, '.turntrail', 'snapshots'), { recursive: true }),
  fs.mkdir(path.join(workspace, '.turntrail', 'exports'), { recursive: true }),
  fs.mkdir(path.join(workspace, '.turntrail', 'attachments'), { recursive: true }),
  fs.mkdir(path.join(store, 'accounts'), { recursive: true }),
  fs.mkdir(path.join(home, '.codex'), { recursive: true }),
  fs.mkdir(path.join(home, '.claude'), { recursive: true })
]);

const sessions = [
  session('claude-api-errors', 'anthropic', 'ide', 'Trace intermittent API errors', 21),
  session('codex-dashboard', 'openai', 'ide', 'Refactor the analytics dashboard', 8),
  session('gemini-accessibility', 'google', 'cli', 'Review keyboard accessibility', 34),
  session('cursor-test-suite', 'cursor', 'ide', 'Expand the integration test suite', 57)
];

for (const item of sessions) {
  const turns = [
    turn(item.id, item.provider, item.surface, 'user', item.importedAt, requestFor(item.id)),
    turn(item.id, item.provider, item.surface, 'assistant', addMinutes(item.importedAt, 2), responseFor(item.id))
  ];
  await writeJsonl(path.join(workspace, '.turntrail', item.path), turns);
}

await writeJson(path.join(workspace, '.turntrail', 'manifest.json'), {
  schemaVersion: 1,
  createdAt: ago(75),
  updatedAt: ago(7),
  projectRoot: 'C:\\Demo\\launchpad',
  sessions,
  snapshots: [],
  exports: []
});

await fs.writeFile(path.join(workspace, 'README.md'), '# Launchpad\n\nSynthetic workspace for Turntrail product captures.\n', 'utf8');
await fs.writeFile(path.join(workspace, '.gitignore'), '.turntrail/\n', 'utf8');
await fs.writeFile(path.join(workspace, 'app.js'), `const providers = ['claude', 'codex', 'gemini', 'cursor'];

export function availableSessions(sessions, projectRoot) {
  return sessions
    .filter((session) => session.projectRoot === projectRoot)
    .filter((session) => providers.includes(session.provider))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function nextAgent(session, target) {
  return {
    session,
    target,
    delivery: 'managed',
    preserveTranscript: true
  };
}
`, 'utf8');
await writeJson(path.join(captureRoot, 'vscode-user', 'User', 'settings.json'), {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.editor.showTabs': 'single',
  'workbench.commandCenter': false,
  'window.menuBarVisibility': 'hidden',
  'window.zoomLevel': 0,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false
});

const accounts = [
  account('personal-plus', 'codex', 'Personal', 'alex@turntrail.demo', 'plus', 90),
  account('studio-team', 'codex', 'Studio', 'dev@turntrail.demo', 'team', 55),
  account('client-pro', 'codex', 'Client work', 'build@turntrail.demo', 'pro', 18),
  account('claude-pro', 'claude', 'Claude Pro', 'alex@turntrail.demo', 'pro', 64),
  account('claude-team', 'claude', 'Claude Team', 'dev@turntrail.demo', 'team', 31)
];

await writeJson(path.join(store, 'accounts.json'), {
  schemaVersion: 1,
  updatedAt: now.toISOString(),
  accounts
});

for (const item of accounts) {
  const accountRoot = path.join(store, 'accounts', item.id);
  await fs.mkdir(accountRoot, { recursive: true });
  await writeJson(path.join(accountRoot, 'quota.json'), quotaFor(item));
  if (item.provider === 'codex') await writeCodexLogin(accountRoot, item);
  else await writeClaudeLogin(accountRoot, item);
}

await copy(path.join(store, 'accounts', 'studio-team', 'codex-home', 'auth.json'), path.join(home, '.codex', 'auth.json'));
await copy(path.join(store, 'accounts', 'claude-pro', 'claude-home', '.credentials.json'), path.join(home, '.claude', '.credentials.json'));
await copy(path.join(store, 'accounts', 'claude-pro', 'claude-home', '.claude.json'), path.join(home, '.claude.json'));

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Turntrail Demo']);
git(['config', 'user.email', 'demo@turntrail.local']);
git(['add', '.gitignore', 'README.md', 'app.js']);
git(['commit', '-m', 'Create synthetic Launchpad workspace']);

await captureSnapshot(workspace);
const exported = await exportHandoff(workspace, { target: 'claude' });
const handoffContents = (await fs.readFile(exported.path, 'utf8')).replaceAll(workspace, 'C:\\Demo\\launchpad');
await fs.writeFile(exported.path, handoffContents, 'utf8');

await writeJson(path.join(captureRoot, 'fixture.json'), { home, workspace, handoff: exported.path, createdAt: now.toISOString() });
console.log(JSON.stringify({ captureRoot, home, workspace, handoff: exported.path }, null, 2));

function session(id, provider, surface, title, minutesAgo) {
  return {
    id,
    provider,
    surface,
    path: `sessions/${id}.jsonl`,
    turnCount: 2,
    importedAt: ago(minutesAgo),
    nativeSessionId: `demo-${id}`,
    title,
    named: true
  };
}

function turn(sessionId, provider, surface, role, timestamp, content) {
  return { id: `${sessionId}-${role}`, provider, surface, sessionId, role, timestamp, content };
}

function requestFor(id) {
  const requests = {
    'claude-api-errors': 'Trace the intermittent API errors and identify the failing request path.',
    'codex-dashboard': 'Refactor the analytics dashboard without changing its public behavior.',
    'gemini-accessibility': 'Review keyboard navigation and document the remaining accessibility gaps.',
    'cursor-test-suite': 'Expand the integration suite around session discovery and handoffs.'
  };
  return requests[id];
}

function responseFor(id) {
  const responses = {
    'claude-api-errors': 'The failure is isolated to retry handling. I added a bounded backoff and regression coverage.',
    'codex-dashboard': 'The dashboard now uses the shared data adapter and the existing tests remain green.',
    'gemini-accessibility': 'The review found two focus-order issues and one missing accessible label.',
    'cursor-test-suite': 'The suite now covers provider filtering, imported sessions, and exact target selection.'
  };
  return responses[id];
}

function account(id, provider, label, email, plan, minutesAgo) {
  return {
    id,
    provider,
    label,
    email,
    plan,
    createdAt: ago(1440),
    signedInAt: ago(120),
    lastUsedAt: ago(minutesAgo)
  };
}

function quotaFor(item) {
  const profiles = {
    'personal-plus': [82, 67],
    'studio-team': [58, 43],
    'client-pro': [24, 18],
    'claude-pro': [71, 64],
    'claude-team': [46, 31]
  };
  const [short, long] = profiles[item.id];
  return {
    accountId: item.id,
    email: item.email,
    plan: item.plan,
    fetchedAt: now.toISOString(),
    limitReached: false,
    windows: [
      { label: '5h', remainingPercent: short, resetsAt: future(3) },
      { label: 'weekly', remainingPercent: long, resetsAt: future(4 * 24) }
    ],
    ...(item.id === 'studio-team' ? {
      resetCredits: { availableCount: 1, applicable: true, nextExpiresAt: future(21 * 24) }
    } : {})
  };
}

async function writeCodexLogin(accountRoot, item) {
  const target = path.join(accountRoot, 'codex-home');
  await fs.mkdir(target, { recursive: true });
  await writeJson(path.join(target, 'auth.json'), {
    tokens: {
      access_token: token({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, sub: `demo-${item.id}` }),
      refresh_token: `demo-refresh-${item.id}`,
      account_id: `demo-${item.id}`,
      id_token: token({
        sub: `demo-${item.id}`,
        email: item.email,
        'https://api.openai.com/auth': { chatgpt_plan_type: item.plan }
      })
    },
    last_refresh: now.toISOString()
  });
}

async function writeClaudeLogin(accountRoot, item) {
  const target = path.join(accountRoot, 'claude-home');
  await fs.mkdir(target, { recursive: true });
  await writeJson(path.join(target, '.credentials.json'), {
    claudeAiOauth: {
      accessToken: `demo-access-${item.id}`,
      refreshToken: `demo-refresh-${item.id}`,
      expiresAt: Date.now() + 30 * 86400 * 1000,
      scopes: ['user:inference'],
      subscriptionType: item.plan
    },
    organizationUuid: `demo-org-${item.id}`
  });
  await writeJson(path.join(target, '.claude.json'), {
    oauthAccount: {
      emailAddress: item.email,
      organizationUuid: `demo-org-${item.id}`,
      organizationType: `claude_${item.plan}`
    }
  });
}

function token(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.demo`;
}

function ago(minutes) {
  return new Date(now.getTime() - minutes * 60000).toISOString();
}

function future(hours) {
  return new Date(now.getTime() + hours * 3600000).toISOString();
}

function addMinutes(value, minutes) {
  return new Date(Date.parse(value) + minutes * 60000).toISOString();
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonl(file, values) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`, 'utf8');
}

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

function git(args) {
  execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
}
