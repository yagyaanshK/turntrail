import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = process.cwd();
const mediaRoot = path.join(root, 'packages', 'vscode', 'media');
const screenshotRoot = path.join(mediaRoot, 'marketplace');
const outputDir = path.join(root, 'marketing', 'video', 'short-demo');
const outputName = 'turntrail-short-demo-v001-review-16x9.mp4';
const captionName = 'turntrail-short-demo-v001-en.srt';
const output = path.join(outputDir, outputName);
const captions = path.join(outputDir, captionName);
const manifestPath = path.join(outputDir, 'manifest.json');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'packages', 'vscode', 'package.json'), 'utf8'));

const width = 1920;
const height = 1080;
const fps = 30;
const scenes = [
  {
    image: '01-cross-agent-handoff.png',
    duration: 4,
    kind: 'intro',
    title: 'Turntrail',
    subtitle: 'Continue one coding session across AI agents'
  },
  {
    image: '01-cross-agent-handoff.png',
    duration: 7.5,
    caption: 'Find the exact Codex session you want to continue.'
  },
  {
    image: '04-local-handoff.png',
    duration: 7.5,
    caption: 'Create a deterministic handoff for Claude. No AI summary.'
  },
  {
    image: '02-account-quotas.png',
    duration: 6,
    caption: 'See usage and switch between Codex accounts.'
  },
  {
    image: '03-claude-accounts.png',
    duration: 5.5,
    caption: 'Keep Claude accounts ready in the same panel.'
  },
  {
    image: '04-local-handoff.png',
    duration: 4.5,
    kind: 'outro',
    title: 'Install Turntrail',
    subtitle: 'Free and open source',
    url: 'marketplace.visualstudio.com/items?itemName=turntrail.turntrail'
  }
];

await fs.mkdir(outputDir, { recursive: true });
for (const scene of scenes) await fs.access(path.join(screenshotRoot, scene.image));
await fs.access(path.join(mediaRoot, 'icon.png'));
await fs.writeFile(captions, buildSrt(), 'utf8');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const args = ['-y'];
for (const scene of scenes) {
  args.push('-loop', '1', '-framerate', String(fps), '-t', String(scene.duration), '-i', path.join(screenshotRoot, scene.image));
}
args.push('-loop', '1', '-framerate', String(fps), '-t', String(totalDuration()), '-i', path.join(mediaRoot, 'icon.png'));
args.push('-f', 'lavfi', '-t', String(totalDuration()), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
args.push(
  '-filter_complex', buildFilter(),
  '-map', '[video]',
  '-map', `${scenes.length + 1}:a:0`,
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-r', String(fps),
  '-c:a', 'aac',
  '-b:a', '128k',
  '-ar', '48000',
  '-movflags', '+faststart',
  '-shortest',
  '-t', String(totalDuration()),
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
  version: 1,
  extensionVersion: packageJson.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  createdAt: new Date().toISOString(),
  syntheticData: true,
  narration: false,
  delivery: { width, height, fps, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
  durationSeconds: Number(probe.format.duration),
  files
}, null, 2)}\n`, 'utf8');

console.log(`Rendered ${output}`);
console.log(`Duration: ${Number(probe.format.duration).toFixed(2)}s`);

function buildFilter() {
  const filters = [];
  const logoInput = scenes.length;
  filters.push(`[${logoInput}:v]scale=150:150,format=rgba,split=2[logo-intro][logo-outro]`);

  scenes.forEach((scene, index) => {
    const zoomDirection = 'min(pzoom+0.00018,1.025)';
    filters.push(
      `[${index}:v]scale=${width}:${height},setsar=1,` +
      `zoompan=z='${zoomDirection}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},` +
      `trim=duration=${scene.duration},setpts=PTS-STARTPTS[scene-${index}-base]`
    );

    if (scene.kind === 'intro') {
      filters.push(
        `[scene-${index}-base]boxblur=12:2,drawbox=x=0:y=0:w=iw:h=ih:color=0x111318@0.78:t=fill[intro-bg]`,
        `[intro-bg][logo-intro]overlay=x=150:y=(H-h)/2:shortest=1,` +
        `${text(scene.title, 350, '(h-text_h)/2-58', 72, 'white', true)},` +
        `${text(scene.subtitle, 350, '(h-text_h)/2+32', 38, '0xD7D9E0')},` +
        `${label('SYNTHETIC DEMONSTRATION DATA')},${normalize(scene.duration)}[scene-${index}]`
      );
    } else if (scene.kind === 'outro') {
      filters.push(
        `[scene-${index}-base]boxblur=12:2,drawbox=x=0:y=0:w=iw:h=ih:color=0x111318@0.82:t=fill[outro-bg]`,
        `[outro-bg][logo-outro]overlay=x=(W-w)/2:y=230:shortest=1,` +
        `${text(scene.title, '(w-text_w)/2', 430, 64, 'white', true)},` +
        `${text(scene.subtitle, '(w-text_w)/2', 520, 34, '0xD7D9E0')},` +
        `${text(scene.url, '(w-text_w)/2', 615, 28, '0xB8A9FF')},` +
        `${label('SYNTHETIC DEMONSTRATION DATA')},${normalize(scene.duration)}[scene-${index}]`
      );
    } else {
      filters.push(
        `[scene-${index}-base]` +
        `drawbox=x=110:y=ih-175:w=iw-220:h=104:color=0x111318@0.88:t=fill,` +
        `drawbox=x=110:y=ih-175:w=8:h=104:color=0x7257E8@1:t=fill,` +
        `${text(scene.caption, 150, 'h-142', 35, 'white')},` +
        `${label('SYNTHETIC DEMONSTRATION DATA')},${normalize(scene.duration)}[scene-${index}]`
      );
    }
  });

  filters.push(`${scenes.map((_, index) => `[scene-${index}]`).join('')}concat=n=${scenes.length}:v=1:a=0[video]`);
  return filters.join(';');
}

