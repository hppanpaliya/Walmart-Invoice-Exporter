#!/usr/bin/env bash
# Record + encode the Chrome Web Store tour video from the current code.
#
#   bash store-assets/scripts/generate-store-video.sh
#
# Pipeline:
#   1. store-video.js — builds dist/chrome-mv3, boots it in the e2e harness
#      (synthetic PII-free seeded data), and records the scripted UI tour
#      (injected cursor + captions + intro/outro — no editing needed)
#   2. ffmpeg — encodes the raw webm to an upload-ready H.264 MP4 (1080p)
#
# Outputs:
#   store-assets/video/tour-1080p.mp4  (upload this to YouTube; link it in
#                                       the CWS listing's video field)
#
# Requirements: npm ci + Playwright chromium (same as e2e) + ffmpeg.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

echo "==> 1/2 recording the tour (real build, seeded data)"
node store-assets/scripts/store-video.js

echo "==> 2/2 encoding tour-1080p.mp4"
mkdir -p store-assets/video
ffmpeg -y -loglevel error -i store-assets/scripts/video-raw/tour.webm \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 30 \
  -movflags +faststart -an \
  store-assets/video/tour-1080p.mp4

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 \
  store-assets/video/tour-1080p.mp4)
echo
echo "Done: store-assets/video/tour-1080p.mp4 (${dur%.*}s)"
echo "Upload to YouTube (unlisted is fine), then paste the URL into the"
echo "CWS listing's video field — it replaces the old FAQ video."
