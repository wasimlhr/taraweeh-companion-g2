"""Verify the exact MP3 performance against the paired, timestamped Opus.

No timing is stretched to make a different recording appear synchronized.
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np

root = Path(sys.argv[1])
surah = sys.argv[2]
metadata = json.loads((root / 'timings' / (surah + '.json')).read_text(encoding='utf8'))['metadata']
duration = metadata['duration_ms'] / 1000

def samples(path, start):
    result = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', str(path), '-t', '12', '-ac', '1', '-ar', '4000', '-f', 'f32le', 'pipe:1'], capture_output=True, check=True)
    return np.frombuffer(result.stdout, dtype='<f4')

checks = []
for fraction in [0.15, 0.5, 0.85]:
    start = max(0, min(duration - 12, duration * fraction - 6))
    a = samples(root / 'recordings' / (surah + '.opus'), start)
    b = samples(root / 'recordings' / (surah + '.mp3'), start)
    n = 1 << (len(a) + len(b) - 2).bit_length()
    result = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    lag = int(np.argmax(result))
    lag = lag if lag < len(b) else lag - n
    aa = a[max(0, -lag):min(len(a), len(b) - lag)]
    bb = b[max(0, lag):min(len(b), len(a) + lag)]
    correlation = float(np.corrcoef(aa, bb)[0, 1]) if len(aa) > 1000 else 0
    checks.append({'atMs': round(start * 1000), 'offsetMs': lag / 4, 'correlation': round(correlation, 5)})
passed = all(c['correlation'] >= .75 and abs(c['offsetMs']) <= 30 for c in checks)
print(json.dumps({'surah': int(surah), 'passed': passed, 'checks': checks}))
sys.exit(0 if passed else 1)
