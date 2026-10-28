# Tutorial Recorder

Lightweight Loom-style recorder that runs entirely in the browser — nothing is uploaded anywhere; videos save straight to the user's computer.

- Screen / window / tab capture, mic narration, optional system audio
- Webcam bubble you drag into place on a mock screen, or camera-only mode
- 5-second test recording with instant playback
- 3-2-1 countdown, pause/resume, floating always-on-top controls
- Outputs a finished **MP4** (H.264/AAC)
- Installable as a desktop app

## What a new user needs

| Requirement | Why | How it's handled |
|---|---|---|
| The **https link** (not a downloaded file) | Browsers only allow screen capture on secure pages | Checklist flags it |
| **Google Chrome or Microsoft Edge**, reasonably current (desktop) | Uses Chrome-only APIs for background recording, MP4 output and floating controls | Checklist flags other browsers / old versions |
| Browser **camera & mic permission** for the site | Narration + bubble | One-click "Allow" in the checklist; steps shown if blocked |
| macOS **Camera / Microphone** permission for Chrome | macOS gate on top of the browser's | Usually auto-prompted on first use; steps + System Settings button if blocked |
| macOS **Screen & System Audio Recording** permission for Chrome, then **quit & reopen Chrome** | macOS gate for screen capture | The 5-second test recording step finds this before the first real recording; steps + System Settings button |

Optional extras stay out of the way: an **Install app** button appears in the header when Chrome allows it, and the A/V sync slider + sync test live under **Advanced**.

Everything above is checked live in the **Setup** panel at the top of the page; once all required steps pass it collapses to "Ready to record".

## Hosting

Any static HTTPS host works (GitHub Pages, Netlify, etc.) — just upload the folder. No server code.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765 in Chrome (`localhost` counts as secure).
