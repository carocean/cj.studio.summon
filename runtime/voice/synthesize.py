#!/usr/bin/env python3
"""Private one-shot offline TTS worker. No download, shell, history or text logging."""
import argparse
import json
import os
from pathlib import Path
import sys
import wave

MAX_BYTES = 2 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError()
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {'text'}:
        raise ValueError()
    text = request['text']
    if not isinstance(text, str) or not text.strip() or len(text) > 600 or any(ord(c) < 32 and c not in '\t\n\r' or ord(c) == 127 for c in text):
        raise ValueError()
    p = Path(args.model_dir)
    if not p.is_absolute():
        raise ValueError()
    for name in ['model.onnx', 'tokens.txt', 'lexicon.txt', 'date.fst', 'phone.fst', 'number.fst']:
        if not (p / name).is_file():
            raise ValueError()
    import numpy as np
    import sherpa_onnx as s
    config = s.OfflineTtsConfig(model=s.OfflineTtsModelConfig(vits=s.OfflineTtsVitsModelConfig(model=str(p/'model.onnx'), lexicon=str(p/'lexicon.txt'), tokens=str(p/'tokens.txt')), num_threads=2, provider='cpu'), rule_fsts=','.join(str(p/name) for name in ['date.fst', 'phone.fst', 'number.fst']))
    if not config.validate():
        raise ValueError()
    tts = s.OfflineTts(config)
    audio = tts.generate(text, sid=0, speed=1.0)
    samples = np.asarray(audio.samples)
    if not samples.size or samples.size * 2 + 44 > MAX_BYTES or not np.isfinite(samples).all():
        raise ValueError()
    # Exclusive private file creation. Parent reads only after exit and deletes on
    # every outcome; no partially generated WAV is served.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        with wave.open(stream, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(audio.sample_rate)
            wav.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not disclose text, model diagnostics, local paths or environment.
        sys.exit(2)
