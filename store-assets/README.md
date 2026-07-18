# Store listing kit (v7.x)

Everything needed to refresh the Chrome Web Store listing
(`chromewebstore.google.com/detail/bndkihecbbkoligeekekdgommmdllfpe`).
All screenshots were captured from the real packaged v7.x build with
synthetic, PII-free seeded data (the e2e harness) — no real orders anywhere.

## Contents

| File | What it is | Where it goes in the dev dashboard |
|---|---|---|
| `screenshots/01-hero-dashboard-1280x800.png` | Dashboard + embedded panel, light | Store listing → Screenshots (slot 1) |
| `screenshots/02-export-formats-1280x800.png` | Panel with formats pitch | Screenshots (slot 2) |
| `screenshots/03-month-drilldown-1280x800.png` | Month rescope (Jan drill-down) | Screenshots (slot 3) |
| `screenshots/04-dark-mode-1280x800.png` | Dark mode | Screenshots (slot 4) |
| `screenshots/05-privacy-1280x800.png` | Settings / privacy story | Screenshots (slot 5) |
| `tiles/small-tile-440x280.png` | Small promo tile | Store listing → Small promo tile |
| `tiles/marquee-1400x560.png` | Marquee promo tile | Store listing → Marquee promo tile |
| `description.md` | Summary + detailed description | Store listing → Description |
| `review-replies.md` | Draft replies to critical reviews | Reviews tab (verify claims first) |
| `featured-nomination.md` | Featured-badge nomination answers | One Stop Support → nominate |

All sizes match CWS requirements exactly (1280×800 screenshots, 440×280 and
1400×560 tiles, PNG). The old FAQ video should be removed unless re-recorded —
an FAQ page as the hero video hurts more than no video.

## Publish checklist (in order)

1. Push `redesign/panel-and-storage` / `main` and merge PRs — the listing
   refresh describes v7 and must not go live before the build does.
2. Bump `manifest.json` version past 7.0, build the store zip, upload, publish.
3. Replace all 5 screenshots + both tiles, delete the old video.
4. Replace summary + description from `description.md` (update the
   "What's New" version number to the actual released version).
5. Developer account hygiene: verify publisher identity (→ Established
   Publisher badge), fill the website field (GitHub repo or Pages site),
   confirm support URL and privacy-policy link still resolve.
6. Reply to reviews from `review-replies.md` — after verifying every
   bracketed claim against what actually shipped.
7. Wait for the new version + listing to be live, then nominate for the
   Featured badge using `featured-nomination.md`.

## Regenerating screenshots

One command regenerates everything from the current code and verifies CWS
compliance (exact pixel sizes, no alpha channel):

    bash store-assets/scripts/generate-store-assets.sh

Under the hood it runs `scripts/store-shots.js` (builds dist/edge, boots it
in the e2e harness with PII-free seeded data, captures raw UI shots) and then
`scripts/compose-store-assets.js` (captions + branding → final PNGs).
Captions/layouts live in the compose script; shot states in store-shots.js.
Requirements: `npm ci` + Playwright chromium (same as the e2e suite).
Re-run after any UI change so store media never goes stale again.

Known cosmetic nit visible in captures: panel order rows show unformatted
totals ("37", "23.7" — no "$", inconsistent decimals). Worth fixing before
taking final screenshots for the release.
