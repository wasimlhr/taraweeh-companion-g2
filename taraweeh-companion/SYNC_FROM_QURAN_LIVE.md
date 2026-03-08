# Taraweeh Companion (synced)

This folder is a clone of [wasimlhr/taraweeh-companion-g2](https://github.com/wasimlhr/taraweeh-companion-g2), kept inside **QuranLiveMeaning** for integration with the Whisper Quran endpoint and word-level timestamps.

## Updates applied here (word-level timestamps)

- **`backend/whisperProvider.js`**
  - **`parseTranscription()`**  
    - Accepts the new response shape: `{ text, chunks, words }` with each word as `{ text, start, end }` (or `timestamp: [start, end]`).  
    - **`normalizeWord()`**  
      - Converts any word-like object to `{ text, start, end }` (`start`/`end` as numbers or `null`).  
    - Words are taken from `result.words ?? result.chunks` and normalized so the rest of the app always sees the same shape.
  - **Dedicated / Modal requests**  
    - Query params now include `return_timestamps=true` plus `language=ar` and `task=transcribe` so the HF Inference Endpoint and Modal return word-level timestamps.

The backend and V4 pipeline already use `result.words`; they now receive a consistent `{ text, start, end }` per word (or mock timestamps when the endpoint does not provide them).

## Running

From this folder (or the repo root, if your start script points here):

```bash
cd backend && npm install && cd ..
npm run backend:dev   # or whatever your start command is
```

Set `WHISPER_ENDPOINT_URL` to your HF endpoint (e.g. `https://xxx.us-east-1.aws.endpoints.huggingface.cloud`) or Modal URL so the app uses the Quran Whisper model with word-level timestamps.
