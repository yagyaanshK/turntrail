import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { narration } from './generate-demo-narration.mjs';

const root = process.cwd();
const captureDir = path.join(root, '.marketing-capture', 'live-demo');
const outputDir = path.join(root, 'marketing', 'video', 'short-demo');
const rawVideo = path.join(captureDir, 'turntrail-live-ui.mkv');
const timelinePath = path.join(captureDir, 'timeline.json');
const cursor = path.join(captureDir, 'cursor.png');
const icon = path.join(root, 'packages', 'vscode', 'media', 'icon.png');
const outputName = 'turntrail-short-demo-v002-review-live-16x9.mp4';
const captionName = 'turntrail-short-demo-v002-en.srt';
const output = path.join(outputDir, outputName);
const captions = path.join(outputDir, captionName);
const manifestPath = path.join(outputDir, 'manifest.json');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'packages', 'vscode', 'package.json'), 'utf8'));
const timeline = JSON.parse(await fs.readFile(timelinePath, 'utf8'));

const width = 1920;
const height = 1080;
const fps = 30;
const duration = timeline.durationSeconds;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const audioFiles = narration.map((clip) => path.join(captureDir, 'audio', `${clip.id}.mp3`));
const captionsForVideo = [
  [0.35, 6.4, 'Continue one coding session across agents.'],
  [6.55, 11.6, 'Choose a Codex chat. Hand it off to Claude.'],
  [11.9, 18.85, 'Transcript plus workspace snapshot. No AI summary.'],
  [19, 25.75, 'See Codex and Claude usage in one place.'],
  [30.4, 35.25, 'Install Turntrail free from the VS Code Marketplace.']
];

await fs.mkdir(outputDir, { recursive: true });
for (const input of [rawVideo, timelinePath, icon, ...audioFiles]) await fs.access(input);
execFileSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', path.join(root, 'scripts', 'create-demo-cursor.ps1'),
  '-OutputPath', cursor
], { cwd: root, stdio: 'inherit' });
await fs.writeFile(captions, buildSrt(), 'utf8');

const args = ['-y', '-i', rawVideo];
args.push('-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', cursor);
args.push('-loop', '1', '-framerate', String(fps), '-t', String(duration), '-i', icon);
for (const audioFile of audioFiles) args.push('-i', audioFile);
args.push(
  '-filter_complex', buildFilter(),
  '-map', '[video]',
  '-map', '[audio]',
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '19',
  '-pix_fmt', 'yuv420p',
  '-r', String(fps),
  '-c:a', 'aac',
  '-b:a', '160k',
  '-ar', '48000',
  '-ac', '2',
  '-movflags', '+faststart',
  '-t', String(duration),
  output
);

await run(ffmpeg, args);
const probe = JSON.parse(execFileSync(ffprobe, [
  '-v', 'error',
  '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
  '-of', 'json',
  output
], { encoding: 'utf8' }));
verifyProbe(probe);

const files = [];
for (const file of [outputName, captionName]) {
  const contents = await fs.readFile(path.join(outputDir, file));
  files.push({
    file,
    bytes: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex')
  });
}
await fs.writeFile(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  product: 'Turntrail',
  asset: 'short-demo',
  status: 'review',
  version: 2,
  extensionVersion: packageJson.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  createdAt: new Date().toISOString(),
  syntheticData: true,
  liveInterfaceCapture: true,
  narration: { voice: 'en-US-GuyNeural', accent: 'American English', generatedWith: 'edge-tts' },
  cursor: { source: 'Windows system pointer', normalPixels: 38, clickPixels: 58 },
  editor: { maximized: true, zoom: 'reset', auxiliaryAgentPanelVisible: true },
  delivery: { width, height, fps, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
  durationSeconds: Number(probe.format.duration),
  files
}, null, 2)}\n`, 'utf8');

console.log(`Rendered ${output}`);
console.log(`Duration: ${Number(probe.format.duration).toFixed(2)}s`);

function buildFilter() {
  const filters = [];
  const x = cursorExpression('x');
  const y = cursorExpression('y');
  const clickWindows = timeline.clicks.map((at) => `between(t,${fixed(at - 0.14)},${fixed(at + 0.14)})`).join('+');

  filters.push('[0:v]fps=30,setpts=PTS-STARTPTS,format=yuv420p[base]');
  filters.push(`[base]${demoLabel()}[labeled]`);

  let current = 'labeled';
  captionsForVideo.forEach(([start, end, value], index) => {
    const next = `caption-${index}`;
    filters.push(
      `[${current}]${captionText(value, start, end)}[${next}]`
    );
    current = next;
  });

  filters.push(
    `[${current}]drawbox=x=818:y=772:w=640:h=150:color=0x111318@0.91:t=fill:enable='between(t,29.7,36)',` +
    `${drawText('Install Turntrail', 970, 804, 42, 'white', true, 'between(t,29.7,36)')},` +
    `${drawText('Free and open source', 970, 857, 25, '0xD7D9E0', false, 'between(t,29.7,36)')}[cta-box]`
  );
  filters.push('[2:v]scale=104:104,format=rgba[icon]');
  filters.push("[cta-box][icon]overlay=x=842:y=795:enable='between(t,29.7,36)':shortest=1[cta]");

  filters.push('[1:v]format=rgba,split=2[cursor-source-normal][cursor-source-click]');
  filters.push('[cursor-source-normal]scale=38:38[cursor-normal]');
  filters.push('[cursor-source-click]scale=58:58[cursor-click]');
  filters.push(
    `[cta][cursor-normal]overlay=x='${x}-2':y='${y}-2':eval=frame:` +
    `enable='not(${clickWindows})':shortest=1[normal-cursor]`
  );
  filters.push(
    `[normal-cursor][cursor-click]overlay=x='${x}-3':y='${y}-3':eval=frame:` +
    `enable='${clickWindows}':shortest=1,format=yuv420p[video]`
  );

  narration.forEach((clip, index) => {
    const input = index + 3;
    const delay = Math.round(clip.start * 1000);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[voice-${index}]`);
  });
  filters.push(
    `aevalsrc='0.10*sin(2*PI*920*t)*exp(-55*t)':s=48000:d=0.12,` +
    `aformat=channel_layouts=stereo,asplit=${timeline.clicks.length}` +
    timeline.clicks.map((_, index) => `[click-source-${index}]`).join('')
  );
  timeline.clicks.forEach((at, index) => {
    const delay = Math.round(at * 1000);
    filters.push(`[click-source-${index}]adelay=${delay}|${delay}[click-${index}]`);
  });
  const audioInputs = [
    ...narration.map((_, index) => `[voice-${index}]`),
    ...timeline.clicks.map((_, index) => `[click-${index}]`)
  ].join('');
  filters.push(
    `${audioInputs}amix=inputs=${narration.length + timeline.clicks.length}:duration=longest:normalize=0,` +
    'alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[audio]'
  );

  return filters.join(';');
}

