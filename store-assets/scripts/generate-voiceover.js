/**
 * Synthesize the tour narration locally with Kokoro-82M on MLX (Apache-2.0,
 * free, offline — no API keys, no usage license strings attached).
 *
 *   node store-assets/scripts/generate-voiceover.js
 *
 * Bootstraps .venv-kokoro (pip install kokoro-mlx) on first run, then writes
 * audio-cache/vo-<scene>.wav per scene plus vo-durations.json
 * ({ sceneId: seconds }). Clips are cached by a hash of (voice, speed, line):
 * unchanged lines are not re-synthesized on re-runs.
 *
 * Requires: Apple Silicon, python3.10–3.12 on PATH, ffprobe.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { VOICE, SPEED, SCENES } = require(path.join(__dirname, 'vo-script'));

const CACHE = path.join(__dirname, 'audio-cache');
const META = path.join(CACHE, 'vo-meta.json');
const VENV = path.join(__dirname, '.venv-kokoro');
const PY = path.join(VENV, 'bin', 'python');

const probeSeconds = (file) => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
], { encoding: 'utf8' }).trim());

function ensureVenv() {
  if (fs.existsSync(PY)) return;
  const base = ['python3.12', 'python3.11', 'python3.10'].find((p) => {
    try { execFileSync(p, ['--version']); return true; } catch { return false; }
  });
  if (!base) throw new Error('kokoro-mlx needs python 3.10–3.12 on PATH');
  console.log(`bootstrapping ${path.basename(VENV)} with ${base} (one-time)…`);
  execFileSync(base, ['-m', 'venv', VENV], { stdio: 'inherit' });
  execFileSync(PY, ['-m', 'pip', 'install', '-q', 'kokoro-mlx'], { stdio: 'inherit' });
}

(() => {
  fs.mkdirSync(CACHE, { recursive: true });
  const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8')) : {};
  const durations = {};

  const pending = [];
  for (const { id, line } of SCENES) {
    const file = path.join(CACHE, `vo-${id}.wav`);
    const hash = crypto.createHash('sha256').update(`kokoro|${VOICE}|${SPEED}|${line}`).digest('hex');
    if (meta[id] === hash && fs.existsSync(file)) {
      console.log(`vo-${id}.wav cached`);
    } else {
      pending.push({ id, line, out: file, hash });
    }
  }

  if (pending.length) {
    ensureVenv();
    const manifest = path.join(CACHE, 'tts-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      voice: VOICE,
      speed: SPEED,
      items: pending.map(({ id, line, out }) => ({ id, line, out })),
    }, null, 2));
    execFileSync(PY, [path.join(__dirname, 'kokoro-tts.py'), manifest], { stdio: 'inherit' });
    for (const { id, hash } of pending) meta[id] = hash;
    fs.writeFileSync(META, JSON.stringify(meta, null, 2));
  }

  for (const { id } of SCENES) durations[id] = probeSeconds(path.join(CACHE, `vo-${id}.wav`));
  fs.writeFileSync(path.join(CACHE, 'vo-durations.json'), JSON.stringify(durations, null, 2));
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  console.log(`narration total ${total.toFixed(1)}s across ${SCENES.length} scenes (voice ${VOICE})`);
})();
