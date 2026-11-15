---
name: Store listing media
description: Regenerate the Chrome Web Store screenshots, promo tiles, tour video and description for Walmart Invoice Exporter from the current build, and assemble the upload package.
---

# Store listing media

Everything for the listing lives in `store-assets/`; its `README.md` maps each
file to a field in the developer dashboard.

## Rules

- Media shows the demo catalog in `store-assets/scripts/demo-seed.js`:
  generated orders and well-known name-brand products. Nothing from a real
  account. The sanitized real-history seed is used only when
  `STORE_SEED_REAL=1` is set on purpose.
- The tour's collection scene reads the mock order pages; `withDemoItemNames`
  renames their placeholder items, so keep it wired into `store-video.js`.
- Generate from a clean worktree of the release commit, so the media shows
  what ships.

## Screenshots and tiles

```sh
bash store-assets/scripts/generate-store-assets.sh
```

Captures the packaged build with seeded data, composes captions, and checks
the store's size rules (1280x800 screenshots, 440x280 and 1400x560 tiles, no
alpha). Look at the results before committing: the version chip, the item
names, and that no figure is cut off.

## Tour video

`generate-store-video.sh` runs narration, recording, audio mix and encoding.
Narration clips are cached in `store-assets/scripts/audio-cache/` (ignored by
git; it may also hold an ElevenLabs key, which must never be committed).

Synthesizing narration costs credits or needs a local model. To re-record
with the clips already in the cache, skip the first step:

```sh
node store-assets/scripts/store-video.js      # record
node store-assets/scripts/build-audio.js      # place the cached clips
# then the two ffmpeg commands at the end of generate-store-video.sh
```

Extract a few frames (`ffmpeg -ss <t> -i tour-1080p.mp4 -frames:v 1 f.png`)
and check them. `tour-4k.mp4` is the YouTube upload and is not tracked.

## Description

Update "What's new" in `store-assets/description.md` from the changelog. Every
claim must be true of the build being released. The summary field holds 132
characters.

## Upload package

Collect in one folder: the Chrome zip GitHub built for the release commit,
`screenshots/`, `tiles/`, `description.md`, and `video/`.
