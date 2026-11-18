/**
 * Voiceover direction for the store tour video. Shared by
 * generate-voiceover.js (local TTS synthesis), store-video.js
 * (scene-length floors + timeline marks), and build-audio.js (placement +
 * mix).
 *
 * Narration uses Ming 3.0 TTS 0.5B on MLX when installed, otherwise Kokoro-82M.
 *
 * Each scene id below must match an `await scene('<id>')` call in
 * store-video.js. A scene's VO clip starts exactly at the scene's first
 * frame; store-video.js extends the scene's hold if the clip runs longer
 * than the visuals.
 */
'use strict';

module.exports = {
  // Kokoro's US English female narrator (offline fallback).
  VOICE: 'af_heart',
  SPEED: Number(process.env.KOKORO_SPEED || 1.05),

  SCENES: [
    { id: 'cold-open', line: 'Ever wonder how much those Walmart trips add up to? Start by loading your orders.' },
    { id: 'reveal',
      line: 'There it is. You can see what you spent, what you saved, and how it changed month by month.',
      ming: 'There it is. [Breathing] You can see what you spent, what you saved, and how it changed month by month.' },
    // `ming` can contain documented vocal cues and natural spellings.
    // `line` stays cue-free, with phonetic spellings where Kokoro needs them.
    { id: 'settings', line: 'Choose the format you like: Excel, C S V, Jason, a printable receipt, or P D F.' },
    { id: 'dark', line: 'Oh, and there’s dark mode.', ming: '[Surprise-oh] And there’s dark mode.' },
    { id: 'drill', line: 'Curious about one month? Click its bar to see just those orders and totals.' },
    { id: 'items', line: 'See how prices changed on the products you buy again and again.' },
    { id: 'categories', line: 'Sort your spending into categories. If you’d group something differently, just change it.' },
    { id: 'missed', line: 'Did something arrive late, get swapped, or never show up? Missed Items puts it all in one place.' },
    { id: 'trends', line: 'And Trends shows your shopping patterns.' },
    { id: 'receipts', line: 'Open a saved order to see its invoice, including the items and payment breakdown.' },
    { id: 'export',
      line: 'Pick the orders you want and export them. Excel can even list the items you never paid for on a separate sheet.',
      ming: 'Pick the orders you want and export them. [Breathing] Excel can even list the items you never paid for on a separate sheet.' },
    { id: 'mcp',
      line: 'Want to ask your assistant a question about your orders? Optional local A I access works with Claude or another M C P tool.' },
    { id: 'trust', line: 'Your orders stay on your device. And if you want a fresh start, you can clear them from Settings.' },
    { id: 'kicker', line: 'Take a look back at your year, one basket at a time.' },
    { id: 'cta', line: 'That’s Walmart Invoice Exporter. It’s free and open source. Give it a try in Chrome.' },
  ],
};
