/**
 * Voiceover direction for the store tour video. Shared by
 * generate-voiceover.js (local Kokoro TTS synthesis), store-video.js
 * (scene-length floors + timeline marks), and build-audio.js (placement +
 * mix).
 *
 * Narration is synthesized locally with Kokoro-82M on MLX (Apache-2.0 — free
 * for commercial use, no attribution required, nothing leaves the machine).
 *
 * Each scene id below must match an `await scene('<id>')` call in
 * store-video.js. A scene's VO clip starts exactly at the scene's first
 * frame; store-video.js extends the scene's hold if the clip runs longer
 * than the visuals.
 */
'use strict';

module.exports = {
  // Kokoro voice + pacing; override via env. am_fenrir is the punchier,
  // more assertive US-male narrator (previously am_michael at 1.0 — traded
  // up for a faster, more confident ad read).
  VOICE: process.env.KOKORO_VOICE || 'am_fenrir',
  SPEED: Number(process.env.KOKORO_SPEED || 1.1),

  SCENES: [
    { id: 'cold-open', line: 'Your entire Walmart order history — collected with one click.' },
    { id: 'reveal', line: 'And instantly, it becomes answers. Totals, averages, and a spending chart.' },
    // Spellings are phonetic on purpose: misaki reads "JSON" letter-by-letter
    // ("J-S-O-N"), while "Jason" yields the natural "JAY-sən"; spaced "P D F"
    // paces the letters cleanly. Validated via kokoro-tts.py's OOV check.
    { id: 'settings', line: 'Make it yours — every default is a setting. Export as Excel, C S V, Jason, printable receipts, or P D F. And yes… there’s dark mode.' },
    { id: 'drill', line: 'Click any month, and the whole dashboard narrows to show exactly where it went.' },
    { id: 'items', line: 'See every price hike on the items you buy again and again.' },
    { id: 'trends', line: 'And your habits, charted.' },
    { id: 'receipts', line: 'Every order expands into a full invoice — down to the last cent.' },
    { id: 'export', line: 'Tax season? Select your orders, and export. Two clicks.' },
    { id: 'mcp', line: 'And your A I can use it too. One toggle connects Claude — or any M C P tool — straight to your data. Ask a question, get the answer. All on your machine.' },
    { id: 'trust', line: 'No accounts. No servers. Nothing ever leaves your device — and you can erase everything with one button.' },
    { id: 'kicker', line: 'Your year at Walmart — yours to keep.' },
    { id: 'cta', line: 'Walmart Invoice Exporter. Free, open source, and private by design. Add it to Chrome today.' },
  ],
};
