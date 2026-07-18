#!/usr/bin/env bash
# Regenerate ALL Chrome Web Store listing assets from the current code.
#
#   bash store-assets/scripts/generate-store-assets.sh
#
# Pipeline:
#   1. store-shots.js          — builds dist/edge from the working tree, boots it
#                                in the e2e harness (PII-free seeded data), and
#                                captures raw UI screenshots
#   2. compose-store-assets.js — lays captions/branding over the raws and writes
#                                the final store-ready PNGs
#   3. compliance check        — exact pixel sizes + no alpha channel (CWS rules)
#
# Outputs (overwritten in place):
#   store-assets/screenshots/01..05-*-1280x800.png   (both screenshot sections)
#   store-assets/tiles/small-tile-440x280.png
#   store-assets/tiles/marquee-1400x560.png
#
# Run after any UI change so the store media never goes stale. Captions and
# layouts live in compose-store-assets.js; shot states in store-shots.js.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

echo "==> 1/3 capturing raw UI screenshots (real build, seeded data)"
node store-assets/scripts/store-shots.js

echo "==> 2/3 composing store-ready assets"
node store-assets/scripts/compose-store-assets.js

echo "==> 3/3 verifying CWS compliance (exact size, no alpha)"
fail=0
check() { # file expected_wxh
  local f=$1 want=$2
  local w h a
  w=$(sips -g pixelWidth  "$f" | awk 'END{print $2}')
  h=$(sips -g pixelHeight "$f" | awk 'END{print $2}')
  a=$(sips -g hasAlpha    "$f" | awk 'END{print $2}')
  if [[ "${w}x${h}" != "$want" || "$a" != "no" ]]; then
    echo "   FAIL $f — got ${w}x${h} alpha=$a, want $want alpha=no"
    fail=1
  else
    echo "   ok   $f (${w}x${h}, no alpha)"
  fi
}
for f in store-assets/screenshots/*.png; do check "$f" "1280x800"; done
check store-assets/tiles/small-tile-440x280.png 440x280
check store-assets/tiles/marquee-1400x560.png 1400x560
[[ $fail -eq 0 ]] || { echo "COMPLIANCE CHECK FAILED"; exit 1; }

echo
echo "All assets regenerated. Preview: open store-assets/preview.html"
echo "Upload map + publish checklist: store-assets/README.md"
