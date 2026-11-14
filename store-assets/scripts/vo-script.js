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
  // ElevenLabs delivery (the default provider whenever a key is present —
  // see generate-voiceover.js). Eric is the smooth, trustworthy US-male
  // voice; style + 1.1x speed give it the salesman punch.
  ELEVEN: {
    VOICE_ID: process.env.ELEVEN_VOICE_ID || 'cjVigY5qzO86Huf0OWal',
    VOICE_NAME: 'Eric',
    MODEL: 'eleven_multilingual_v2',
    SETTINGS: {
      stability: 0.45,
      similarity_boost: 0.75,
      style: 0.3,
      speed: Number(process.env.ELEVEN_SPEED || 1.1),
    },
  },

  // Kokoro (offline fallback) voice + pacing; override via env. am_puck is
  // the energetic, salesman-confident US-male narrator (previously am_fenrir
  // at 1.1 and am_michael at 1.0 — both read flatter and more robotic).
  // Alternates are pre-rendered in audio-cache/voice-samples/.
  VOICE: process.env.KOKORO_VOICE || 'am_puck',
  SPEED: Number(process.env.KOKORO_SPEED || 1.2),

  SCENES: [
    { id: 'cold-open', line: 'Your entire Walmart order history — collected with one click.' },
    { id: 'reveal', line: 'And instantly, it becomes answers. Totals, averages, and a spending chart.' },
    // `line` spellings are phonetic for Kokoro's misaki g2p (it reads "JSON"
    // letter-by-letter, "Jason" gives the natural "JAY-sən"); `natural` is
    // the plain text ElevenLabs reads instead (it handles initialisms).
    { id: 'settings',
      line: 'Make it yours — every default is a setting. Export as Excel, C S V, Jason, printable receipts, or P D F.',
      natural: 'Make it yours — every default is a setting. Export as Excel, CSV, JSON, printable receipts, or PDF.' },
    // Own scene so the line lands exactly as the theme flips on screen.
    { id: 'dark', line: 'And yes… there’s dark mode.' },
    { id: 'drill', line: 'Click any month, and the whole dashboard narrows to show exactly where it went.' },
    { id: 'items', line: 'See every price hike on the items you buy again and again.' },
    { id: 'trends', line: 'And your habits, charted.' },
    { id: 'receipts', line: 'Every order expands into a full invoice — down to the last cent.' },
    { id: 'export', line: 'Tax season? Select your orders, and export. Two clicks.' },
    { id: 'mcp',
      line: 'And your assistant can use it too. One toggle connects Claude — or any M C P tool — straight to your data. Ask a question, get the answer. All on your machine.',
      natural: 'And your assistant can use it too. One toggle connects Claude — or any MCP tool — straight to your data. Ask a question, get the answer. All on your machine.' },
    { id: 'trust', line: 'No accounts. No servers. Nothing ever leaves your device — and you can erase everything in one click.' },
    { id: 'kicker', line: 'Your year at Walmart — yours to keep.' },
    { id: 'cta', line: 'Walmart Invoice Exporter. Free, open source, and private by design. Add it to Chrome today.' },
  ],
};
