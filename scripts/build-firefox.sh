#!/usr/bin/env bash
# Build a Firefox-compatible package in dist/firefox/ and zip it.
# Run from the repo root: bash scripts/build-firefox.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/release-files.lib.sh
. "$REPO_ROOT/scripts/release-files.lib.sh"

OUT="dist/firefox"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- File list derived at runtime from .github/workflows/release.yml --------
# (single source of truth — see scripts/release-files.lib.sh).
copy_release_files "$OUT"

# --- Firefox-only additions -------------------------------------------------
cp firefox-shim.js "$OUT/"

# --- Transform manifest.json for Firefox MV3 --------------------------------
# - Firefox MV3 has no background service workers: use background.scripts
#   (event page). The script list is DERIVED from background.js's own
#   importScripts(...) call, so new background dependencies (e.g. orderdb.js)
#   flow in automatically: firefox-shim.js first (importScripts no-op +
#   chrome.sidePanel -> browser.sidebarAction bridge), then the imported
#   scripts in order, then background.js itself.
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

  // Derive background.scripts from background.js importScripts(...) so the
  // event page loads exactly what the Chrome service worker imports.
  const bgSource = fs.readFileSync("background.js", "utf8");
  const call = bgSource.match(/importScripts\(([^)]*)\)/);
  const imports = call
    ? call[1]
        .split(",")
        .map((s) => s.trim().replace(/^["'\'']|["'\'']$/g, ""))
        .filter(Boolean)
    : [];
  m.background = { scripts: ["firefox-shim.js", ...imports, "background.js"] };

  m.browser_specific_settings = {
    gecko: {
      id: "walmart-invoice-exporter@hppanpaliya.github.io",
      strict_min_version: "128.0",
    },
  };

  fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  console.log("Transformed " + path);
  console.log("background.scripts: " + JSON.stringify(m.background.scripts));
'

# --- Zip (manifest.json at the zip root, as AMO requires) --------------------
VERSION="$(node -p 'require("./manifest.json").version')"
ZIP="Walmart-Invoice-Exporter-firefox-${VERSION}.zip"
rm -f "dist/$ZIP"
(cd "$OUT" && zip -qr "../$ZIP" .)

echo "Built dist/$ZIP"
