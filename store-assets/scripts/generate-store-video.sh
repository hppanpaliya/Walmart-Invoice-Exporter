#!/usr/bin/env bash
# Record + encode the Chrome Web Store tour video from the current code.
#
#   bash store-assets/scripts/generate-store-video.sh
#
# Pipeline:
#   1. store-video.js — builds dist/chrome-mv3, boots it in the e2e harness
#      (synthetic PII-free seeded data; auto-uses scripts/seed-data.json from
#      sanitize-seed.js when present), and captures the scripted ad-cut tour
#      as raw JPEG-q100 screencast frames with real timestamps (bypasses
#      Playwright's recordVideo and its hard-coded ~1 Mbps VP8 encode)
#   2. ffmpeg — assembles the frames into two high-bitrate H.264 MP4s:
#        video/tour-4k.mp4    3840×2160 lanczos upscale — YouTube upload
#                             master (4K uploads get YouTube's higher-
#                             bitrate encode ladder)
#        video/tour-1080p.mp4 1920×1080 — preview/embed copy
#
# Outputs land in store-assets/video/. Upload the 8K file to YouTube, then
# link it in the CWS listing's video field. Scene order, captions, and pacing
# all live in store-video.js (see the DIRECTION block at the top).
#
# Requirements: npm ci + Playwright chromium (same as e2e) + ffmpeg.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

echo "==> 1/3 recording the tour (real build, seeded data, native 4K)"
node store-assets/scripts/store-video.js

mkdir -p store-assets/video
RAW=store-assets/scripts/video-raw/concat.txt

# Near-lossless crf: on clean flat UI most bits go to motion; static holds
# are nearly free, so average bitrate stays sane while quality is maxed.
echo "==> 2/3 encoding tour-4k.mp4 (3840x2160 upload master)"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$RAW" \
  -vf "scale=3840:2160:flags=lanczos,fps=30" \
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p \
  -movflags +faststart -an \
  store-assets/video/tour-4k.mp4

echo "==> 3/3 encoding tour-1080p.mp4 (preview copy)"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$RAW" \
  -vf "fps=30" \
  -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p \
  -movflags +faststart -an \
  store-assets/video/tour-1080p.mp4

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 \
  store-assets/video/tour-1080p.mp4)
echo
echo "Done (${dur%.*}s):"
ls -lh store-assets/video/tour-4k.mp4 store-assets/video/tour-1080p.mp4 | awk '{print "  " $9 "  " $5}'
echo "Upload tour-4k.mp4 to YouTube (unlisted is fine), then paste the URL"
echo "into the CWS listing's video field — it replaces the old FAQ video."
