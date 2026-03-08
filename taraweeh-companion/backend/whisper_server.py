"""
Local Whisper Server — Runs your fine-tuned model on GPU
Start: py -3.12 server/whisper_server.py
Then set USE_LOCAL_WHISPER=true in .env

Endpoint: POST /transcribe
  Body: multipart form with 'file' (WAV audio)
  Returns: { "text": "Arabic transcription" }
"""

import io
import torch
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from transformers import WhisperProcessor, WhisperForConditionalGeneration
import warnings
import logging

# Suppress all warnings
warnings.filterwarnings("ignore")
logging.getLogger("transformers").setLevel(logging.ERROR)

MODEL_ID = "wasimlhr/whisper-quran-phase1-step4500"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if torch.cuda.is_available() else torch.float32
PORT = 8000

print(f"Loading {MODEL_ID} on {DEVICE}...")
processor = WhisperProcessor.from_pretrained(MODEL_ID, language="ar", task="transcribe")
model = WhisperForConditionalGeneration.from_pretrained(
    MODEL_ID, torch_dtype=DTYPE
).to(DEVICE)
model.eval()
print(f"Model loaded ({model.num_parameters()/1e6:.0f}M params)")


def transcribe(wav_bytes):
    """Transcribe WAV audio bytes to Arabic text."""
    import soundfile as sf

    audio_data, sr = sf.read(io.BytesIO(wav_bytes))
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)  # Mono

    if sr != 16000:
        import librosa
        audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)

    audio_data = audio_data.astype(np.float32)
    inputs = processor(audio_data, sampling_rate=16000, return_tensors="pt")
    feats = inputs.input_features.to(DEVICE, dtype=DTYPE)

    with torch.no_grad():
        ids = model.generate(
            feats,
            language="ar",
            task="transcribe",
            max_new_tokens=448,
        )

    text = processor.batch_decode(ids, skip_special_tokens=True)[0]
    return text.strip()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Parse multipart form data (simple extraction)
        content_type = self.headers.get("Content-Type", "")

        if "multipart/form-data" in content_type:
            boundary = content_type.split("boundary=")[1].encode()
            parts = body.split(b"--" + boundary)
            wav_data = None
            for part in parts:
                if b"filename=" in part:
                    # Extract file data after double newline
                    idx = part.find(b"\r\n\r\n")
                    if idx >= 0:
                        wav_data = part[idx + 4:].rstrip(b"\r\n--")
                    break
            if not wav_data:
                self.send_error(400, "No file found in form data")
                return
        else:
            # Raw WAV body
            wav_data = body

        try:
            text = transcribe(wav_data)
            response = f'{{"text": "{text}"}}'.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(response)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"error": "{str(e)}"}}'.encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        # Quiet logging
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\nWhisper server running on http://localhost:{PORT}/transcribe")
    print(f"  Model: {MODEL_ID}")
    print(f"  Device: {DEVICE}")
    print(f"  Dtype: {DTYPE}\n")
    server.serve_forever()
