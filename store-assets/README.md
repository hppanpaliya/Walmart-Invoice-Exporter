# Store listing kit (v8.x)

Everything needed to refresh the Chrome Web Store listing
(`chromewebstore.google.com/detail/bndkihecbbkoligeekekdgommmdllfpe`).
All media — screenshots AND the tour video — is captured from the real
packaged v8.x build with synthetic, PII-free seeded data (the e2e harness) —
no real orders, accounts, or names anywhere.

## Contents

| File | What it is | Where it goes in the dev dashboard |
|---|---|---|
| `video/tour-4k.mp4` | ~65s scripted ad-cut tour (4K upload master, silent) | Upload to YouTube → paste URL in Store listing → Video |
| `video/tour-1080p.mp4` | Same cut, 1080p preview/embed copy | Local preview (`preview.html`) |
| `screenshots/01-hero-dashboard-1280x800.png` | Dashboard + embedded panel, light | Store listing → Screenshots (slot 1) |
| `screenshots/02-invoice-drilldown-1280x800.png` | Orders view, expanded inline invoice | Screenshots (slot 2) |
| `screenshots/03-export-formats-1280x800.png` | Panel with formats pitch | Screenshots (slot 3) |
| `screenshots/04-month-drilldown-dark-1280x800.png` | Month rescope, dark mode | Screenshots (slot 4) |
| `screenshots/05-privacy-1280x800.png` | Settings / privacy story | Screenshots (slot 5) |
| `tiles/small-tile-440x280.png` | Small promo tile | Store listing → Small promo tile |
| `tiles/marquee-1400x560.png` | Marquee promo tile | Store listing → Marquee promo tile |
| `description.md` | Summary + detailed description | Store listing → Description |
| `review-replies.md` | Draft replies to critical reviews | Reviews tab (verify claims first) |
| `featured-nomination.md` | Featured-badge nomination answers | One Stop Support → nominate |

All sizes match CWS requirements exactly (1280×800 screenshots, 440×280 and
1400×560 tiles, PNG). The tour video replaces the old FAQ video — an FAQ page
as the hero video hurts more than no video.

## Publish checklist (in order)

1. Merge to `main` — the listing refresh describes v8 and must not go live
   before the build does.
2. Bump the version past 8.0 (currently 8.2 in `wxt.config.ts`), `pnpm run zip`, upload, publish.
3. Upload `video/tour-4k.mp4` to the project's YouTube account (public or
   unlisted), then set it as the listing video — this replaces the old FAQ
   video.
4. Replace all 5 screenshots + both tiles.
5. Replace summary + description from `description.md` (update the
   "What's New" version number to the actual released version).
6. Developer account hygiene: verify publisher identity (→ Established
   Publisher badge), fill the website field with the live site
   (`https://github.harsh.al/Walmart-Invoice-Exporter/`),
   confirm support URL and privacy-policy link still resolve.
7. Reply to reviews from `review-replies.md` — after verifying every
   bracketed claim against what actually shipped.
8. Wait for the new version + listing to be live, then nominate for the
   Featured badge using `featured-nomination.md`.

## Regenerating screenshots

One command regenerates everything from the current code and verifies CWS
compliance (exact pixel sizes, no alpha channel):

    bash store-assets/scripts/generate-store-assets.sh

Under the hood it runs `scripts/store-shots.js` (builds dist/chrome-mv3,
boots it in the e2e harness with PII-free seeded data, captures raw UI shots)
and then `scripts/compose-store-assets.js` (captions + branding → final PNGs).
Captions/layouts live in the compose script; shot states in store-shots.js.
Requirements: `npm ci` + Playwright chromium (same as the e2e suite).
Re-run after any UI change so store media never goes stale again.

## Seeding store media from your REAL history (sanitized)

The synthetic seed is only 6 products, which looks repetitive on camera. To
make captures realistic without showing anything private:

1. In your real browser, open the extension on walmart.com/orders,
   click **Select all**, set Export format to **JSON**, click
   **Single file (.json)**.
2. `node store-assets/scripts/sanitize-seed.js ~/Downloads/Walmart_Orders.json`
3. Re-run either generate script — both automatically use
   `store-assets/scripts/seed-data.json` when it exists (delete it to go
   back to synthetic).

The sanitizer is allowlist-based: only dates, status, item name/qty/price,
and order money fields are copied. Names, addresses, payment methods,
tracking numbers, barcodes, product links, real order numbers, and any field
it doesn't know about are dropped by construction, and it prints the exact
item list that will appear on screen for review. Use
`--exclude "<regex>"` to remove items you'd rather not show, `--max <n>` to
cap the order count. `seed-data.json` is gitignored — the sanitized history
stays on this machine; only the rendered media is committed.

## Regenerating the tour video

    bash store-assets/scripts/generate-store-video.sh

`scripts/store-video.js` boots the same seeded harness and records a fully
scripted ~65s ad cut at 1920×1080 — injected animated cursor, caption pills,
and a CTA outro card, so the capture needs zero post-production. The cut
opens on a LIVE collection (real progress against the mock walmart.com),
then reveal → drill-down → Items/Trends montage → inline invoice → export
formats → settings + dark mode → privacy → Year in review → "Add to Chrome".
ffmpeg then encodes `video/tour-4k.mp4` (lanczos upscale upload master —
4K uploads get YouTube's higher-bitrate encode ladder) and
`video/tour-1080p.mp4` (preview copy). Scene order, captions, and pacing all
live in store-video.js (see its DIRECTION block). Requirements: the e2e
prerequisites plus `ffmpeg` on PATH. Note: recording resolution is capped at
the CSS viewport by Chromium's screencast — don't raise recordVideo size
hoping for native 4K; it just letterboxes.

Preview everything (video + stills) locally: open `store-assets/preview.html`.
