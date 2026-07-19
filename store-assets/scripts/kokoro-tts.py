"""Batch TTS worker for generate-voiceover.js.

Usage: .venv-kokoro/bin/python kokoro-tts.py <manifest.json>

Manifest: {"voice": "am_michael", "speed": 1.0,
           "items": [{"id": "...", "line": "...", "out": "/abs/path.wav"}]}

Loads Kokoro-82M once (auto-downloads on first run), then writes one mono
16-bit WAV per item.
"""
import json
import sys
import wave

# The bundled espeak-ng dylib (espeakng-loader) hard-exits the whole process
# with a baked-in CI data path on this machine — and since it dies via C
# exit(1), kokoro_mlx's try/except around the espeak fallback can't catch it.
# Poison the import so misaki runs dictionary-only; every narration line is
# validated against the lexicon below, so nothing can be silently dropped.
sys.modules["misaki.espeak"] = None

import numpy as np
from kokoro_mlx import KokoroTTS
from misaki import en

manifest = json.load(open(sys.argv[1]))

# Validate first: misaki drops out-of-vocabulary tokens during synthesis
# (unk=""), which would silently skip a word mid-sentence. Fail loudly here
# instead so the line can be reworded in vo-script.js.
g2p = en.G2P(unk="❓", british=False, fallback=None)
for item in manifest["items"]:
    phonemes = g2p(item["line"])
    phonemes = phonemes[0] if isinstance(phonemes, tuple) else phonemes
    if "❓" in phonemes:
        sys.exit(f"OOV word in scene '{item['id']}' — reword it: {item['line']}\n  -> {phonemes}")

tts = KokoroTTS.from_pretrained()

for item in manifest["items"]:
    result = tts.generate(item["line"], voice=manifest["voice"], speed=manifest["speed"])
    pcm = (np.clip(result.audio, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(item["out"], "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(result.sample_rate)
        w.writeframes(pcm.tobytes())
    print(f"synthesized {item['id']} ({result.duration:.2f}s)", flush=True)
