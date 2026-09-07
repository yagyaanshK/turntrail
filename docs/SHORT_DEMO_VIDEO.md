# Short Demo Video

## Purpose

This 36-second product proof shows the released Turntrail extension performing a live Codex-to-Claude
handoff and then displaying synthetic Codex and Claude account usage. It is a real extension session,
not a slideshow or a sequence of zoomed screenshots.

The capture keeps Turntrail on the left, a live project file and generated handoff in the editor, and
VS Code's Agent panel on the right. The editor is maximized and its zoom is reset before recording.

## Presentation

- American English narration: `en-US-GuyNeural`, generated with `edge-tts`.
- Social-ready audio normalized to `-16 LUFS` with a `-1.5 dB` true-peak ceiling.
- Real Windows pointer: 38 pixels while moving and 58 pixels for 280 milliseconds around each click.
- Smooth pointer travel between actual controls, with a quiet click sound at each action.
- Burned-in concise captions plus a separate English SRT file.
- A small synthetic-data label and final Marketplace call to action.

## Storyboard

| Time | Live action | Narration focus |
| --- | --- | --- |
| 0:00-0:06 | Turntrail Sessions and VS Code Agent panel | Continue across agents without an AI-generated summary. |
| 0:03-0:08 | Choose Claude, existing session, and clipboard delivery | Select the exact Codex conversation and target. |
| 0:08-0:19 | Create and inspect the local handoff | Imported transcript, workspace snapshot, deterministic record. |
| 0:19-0:30 | Open Accounts and scroll from Codex to Claude | Usage limits and banked resets in the editor. |
| 0:30-0:36 | Accounts remain live behind the call to action | Install from the VS Code Marketplace. |

## Privacy

The isolated `Launchpad` fixture contains only synthetic `.demo` accounts, transcripts, quotas, and
the synthetic `C:\Demo\launchpad` workspace path. The capture uses a dedicated VS Code user-data
directory and extension directory under ignored `.marketing-capture/`.

Never record from a normal editor profile. Verify every output frame for names, email addresses,
filesystem paths, tokens, notifications, and unrelated windows before publishing.

## Tooling

- Packaged Turntrail VSIX in an isolated, maximized VS Code instance.
- Chrome DevTools Protocol for live UI actions and 1920 by 1080 frame capture.
- `edge-tts` for the US-English neural narration.
- The Windows system pointer rendered to a transparent PNG.
- FFmpeg and ffprobe for cursor animation, captions, audio mixing, encoding, and validation.

## Reproduce

Create the ignored narration environment once:

```powershell
python -m venv .marketing-tools\venv
.marketing-tools\venv\Scripts\pip.exe install edge-tts==7.2.8
```

Generate the fixture, install the current VSIX into an isolated profile, and launch VS Code with the
absolute fixture path, `--start-maximized`, and remote-debugging port `9333`. Then run:

```powershell
npm run marketing:video
```

For iteration, the stages can be run separately:

```powershell
npm run marketing:video:capture
npm run marketing:video:narrate
npm run marketing:video:render
```

The renderer refuses to complete unless the result is 1920 by 1080 H.264 at 30 fps with yuv420p
video, 48 kHz stereo AAC audio, and the expected 36-second duration.

## Deliverables

```text
marketing/video/short-demo/
  turntrail-short-demo-v002-review-live-16x9.mp4
  turntrail-short-demo-v002-en.srt
  manifest.json
```

These review assets are outside `packages/vscode/media/`, so they are not included in the VSIX.
