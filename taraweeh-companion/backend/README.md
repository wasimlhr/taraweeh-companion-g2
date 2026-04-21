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
| `ENDPOINT_ON_DEMAND_ENABLED` | No | `true` enables `/api/endpoint/warmup` and the "Wake endpoint" button in Settings |
| `MOBILE_ONLY_MODE` | No | `true` enforces phone mic in UI and exposes mobile-only status in Settings |
| `WHISPER_PROBE_ON_INIT` | No | `false` disables automatic endpoint probing on init (manual warmup still works when enabled) |
| `G2_SPLASH_IMAGE_DATA_URL` | No | Optional `data:image/...;base64,...` startup splash for glasses; auto center-cropped to 180x96 and sent via `updateImageRawData` |
| `G2_SPLASH_ENABLED` | No | `false` disables splash image path and uses plain text startup containers only (recommended while debugging display issues) |
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
