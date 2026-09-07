import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const outputDir = path.join(root, '.marketing-capture', 'live-demo', 'audio');
const defaultExecutable = path.join(root, '.marketing-tools', 'venv', 'Scripts', 'edge-tts.exe');
const executable = process.env.EDGE_TTS_PATH || defaultExecutable;
const voice = process.env.TURNTRAIL_DEMO_VOICE || 'en-US-GuyNeural';
const rate = process.env.TURNTRAIL_DEMO_VOICE_RATE || '+5%';

export const narration = [
  {
    id: '01',
    start: 0.35,
    text: 'Turntrail lets you continue coding sessions across agents without asking one AI to summarize another.'
  },
  {
    id: '02',
    start: 6.55,
    text: 'Choose the exact Codex conversation, select Claude, and create a handoff.'
  },
  {
    id: '03',
    start: 11.9,
    text: 'Turntrail imports the transcript, snapshots the workspace, and opens a deterministic local record you can review.'
  },
  {
    id: '04',
    start: 19,
    text: 'It also keeps your Codex and Claude accounts together, with usage limits and banked resets visible inside the editor.'
  },
  {
    id: '05',
    start: 30.4,
    text: 'Install Turntrail free from the Visual Studio Code Marketplace.'
  }
];

if (isMain()) {
  await fs.access(executable).catch(() => {
    throw new Error(
      `edge-tts was not found at ${executable}. Create the ignored marketing environment with ` +
      'python -m venv .marketing-tools/venv, install edge-tts, or set EDGE_TTS_PATH.'
    );
  });
  await fs.mkdir(outputDir, { recursive: true });

  for (const clip of narration) {
    const output = path.join(outputDir, `${clip.id}.mp3`);
    await run(executable, [
      '--voice', voice,
      '--rate', rate,
      '--text', clip.text,
      '--write-media', output
    ]);
    console.log(`Generated ${path.relative(root, output)}`);
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
