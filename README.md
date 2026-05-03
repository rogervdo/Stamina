# YouTube Stamina Focus

A Chromium extension for [YouTube](https://www.youtube.com/) that adds **soft daily limits** — friction and quality nudges rather than hard blocks. The idea is to make overuse a little costlier while still letting you choose when to continue.

**Repo layout:** Extension source lives in [`youtube-focus/`](youtube-focus/).

## Features

- **Daily caps** — Track **minutes watched**, **videos started**, or **whichever hits first** (configurable in the popup).
- **Playback buffer** — After the limit, optional fullscreen countdown before play/resume (custom message, 3–120 seconds).
- **Comments** — Separate optional wait to reveal comments on `/watch` while over limit (also 3–120 seconds).
- **Stream quality** — After the limit: cap max resolution (144p–1080p), or aggressively stick to the lowest ladder rung (~144p). Uses a page-context script that aligns with YouTube’s quality mechanics.
- **Browse thumbnails** — On home, subscriptions, search grids, etc., optionally load lower-resolution stills when over limit.
- **Good faith break** — Types a short confirmation phrase to pause all extension effects for **15 minutes** without changing your settings.
- **Today’s stats** — Popup shows usage vs limits; you can reset today’s counters manually.

## Install (load unpacked)

1. Clone this repository.
2. Open Chrome (or another Chromium browser) → `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the [`youtube-focus`](youtube-focus) folder (the one containing `manifest.json`).
5. Pin the extension if you like; open **YouTube Stamina Focus** from the toolbar to configure it.

## Permissions & data

| Permission            | Why |
|-----------------------|-----|
| `storage`             | Saves settings and per-day stats locally ([`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/storage/)). |
| `https://www.youtube.com/*` | Injects the content script and page hook only on youtube.com. |

Nothing is sent to a server; everything stays on your machine.

## Requirements

- **Manifest V3** Chromium extension (see [`youtube-focus/manifest.json`](youtube-focus/manifest.json)).

## Development

- **Content script:** [`youtube-focus/content/content.js`](youtube-focus/content/content.js) — limits, buffer UI, thumbnails, comments gate, wiring to storage.
- **Page script (quality):** [`youtube-focus/content/page-quality-hook.js`](youtube-focus/content/page-quality-hook.js) — injected into the page context for stream quality behavior (see header comment in that file).
- **Popup:** [`youtube-focus/popup/`](youtube-focus/popup/)

Bump the version in `manifest.json` when you cut a release build.
