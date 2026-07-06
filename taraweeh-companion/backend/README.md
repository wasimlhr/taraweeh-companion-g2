# Taraweeh Companion Backend

WebSocket server for prayer-aware tracking. Receives PCM audio, runs Whisper ASR via **Groq** or **OpenAI**, fuzzy match, state machine.

## Setup

```bash
npm install
```

## API Keys

Transcription uses **Groq** (`whisper-large-v3-turbo`) and/or **OpenAI** (`whisper-1`). Users can bring their own key in the app, or you can host shared keys:

| Variable | Required | Where to get |
|----------|----------|--------------|
| `SHARED_GROQ_KEY` | For free/shared mode | [console.groq.com/keys](https://console.groq.com/keys) |
| `SHARED_OPENAI_KEY` | Failover when Groq 429s | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
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

Without shared keys, users must enter their own Groq or OpenAI key in **Settings → Use my own key**.

## Data

Expects `data/quran-full.json` and `data/verses-display.json` (full Quran from quran-json). Bundled in repo.

## WebSocket

- **URL**: `ws://localhost:3001/ws`
- **Send**: Raw PCM bytes (16kHz, 16-bit mono)
- **Receive**: `{ type: "state", state: { mode, surah, ayah, confidence, nonQuranText } }`
