#!/usr/bin/env python3
"""
Local stand-in for the Groq Whisper endpoint, so the pipeline can be driven by
real recitation audio without an API key.

Accepts the same thing groqProvider sends — a WAV body — and answers with text
plus word timestamps in the same shape. Runs faster-whisper on CPU, so it is
slower and less accurate than whisper-large-v3-turbo; any result measured
against it is a lower bound on what Groq would give.

  python3 scripts/local-whisper-server.py [--model=small] [--port=8123]
"""
import argparse
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument('--model', default='small')
parser.add_argument('--port', type=int, default=8123)
parser.add_argument('--compute', default='int8')
args = parser.parse_args()

print(f'[whisper] loading {args.model} ({args.compute}) on cpu', flush=True)
MODEL = WhisperModel(args.model, device='cpu', compute_type=args.compute)
print(f'[whisper] ready on :{args.port}', flush=True)

calls = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        global calls
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length)
        t0 = time.time()
        try:
            # Groq returns text for these short windows, so keep this model from
            # discarding them: the default no-speech and compression gates drop a
            # lot of 6s recitation clips outright, which would look like a
            # pipeline failure rather than an ASR one.
            segments, _ = MODEL.transcribe(
                io.BytesIO(body), language='ar', word_timestamps=True,
                temperature=[0.0, 0.2, 0.4], condition_on_previous_text=False,
                no_speech_threshold=0.95, compression_ratio_threshold=4.0,
                log_prob_threshold=-2.0, vad_filter=False, beam_size=5,
            )
            words, texts = [], []
            for seg in segments:
                texts.append(seg.text)
                for w in (seg.words or []):
                    words.append({'word': w.word.strip(), 'start': w.start, 'end': w.end})
            payload = {'text': ' '.join(texts).strip(), 'words': words}
        except Exception as exc:                      # noqa: BLE001
            payload = {'text': '', 'words': [], 'error': str(exc)}
        calls += 1
        dur = time.time() - t0
        print(f'[whisper] #{calls} {len(body)}B in {dur:.2f}s -> "{payload["text"][:60]}"', flush=True)
        out = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


try:
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
except KeyboardInterrupt:
    sys.exit(0)
