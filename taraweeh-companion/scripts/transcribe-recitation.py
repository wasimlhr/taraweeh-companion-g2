#!/usr/bin/env python3
"""
Transcribe a fetched recitation once, with absolute word timestamps, so the
real-audio bench can serve any window the pipeline asks for without paying for a
model run per request.

Uses large-v3-turbo, the same family Groq serves, in float32 — int8 quantisation
of this model produces multilingual garbage on CPU.

  python3 scripts/transcribe-recitation.py --dir=/tmp/recitations/<tag>
"""
import argparse
import json
import os
import time

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument('--dir', required=True)
parser.add_argument('--model', default='deepdml/faster-whisper-large-v3-turbo-ct2')
parser.add_argument('--compute', default='float32')
args = parser.parse_args()

audio = os.path.join(args.dir, 'audio.wav')
out = os.path.join(args.dir, 'transcript.json')
if not os.path.exists(audio):
    raise SystemExit(f'missing {audio}')

print(f'[transcribe] {audio} with {args.model} ({args.compute})', flush=True)
model = WhisperModel(args.model, device='cpu', compute_type=args.compute, cpu_threads=4)

t0 = time.time()
segments, info = model.transcribe(
    audio, language='ar', word_timestamps=True, temperature=0,
    condition_on_previous_text=False, vad_filter=False,
)
words, texts = [], []
for seg in segments:
    texts.append(seg.text.strip())
    for w in (seg.words or []):
        words.append({'word': w.word.strip(), 'start': w.start, 'end': w.end})

payload = {
    'model': args.model,
    'compute': args.compute,
    'durationSec': info.duration,
    'text': ' '.join(texts),
    'words': words,
}
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, ensure_ascii=False)

print(f'[transcribe] {len(words)} words in {time.time() - t0:.0f}s -> {out}', flush=True)
print(f'[transcribe] head: {payload["text"][:160]}', flush=True)
