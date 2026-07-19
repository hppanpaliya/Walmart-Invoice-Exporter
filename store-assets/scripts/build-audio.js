/**
 * Build the tour's audio track: narration clips placed at their scene start
 * offsets (video-raw/timeline.json, written by store-video.js), optionally
 * over a music bed.
 *
 *   node store-assets/scripts/build-audio.js
 *
 * Music bed: drop any royalty-free track at audio-cache/music.mp3 (or .m4a /
 * .wav) and it gets mixed under the narration at -17 dB with fades. If no
 * such file exists the track is narration-only — still correct, just no bed.
 * Output: video-raw/audio.m4a, muxed into the MP4s by generate-store-video.sh.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { SCENES } = require(path.join(__dirname, 'vo-script'));

const RAW = path.join(__dirname, 'video-raw');
const CACHE = path.join(__dirname, 'audio-cache');

const probeSeconds = (file) => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
], { encoding: 'utf8' }).trim());

(() => {
  const { total, scenes } = JSON.parse(fs.readFileSync(path.join(RAW, 'timeline.json'), 'utf8'));

  const known = new Set(SCENES.map((s) => s.id));
  const clips = scenes
    .filter((s) => known.has(s.id) && fs.existsSync(path.join(CACHE, `vo-${s.id}.wav`)))
    .map((s) => ({ file: path.join(CACHE, `vo-${s.id}.wav`), startMs: Math.round(s.start * 1000) }));
  if (!clips.length) throw new Error('no narration clips found — run generate-voiceover.js first');

  const music = ['music.mp3', 'music.m4a', 'music.wav']
    .map((f) => path.join(CACHE, f)).find((f) => fs.existsSync(f));

  // Base layer: music bed at -17 dB with fades (looped if shorter than the
  // video), or plain silence — either way it pins the track to `total`.
  const inputs = [];
  const filters = [];
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    filters.push(
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.14,` +
      `atrim=0:${total.toFixed(3)},afade=t=in:st=0:d=1.2,` +
      `afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[bg]`
    );
    console.log(`music bed: ${path.basename(music)} (${probeSeconds(music).toFixed(1)}s source)`);
  } else {
    inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
    filters.push(`[0:a]atrim=0:${total.toFixed(3)}[bg]`);
    console.log('no audio-cache/music.* found — narration-only track');
  }

  const mixIns = ['[bg]'];
  clips.forEach((c, i) => {
    inputs.push('-i', c.file);
    filters.push(
      `[${i + 1}:a]aformat=sample_rates=44100:channel_layouts=stereo,` +
      `adelay=${c.startMs}|${c.startMs}[v${i}]`
    );
    mixIns.push(`[v${i}]`);
  });
  filters.push(
    `${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:normalize=0,` +
    `alimiter=limit=0.97[mix]`
  );

  const out = path.join(RAW, 'audio.m4a');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k', out,
  ], { stdio: 'inherit' });
  console.log(`audio track written: ${out} (${probeSeconds(out).toFixed(1)}s, ${clips.length} narration clips${music ? ', music bed' : ''})`);
})();
