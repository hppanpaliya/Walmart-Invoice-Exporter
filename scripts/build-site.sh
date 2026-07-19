#!/usr/bin/env bash
# Assemble the GitHub Pages site into _site/.
#
# The site's images are NOT duplicated into site/ — they're pulled from their
# canonical homes at build time (store screenshots from store-assets/, the icon
# from public/images/), so the store listing and the website can never drift
# apart. Used by .github/workflows/pages.yml and for local preview:
#
#   bash scripts/build-site.sh && npx serve _site
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site/assets

cp -r site/* _site/
cp store-assets/screenshots/*.png _site/assets/
cp public/images/icon128.png _site/assets/

echo "Site assembled in _site/ ($(du -sh _site | cut -f1))"
