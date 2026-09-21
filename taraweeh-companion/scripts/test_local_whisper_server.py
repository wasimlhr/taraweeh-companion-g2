"""Exercise multipart handling and lazy CPU inference without downloading a model."""
import importlib.util
import io
import json
import sys
from pathlib import Path
import threading
import time
import unittest
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('local_whisper', Path(__file__).with_name('local-whisper-server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def wav_bytes():
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b'\0\0' * 160)
    return out.getvalue()


class WhisperServerTests(unittest.TestCase):
    def test_multipart_extracts_exact_wav_without_trailing_fields(self):
        wav = wav_bytes()
        body = (b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n'
                b'Content-Type: audio/wav\r\n\r\n' + wav + b'\r\n--boundary\r\nname="model"\r\n\r\nwhisper\r\n--boundary--')
        self.assertEqual(server.extract_wav(body), wav)
        self.assertEqual(server.extract_wav(wav), wav)

    def test_concurrent_requests_hold_lock_through_lazy_decoding(self):
        wav = wav_bytes()
        lock_states, active_counts, uploaded = [], [], []
        active = 0

        class Model:
            def transcribe(self, audio, **kwargs):
                uploaded.append(audio.read())

                def segments():
                    nonlocal active
                    lock_states.append(server.INFER_LOCK.locked())
                    active += 1
                    active_counts.append(active)
                    try:
                        time.sleep(0.05)
                        yield SimpleNamespace(text='test recitation', words=[
                            SimpleNamespace(word='test', start=0.0, end=0.5)])
                    finally:
                        active -= 1
                return segments(), None

        server.MODEL = Model()
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        barrier = threading.Barrier(2)

        def request():
            barrier.wait(timeout=5)
            body = b'--boundary\r\nContent-Type: audio/wav\r\n\r\n' + wav + b'\r\n--boundary--'
            req = urllib.request.Request(f'http://127.0.0.1:{httpd.server_port}/v1/audio/transcriptions',
                                         data=body, headers={'Content-Type': 'multipart/form-data; boundary=boundary'})
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: request(), range(2)))
            self.assertEqual(lock_states, [True, True])
            self.assertEqual(max(active_counts), 1)
            self.assertEqual(uploaded, [wav, wav])
            self.assertTrue(all(r['text'] == 'test recitation' for r in results))
            self.assertEqual(results[0]['words'][0]['end'], 0.5)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
