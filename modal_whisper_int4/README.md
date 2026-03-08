# Whisper Quran int4 — Modal deployment

Serves **wasimlhr/whisper-quran-v1-int4** on [Modal](https://modal.com) for Quran recitation transcription (smaller/faster than int8, test accuracy).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/` | **Model card** — JSON with model id, description, language, quantization. |
| **POST** | `/` | **Transcribe** — Body: raw WAV bytes. Query: `?language=ar&task=transcribe&return_timestamps=true`. Returns `{"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}`. |

Same API as the int8 app; use this URL as `WHISPER_ENDPOINT_URL` to use the int4 model.

## Deploy

```bash
pip install modal
cd modal_whisper_int4
modal deploy app.py
```

## int4 model on HuggingFace

Ensure the int4 model is on the Hub (e.g. push with `quantize_whisper.py --mode int4 --push`). If the repo does not exist yet, create `wasimlhr/whisper-quran-v1-int4` and upload the quantized model.
