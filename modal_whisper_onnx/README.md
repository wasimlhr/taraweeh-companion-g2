# Whisper Quran ONNX — Modal deployment

Serves **wasimlhr/whisper-quran-v1-onnx-quantized** on [Modal](https://modal.com) for Quran recitation transcription. Same API as the int8/int4 PyTorch apps; uses ONNX Runtime for inference.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/` | **Model card** — JSON with model id, description, language, quantization. Use for dashboard or health. |
| **POST** | `/` | **Transcribe** — Body: raw WAV bytes. Query: `?language=ar&task=transcribe&return_timestamps=true` (default). Returns `{"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}`. |

Use the Modal URL (e.g. `https://your-workspace--whisper-quran-onnx-web.modal.run`) as `WHISPER_ENDPOINT_URL` in your backend.

## Deploy

```bash
pip install modal
cd modal_whisper_onnx
modal deploy app.py
```

Copy the URL printed after deploy (or from the [Modal dashboard](https://modal.com)) into your app’s Whisper endpoint setting.

## Optional: proxy auth

If you enable **Require proxy authentication** on the Modal endpoint, set in backend `.env`:

- `MODAL_KEY=...`
- `MODAL_SECRET=...`

## Timestamps

POST returns **word-level timestamps** by default: `chunks` is a list of `{"text": "word", "start": s, "end": e}` (times in seconds). Disable with `?return_timestamps=false`.

## Files

- **`app.py`** — Modal app: ASGI app with GET (model card) and POST (transcribe).
- **`handler.py`** — Loads ONNX model from HuggingFace, runs transcription with optional timestamps.

## Model

- **HF repo:** [wasimlhr/whisper-quran-v1-onnx-quantized](https://huggingface.co/wasimlhr/whisper-quran-v1-onnx-quantized)
- **Format:** ONNX with dynamic int8 quantization (~1.6GB). No `bitsandbytes` required; runs with ONNX Runtime (GPU or CPU).

## Other variants

- **int8 (PyTorch):** `modal_whisper/` — `wasimlhr/whisper-quran-v1-int8`
- **int4 (PyTorch):** `modal_whisper_int4/` — `wasimlhr/whisper-quran-v1-int4`
