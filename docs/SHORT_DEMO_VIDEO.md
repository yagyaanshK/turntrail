# Short Demo Video

## Purpose

Create a concise product proof for developers who switch between coding agents. The first video
shows Turntrail finding a Codex conversation, preparing a Claude handoff, preserving the handoff as
a local document, and displaying Codex and Claude account usage in the editor.

The video is designed to work without sound. Captions carry the complete message, while a silent
AAC track preserves broad social-platform compatibility. Narration can be added later without
changing the visual edit.

## Audience and CTA

- Audience: developers already using two or more AI coding agents.
- Primary action: install Turntrail from the VS Code Marketplace.
- Trust markers: real Turntrail UI, synthetic demonstration data, local deterministic handoff, free
  and open source.

## Storyboard

| Time | Visual | On-screen message |
| --- | --- | --- |
| 0:00-0:04 | Turntrail Sessions view, softened behind the product name | Continue one coding session across AI agents. |
| 0:04-0:11.5 | Codex session selected with Claude handoff controls open | Find the exact Codex session you want to continue. |
| 0:11.5-0:19 | Generated handoff open beside Sessions | Create a deterministic handoff for Claude. No AI summary. |
| 0:19-0:25 | Codex accounts and usage windows | See usage and switch between Codex accounts. |
| 0:25-0:30.5 | Claude accounts and usage windows | Keep Claude accounts ready in the same panel. |
| 0:30.5-0:35 | Turntrail end frame and Marketplace address | Install Turntrail. Free and open source. |

Clean cuts keep every interface state readable and produce an exact 35-second final render.

## Source and Privacy

The renderer uses the four captures in `packages/vscode/media/marketplace/`. Those images are
generated from the isolated `Launchpad` fixture and contain only synthetic `.demo` accounts,
synthetic transcripts, and the synthetic `C:\Demo\launchpad` path.

Do not replace these inputs with captures from a normal editor profile.

## Deliverables

```text
marketing/video/short-demo/
  turntrail-short-demo-v001-review-16x9.mp4
  turntrail-short-demo-v001-en.srt
  manifest.json
```

The review render is 1920 by 1080, H.264, yuv420p, constant 30 fps, with a silent AAC track and
fast-start metadata. It is deliberately stored outside `packages/vscode/media/`, so it is not
included in the VSIX.

## Reproduce

Install FFmpeg 7 or newer and run:

```bash
npm run marketing:video
```

The renderer probes the finished file and refuses to complete when the codec, dimensions, frame
rate, pixel format, audio stream, or duration is outside the expected delivery specification.

## Approval Checklist

- Inspect the opening, each workflow state, and the end frame at full size.
- Confirm captions describe only visible, released features.
- Confirm no real name, email, filesystem path, token, notification, or unrelated window appears.
- Confirm the Marketplace address is readable before publishing.
- Record founder approval before deriving square or vertical variants.
