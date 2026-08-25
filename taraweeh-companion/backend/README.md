# Taraweeh Companion Backend

WebSocket server for prayer-aware tracking. Receives PCM audio, runs Whisper ASR via **Groq** or **OpenAI**, fuzzy match, state machine.

## Setup

```bash
npm install
```

## API Keys

Transcription uses **Groq** or **OpenAI** independently. Pick one engine; it must lock verses on its own (nothing is a backup).

| Variable | Required | Where to get |
|----------|----------|--------------|
| `SHARED_GROQ_KEY` | For free/shared Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| `SHARED_OPENAI_KEY` | For free/shared OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `SHARED_DEEPGRAM_KEY` | Optional extra engine | [console.deepgram.com](https://console.deepgram.com/) |
| `SHARED_ELEVENLABS_KEY` | Optional extra engine | [elevenlabs.io API keys](https://elevenlabs.io/app/settings/api-keys) |
| `GEMINI_API_KEY` | No (Pro) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `MAX_MIN_PER_SESSION` | No | Cap shared-key sessions (default `90` min) |
| `MOBILE_ONLY_MODE` | No | `true` enforces phone mic in UI |
| `PORT` | No | Default 3001 |

```bash
# With shared keys (PowerShell)
$env:SHARED_GROQ_KEY = "gsk_your_key"
$env:SHARED_OPENAI_KEY = "sk_your_key"
npm run start

# Or one-liner
SHARED_GROQ_KEY=gsk_xxx SHARED_OPENAI_KEY=sk_xxx npm run start
```

Without shared keys, users must enter their own Groq, Deepgram, ElevenLabs, or OpenAI key in **Settings → Use my own key**.

## Data

Expects `data/quran-full.json` and `data/verses-display.json` (full Quran from quran-json). Bundled in repo.

## WebSocket

- **URL**: `ws://localhost:3001/ws`
- **Send**: Raw PCM bytes (16kHz, 16-bit mono)
- **Receive**: `{ type: "state", state: { mode, surah, ayah, confidence, nonQuranText } }`
# Local TLS

Railway provides managed TLS and does not use files under `backend/certs`. For local browser microphone testing, run `node genCerts.js` to create ignored development-only certificates. Plain HTTP remains supported on `localhost`; never configure a non-loopback HTTP backend when using BYOK credentials.

Shared provider keys are disabled for clients unless `SHARED_ACCESS_TOKEN` is configured and the same token is supplied during WebSocket initialization. Railway deployments can tune the `WS_MAX_*` and `SHARED_*_CALLS_PER_MINUTE` / `SHARED_*_CONCURRENCY` limits for their plan. BYOK calls do not consume shared quotas.
