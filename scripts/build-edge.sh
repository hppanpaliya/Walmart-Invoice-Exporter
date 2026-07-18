#!/usr/bin/env bash
# Build the Edge package. Edge (Chromium) runs the Chrome package unmodified:
# same MV3 service worker, chrome.sidePanel, and permissions all work as-is.
# Run from the repo root: bash scripts/build-edge.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/release-files.lib.sh
. "$REPO_ROOT/scripts/release-files.lib.sh"

OUT="dist/edge"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- File list derived at runtime from .github/workflows/release.yml --------
# (single source of truth — see scripts/release-files.lib.sh). The Edge
# package is byte-identical to the Chrome release contents.
copy_release_files "$OUT"

# --- Zip (manifest.json at the zip root, as the Edge dashboard requires) -----
VERSION="$(node -p 'require("./manifest.json").version')"
ZIP="Walmart-Invoice-Exporter-edge-${VERSION}.zip"
rm -f "dist/$ZIP"
(cd "$OUT" && zip -qr "../$ZIP" .)

echo "Built dist/$ZIP"
