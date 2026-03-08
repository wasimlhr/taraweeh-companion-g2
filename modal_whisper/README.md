# Whisper Quran int8 — Modal deployment

Serves **wasimlhr/whisper-quran-v1-int8** on [Modal](https://modal.com) for Quran recitation transcription.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/` | **Model card** — JSON with model id, description, language, quantization. Use for dashboard or health. |
| **POST** | `/` | **Transcribe** — Body: raw WAV bytes. Query: `?language=ar&task=transcribe&return_timestamps=true` (default). Returns `{"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}`. |

Your backend already supports this: set `WHISPER_ENDPOINT_URL` to the Modal URL (e.g. `https://your-workspace--whisper-quran-int8-web.modal.run`).

## Deploy

```bash
pip install modal
cd modal_whisper
modal deploy app.py
```

Use the URL printed after deploy (or from [Modal dashboard](https://modal.com)) in the app’s Whisper endpoint setting.

## Optional: proxy auth

If you enable **Require proxy authentication** in the Modal endpoint settings, set in backend `.env`:

- `MODAL_KEY=...`
- `MODAL_SECRET=...`

## Timestamps

POST returns **word-level timestamps** by default: `chunks` is a list of `{"text": "word", "start": s, "end": e}` (times in seconds). Disable with `?return_timestamps=false`.

## Files

- **`app.py`** — Modal app: ASGI app with GET (model card) and POST (transcribe).
- **`handler.py`** — Loads model from HuggingFace, runs transcription with optional timestamps; used by `app.py`.

## int4 variant

A separate Modal app for the int4 model lives in **`modal_whisper_int4/`** (same API, smaller/faster model). Deploy with `cd modal_whisper_int4 && modal deploy app.py`.