function text(value, x, y, size, color, bold = false) {
  const font = bold ? 'C\\:/Windows/Fonts/arialbd.ttf' : 'C\\:/Windows/Fonts/arial.ttf';
  return `drawtext=fontfile='${font}':text='${escapeText(value)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
}

function label(value) {
  return `drawbox=x=iw-430:y=34:w=390:h=42:color=0x111318@0.84:t=fill,` +
    `${text(value, 'w-410', 45, 18, '0xD7D9E0')}`;
}

function normalize(duration) {
  return `trim=duration=${duration},fps=${fps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS`;
}

function escapeText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '\\%');
}

function totalDuration() {
  return scenes.reduce((sum, scene) => sum + scene.duration, 0);
}

function buildSrt() {
  const entries = [
    [0.3, 4.0, 'Turntrail\nContinue one coding session across AI agents.'],
    [4.2, 11.5, scenes[1].caption],
    [11.7, 18.8, scenes[2].caption],
    [19.2, 24.8, scenes[3].caption],
    [25.2, 30.3, scenes[4].caption],
    [30.7, 35.0, 'Install Turntrail. Free and open source.']
  ];
  return `${entries.map(([start, end, value], index) => `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${value}\n`).join('\n')}\n`;
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
  const duration = Number(probe.format.duration);
  const problems = [];
  if (video?.codec_name !== 'h264') problems.push(`video codec is ${video?.codec_name || 'missing'}`);
  if (video?.width !== width || video?.height !== height) problems.push(`dimensions are ${video?.width}x${video?.height}`);
  if (video?.pix_fmt !== 'yuv420p') problems.push(`pixel format is ${video?.pix_fmt || 'missing'}`);
  if (video?.r_frame_rate !== `${fps}/1`) problems.push(`frame rate is ${video?.r_frame_rate || 'missing'}`);
  if (audio?.codec_name !== 'aac') problems.push(`audio codec is ${audio?.codec_name || 'missing'}`);
  if (Number(audio?.sample_rate) !== 48000 || audio?.channels !== 2) problems.push('audio is not 48 kHz stereo');
  if (duration < 34.8 || duration > 35.2) problems.push(`duration is ${duration}`);
  if (problems.length > 0) throw new Error(`Video verification failed: ${problems.join('; ')}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
