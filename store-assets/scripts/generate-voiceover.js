/**
 * Synthesize the tour narration. Two providers:
 *
 *  - elevenlabs (default whenever a key is present): far more human ad read.
 *    Key comes from $ELEVENLABS_API_KEY or audio-cache/elevenlabs-key.txt
 *    (audio-cache/ is gitignored — never commit the key). Voice + delivery
 *    settings live in vo-script.js (ELEVEN block).
 *  - kokoro: local Kokoro-82M on MLX (Apache-2.0: free, offline, no key).
 *    Bootstraps .venv-kokoro (pip install kokoro-mlx) on first run.
 *
 * Force one with VO_PROVIDER=kokoro|elevenlabs.
 *
 *   node store-assets/scripts/generate-voiceover.js
 *
 * Writes audio-cache/vo-<scene>.wav per scene plus vo-durations.json
 * ({ sceneId: seconds }). Clips are cached by a hash of (provider, voice,
 * settings, text): unchanged lines are not re-synthesized on re-runs.
 *
 * Requires: ffmpeg/ffprobe; kokoro path additionally needs Apple Silicon +
 * python3.10–3.12 on PATH.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { VOICE, SPEED, ELEVEN, SCENES } = require(path.join(__dirname, 'vo-script'));

const CACHE = path.join(__dirname, 'audio-cache');
const META = path.join(CACHE, 'vo-meta.json');
const VENV = path.join(__dirname, '.venv-kokoro');
const PY = path.join(VENV, 'bin', 'python');

fs.mkdirSync(CACHE, { recursive: true });
const keyFile = path.join(CACHE, 'elevenlabs-key.txt');
const elevenKey = process.env.ELEVENLABS_API_KEY
  || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
const provider = process.env.VO_PROVIDER || (elevenKey ? 'elevenlabs' : 'kokoro');
if (provider === 'elevenlabs' && !elevenKey) {
  throw new Error('VO_PROVIDER=elevenlabs but no key in $ELEVENLABS_API_KEY or audio-cache/elevenlabs-key.txt');
}

const probeSeconds = (file) => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
], { encoding: 'utf8' }).trim());

// ElevenLabs pronounces initialisms naturally, so it reads each scene's plain
// `natural` text when present; kokoro always gets the phonetically-spelled
// `line` (see the note in vo-script.js).
const textFor = (s) => (provider === 'elevenlabs' ? (s.natural || s.line) : s.line);
const hashFor = (s) => crypto.createHash('sha256').update(
  provider === 'elevenlabs'
    ? `eleven|${ELEVEN.VOICE_ID}|${ELEVEN.MODEL}|${JSON.stringify(ELEVEN.SETTINGS)}|${textFor(s)}`
    : `kokoro|${VOICE}|${SPEED}|${s.line}`
).digest('hex');

async function synthElevenLabs(pending, onDone) {
  for (const item of pending) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN.VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text, model_id: ELEVEN.MODEL, voice_settings: ELEVEN.SETTINGS }),
      }
    );
    if (!res.ok) throw new Error(`elevenlabs ${res.status} on '${item.id}': ${await res.text()}`);
    const mp3 = item.out.replace(/\.wav$/, '.tmp.mp3');
    fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
    // Downstream (build-audio.js, scene floors) expects mono 44.1 kHz WAVs.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-ar', '44100', '-ac', '1', item.out]);
    fs.rmSync(mp3);
    console.log(`synthesized ${item.id} (${probeSeconds(item.out).toFixed(2)}s)`);
    onDone(item); // checkpoint the cache per clip — paid API calls must never re-bill after a mid-batch failure
  }
}

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

function synthKokoro(pending) {
  ensureVenv();
  const manifest = path.join(CACHE, 'tts-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    voice: VOICE,
    speed: SPEED,
    items: pending.map(({ id, text, out }) => ({ id, line: text, out })),
  }, null, 2));
  execFileSync(PY, [path.join(__dirname, 'kokoro-tts.py'), manifest], { stdio: 'inherit' });
}

(async () => {
  const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, 'utf8')) : {};
  const durations = {};

  const pending = [];
  for (const scene of SCENES) {
    const file = path.join(CACHE, `vo-${scene.id}.wav`);
    const hash = hashFor(scene);
    if (meta[scene.id] === hash && fs.existsSync(file)) {
      console.log(`vo-${scene.id}.wav cached`);
    } else {
      pending.push({ id: scene.id, text: textFor(scene), out: file, hash });
    }
  }

  if (pending.length) {
    const checkpoint = ({ id, hash }) => {
      meta[id] = hash;
      fs.writeFileSync(META, JSON.stringify(meta, null, 2));
    };
    if (provider === 'elevenlabs') await synthElevenLabs(pending, checkpoint);
    else { synthKokoro(pending); pending.forEach(checkpoint); }
  }

  for (const { id } of SCENES) durations[id] = probeSeconds(path.join(CACHE, `vo-${id}.wav`));
  fs.writeFileSync(path.join(CACHE, 'vo-durations.json'), JSON.stringify(durations, null, 2));
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  const voice = provider === 'elevenlabs' ? `elevenlabs ${ELEVEN.VOICE_NAME}` : `kokoro ${VOICE}`;
  console.log(`narration total ${total.toFixed(1)}s across ${SCENES.length} scenes (${voice})`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
