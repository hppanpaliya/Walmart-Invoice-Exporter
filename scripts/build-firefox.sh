#!/usr/bin/env bash
# Build a Firefox-compatible package in dist/firefox/ and zip it.
# Run from the repo root: bash scripts/build-firefox.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="dist/firefox"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- Same file set as .github/workflows/release.yml ------------------------
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

# --- Firefox-only additions -------------------------------------------------
cp firefox-shim.js "$OUT/"

# --- Transform manifest.json for Firefox MV3 --------------------------------
# - Firefox MV3 has no background service workers: use background.scripts
#   (event page). firefox-shim.js must load first (importScripts no-op +
#   chrome.sidePanel -> browser.sidebarAction bridge), then utils.js, then
#   background.js.
# - Firefox has no side_panel / "sidePanel" permission: use sidebar_action.
# - AMO requires browser_specific_settings.gecko.id for signing.
node -e '
  const fs = require("fs");
  const path = "dist/firefox/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));

  delete m.side_panel;
  delete m.minimum_chrome_version; // Chrome-only key; Firefox warns on it
  m.permissions = (m.permissions || []).filter((p) => p !== "sidePanel");

  m.sidebar_action = {
    default_panel: "sidepanel.html",
    default_title: "Walmart Invoice Exporter",
    default_icon: "images/icon48.png",
  };

  m.background = { scripts: ["firefox-shim.js", "utils.js", "background.js"] };

  m.browser_specific_settings = {
    gecko: {
      id: "walmart-invoice-exporter@hppanpaliya.github.io",
      strict_min_version: "128.0",
    },
  };

  fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  console.log("Transformed " + path);
'

# --- Zip (manifest.json at the zip root, as AMO requires) --------------------
VERSION="$(node -p 'require("./manifest.json").version')"
ZIP="Walmart-Invoice-Exporter-firefox-${VERSION}.zip"
rm -f "dist/$ZIP"
(cd "$OUT" && zip -qr "../$ZIP" .)

echo "Built dist/$ZIP"
