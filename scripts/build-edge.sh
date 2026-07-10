#!/usr/bin/env bash
# Build the Edge package. Edge (Chromium) runs the Chrome package unmodified:
# same MV3 service worker, chrome.sidePanel, and permissions all work as-is.
# Run from the repo root: bash scripts/build-edge.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="dist/edge"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- Same file set as .github/workflows/release.yml, unmodified -------------
cp -r _locales "$OUT/"
cp -r images "$OUT/"
cp background.js "$OUT/"
cp content.js "$OUT/"
cp exceljs.bare.min.js "$OUT/"
cp manifest.json "$OUT/"
cp utils.js "$OUT/"

# Side panel files
cp sidepanel.html "$OUT/"
cp sidepanel.js "$OUT/"
cp sidepanel.css "$OUT/"
cp sidepanel.state.js "$OUT/"
cp sidepanel.view.js "$OUT/"
cp sidepanel.actions.js "$OUT/"
cp sidepanel.download.js "$OUT/"

# Helpful documentation files (optional)
cp README.md "$OUT/" || true
cp CHANGELOG.md "$OUT/" || true
cp Privacy-Policy.md "$OUT/" || true

# --- Zip (manifest.json at the zip root, as the Edge dashboard requires) -----
VERSION="$(node -p 'require("./manifest.json").version')"
ZIP="Walmart-Invoice-Exporter-edge-${VERSION}.zip"
rm -f "dist/$ZIP"
(cd "$OUT" && zip -qr "../$ZIP" .)

echo "Built dist/$ZIP"
