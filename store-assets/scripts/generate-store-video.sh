#!/usr/bin/env bash
# Record + encode the Chrome Web Store tour video from the current code.
#
#   bash store-assets/scripts/generate-store-video.sh
#
# Pipeline:
#   1. generate-voiceover.js — narration synthesized locally with Kokoro-82M
#      on MLX (Apache-2.0: free, offline, commercially safe). Bootstraps its
#      own venv on first run; clips are cached per line in audio-cache/.
#   2. store-video.js — builds dist/chrome-mv3, boots it in the e2e harness
#      (synthetic PII-free seeded data; auto-uses scripts/seed-data.json from
#      sanitize-seed.js when present), and captures the scripted ad-cut tour
#      as raw JPEG-q100 screencast frames with real timestamps (bypasses
#      Playwright's recordVideo and its hard-coded ~1 Mbps VP8 encode).
#      Scene holds are floored at each narration clip's length, and
#      video-raw/timeline.json records where every scene starts.
#   3. build-audio.js — narration clips placed at their scene offsets, mixed
#      over an optional music bed (drop a royalty-free track at
#      audio-cache/music.mp3) → video-raw/audio.m4a
#   4. ffmpeg — assembles frames + audio into two high-bitrate H.264 MP4s:
#        video/tour-4k.mp4    3840×2160 lanczos upscale — YouTube upload
#                             master (4K uploads get YouTube's higher-
#                             bitrate encode ladder)
#        video/tour-1080p.mp4 1920×1080 — preview/embed copy
#
# Outputs land in store-assets/video/. Upload the 4K file to YouTube, then
# link it in the CWS listing's video field. Scene order, captions, and pacing
# live in store-video.js (DIRECTION block); narration lines and the voice
# live in vo-script.js.
#
# Requirements: npm ci + Playwright chromium (same as e2e) + ffmpeg +
# python3.10–3.12 (Apple Silicon) for the local TTS.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

echo "==> 1/4 narration (local Kokoro TTS, cached per line)"
node store-assets/scripts/generate-voiceover.js

echo "==> 2/4 recording the tour (real build, seeded data, native capture)"
node store-assets/scripts/store-video.js

echo "==> 3/4 mixing narration + optional music bed"
node store-assets/scripts/build-audio.js
AUDIO=store-assets/scripts/video-raw/audio.m4a

mkdir -p store-assets/video
RAW=store-assets/scripts/video-raw/concat.txt

# Near-lossless crf: on clean flat UI most bits go to motion; static holds
# are nearly free, so average bitrate stays sane while quality is maxed.
echo "==> 4/4 encoding tour-4k.mp4 + tour-1080p.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$RAW" -i "$AUDIO" \
  -vf "scale=3840:2160:flags=lanczos,fps=30" \
  -c:v libx264 -preset slow -crf 14 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart \
  store-assets/video/tour-4k.mp4

ffmpeg -y -loglevel error -f concat -safe 0 -i "$RAW" -i "$AUDIO" \
  -vf "fps=30" \
  -c:v libx264 -preset slow -crf 12 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -shortest -movflags +faststart \
  store-assets/video/tour-1080p.mp4

dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 \
  store-assets/video/tour-1080p.mp4)
echo
echo "Done (${dur%.*}s):"
ls -lh store-assets/video/tour-4k.mp4 store-assets/video/tour-1080p.mp4 | awk '{print "  " $9 "  " $5}'
echo "Upload tour-4k.mp4 to YouTube (unlisted is fine), then paste the URL"
echo "into the CWS listing's video field — it replaces the old FAQ video."
