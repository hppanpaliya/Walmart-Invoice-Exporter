/**
 * Generate local narration with Ming 3.0 TTS 0.5B on MLX when installed,
 * otherwise with Kokoro-82M on MLX. Never invoke the OS speech synthesizer.
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
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { VOICE, SPEED, SCENES } = require(path.join(__dirname, 'vo-script'));

const CACHE = path.join(__dirname, 'audio-cache');
const META = path.join(CACHE, 'vo-meta.json');
const VENV = path.join(__dirname, '.venv-kokoro');
const PY = path.join(VENV, 'bin', 'python');

const mingBin = process.env.MING_TTS_BIN || path.join(os.homedir(), '.local/bin/ming-tts');
const mingDir = process.env.MING_MODEL_DIR
  || path.join(os.homedir(), '.local/share/ming-tts-serve/models/Ming-3.0-tts-0.5b');
const mingVoice = 'US_Emma';
const useMing = Boolean(process.env.MING_TTS_BIN || process.env.MING_MODEL_DIR
  || fs.existsSync(path.join(mingDir, 'model.safetensors')));

const probeSeconds = (file) => Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
], { encoding: 'utf8' }).trim());

// Ming understands the inline delivery cues. Kokoro receives the cue-free line.
const textFor = (s) => (useMing ? (s.ming || s.line) : s.line);
const hashFor = (s) => crypto.createHash('sha256').update(
  useMing
    ? `ming-3.0-tts-0.5b-mlx|${mingVoice}|${textFor(s)}`
    : `kokoro|${VOICE}|${SPEED}|${s.line}`
).digest('hex');

function synthMing(pending, onDone) {
  for (const item of pending) {
    const raw = item.out.replace(/\.wav$/, '.ming.wav');
    try {
      execFileSync(mingBin, ['say', '--model', mingDir, '--out', raw, '--json',
        JSON.stringify({ task: 'IP', voice: mingVoice, text: item.text })], { stdio: 'inherit' });
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ar', '44100', '-ac', '1', item.out]);
    } finally {
      fs.rmSync(raw, { force: true });
    }
    console.log(`synthesized ${item.id} (${probeSeconds(item.out).toFixed(2)}s)`);
    onDone(item);
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

Promise.resolve().then(() => {
  fs.mkdirSync(CACHE, { recursive: true });
  if (useMing) {
    fs.accessSync(path.join(mingDir, 'model.safetensors'), fs.constants.R_OK);
    if (path.isAbsolute(mingBin)) fs.accessSync(mingBin, fs.constants.X_OK);
  }
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
    if (useMing) synthMing(pending, checkpoint);
    else { synthKokoro(pending); pending.forEach(checkpoint); }
  }

  for (const { id } of SCENES) durations[id] = probeSeconds(path.join(CACHE, `vo-${id}.wav`));
  fs.writeFileSync(path.join(CACHE, 'vo-durations.json'), JSON.stringify(durations, null, 2));
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  const voice = useMing ? `Ming 3.0 TTS 0.5B (MLX), ${mingVoice}` : `Kokoro-82M (MLX), ${VOICE}`;
  console.log(`narration total ${total.toFixed(1)}s across ${SCENES.length} scenes (${voice})`);
}).catch((err) => { console.error(err.message || err); process.exit(1); });
