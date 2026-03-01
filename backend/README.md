# Taraweeh Companion Backend

WebSocket server for prayer-aware tracking. Receives PCM audio, runs Whisper ASR, fuzzy match, state machine.

## Setup

```bash
npm install
```

## API Keys

See **[docs/SETUP.md](../docs/SETUP.md)** for full instructions. Quick start:

| Variable | Required | Where to get |
|----------|----------|--------------|
| `HUGGINGFACE_TOKEN` | Yes | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) |
| `GEMINI_API_KEY` | No (Pro) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `PORT` | No | Default 3001 |

```bash
# With your keys (PowerShell)
$env:HUGGINGFACE_TOKEN = "hf_your_token"
$env:GEMINI_API_KEY = "your_gemini_key"
npm run start

# Or one-liner
HUGGINGFACE_TOKEN=hf_xxx GEMINI_API_KEY=xxx npm run start
```

## Data

Expects `../public/data/quran-full.json` (full Quran from quran-json). Ensure it exists.

## WebSocket

- **URL**: `ws://localhost:3001/ws`
- **Send**: Raw PCM bytes (16kHz, 16-bit mono, 3s chunks = 96000 bytes)
- **Receive**: `{ type: "state", state: { mode, surah, ayah, confidence, nonQuranText } }`