function cursorExpression(axis) {
  const points = timeline.cursorKeyframes;
  let expression = fixed(points.at(-1)[axis]);
  for (let index = points.length - 2; index >= 0; index--) {
    const start = points[index];
    const end = points[index + 1];
    const durationSeconds = end.at - start.at;
    const progress = `(t-${fixed(start.at)})/${fixed(durationSeconds)}`;
    const eased = `(3*pow(${progress},2)-2*pow(${progress},3))`;
    const value = `${fixed(start[axis])}+(${fixed(end[axis] - start[axis])})*${eased}`;
    expression = `if(lt(t,${fixed(start.at)}),${fixed(start[axis])},if(lt(t,${fixed(end.at)}),${value},${expression}))`;
  }
  return expression;
}

function demoLabel() {
  return `drawbox=x=1648:y=92:w=232:h=38:color=0x111318@0.78:t=fill,` +
    drawText('SYNTHETIC DEMO DATA', 1665, 103, 16, '0xD7D9E0');
}

function drawText(value, x, y, size, color, bold = false, enable) {
  const font = bold ? 'C\\:/Windows/Fonts/arialbd.ttf' : 'C\\:/Windows/Fonts/arial.ttf';
  const enabled = enable ? `:enable='${enable}'` : '';
  return `drawtext=fontfile='${font}':text='${escapeText(value)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}${enabled}`;
}

function captionText(value, start, end) {
  const font = 'C\\:/Windows/Fonts/arial.ttf';
  return `drawtext=fontfile='${font}':text='${escapeText(value)}':` +
    `x=(w-text_w)/2:y=953:fontsize=29:fontcolor=white:` +
    `box=1:boxcolor=0x111318@0.88:boxborderw=22:fix_bounds=1:` +
    `enable='between(t,${start},${end})'`;
}

function escapeText(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'").replaceAll('%', '\\%');
}

function fixed(value) {
  return Number(value).toFixed(3).replace(/\.000$/, '');
}

function buildSrt() {
  return `${captionsForVideo.map(([start, end, value], index) => (
    `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${value}\n`
  )).join('\n')}\n`;
}

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const remainingSeconds = Math.floor((milliseconds % 60000) / 1000);
  const ms = milliseconds % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(remainingSeconds)},${String(ms).padStart(3, '0')}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function verifyProbe(probe) {
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  const actualDuration = Number(probe.format.duration);
  const problems = [];
  if (video?.codec_name !== 'h264') problems.push(`video codec is ${video?.codec_name || 'missing'}`);
  if (video?.width !== width || video?.height !== height) problems.push(`dimensions are ${video?.width}x${video?.height}`);
  if (video?.pix_fmt !== 'yuv420p') problems.push(`pixel format is ${video?.pix_fmt || 'missing'}`);
  if (video?.r_frame_rate !== `${fps}/1`) problems.push(`frame rate is ${video?.r_frame_rate || 'missing'}`);
  if (audio?.codec_name !== 'aac') problems.push(`audio codec is ${audio?.codec_name || 'missing'}`);
  if (Number(audio?.sample_rate) !== 48000 || audio?.channels !== 2) problems.push('audio is not 48 kHz stereo');
  if (actualDuration < duration - 0.05 || actualDuration > duration + 0.05) problems.push(`duration is ${actualDuration}`);
  if (problems.length > 0) throw new Error(`Video verification failed: ${problems.join('; ')}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
