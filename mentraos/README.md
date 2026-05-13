# Quran Companion — MentraOS Port

Real-time Quran verse tracking for **MentraOS smart glasses** (Even Realities G1, Mentra Mach1, Vuzix Z100, and any other MentraOS-compatible device).

This is a port of the existing Even G2 Taraweeh Companion app to the MentraOS platform. It reuses the entire backend pipeline (AudioPipelineV4, Quran keyword matcher, transcription router) unchanged — only the hardware interface layer is new.

---

## Architecture

```
MentraOS Glasses mic
        ↓  (raw PCM 16kHz mono via session.audio.getMicrophoneStream())
MentraSessionBridge
        ↓  (Buffer chunks → pipeline.ingest())
AudioPipelineV4  ←── existing backend, zero changes
        ↓  (onStateUpdate callbacks)
DisplayFormatter
        ↓  (session.layouts.showDoubleTextWall / showReferenceCard / showTextWall)
MentraOS Glasses HUD
```

**Key insight:** MentraOS delivers raw PCM audio at 16kHz mono — exactly the format AudioPipelineV4 already expects from the Even G2 WebSocket connection. The bridge is a thin adapter, not a rewrite.

---

## Prerequisites

- Node.js ≥ 18
- A **MentraOS Developer Account** — register at [developer.mentraglass.com](https://developer.mentraglass.com)
- A **Groq API key** (free tier works) or **OpenAI API key** for transcription
- The Quran data files from the existing backend (`taraweeh-companion/backend/data/`)

---

## Setup

### 1. Install dependencies

```bash
# From repo root:
npm run mentraos:install

# Or directly:
cd mentraos && npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
MENTRA_API_KEY=your_mentra_api_key_here
MENTRA_PACKAGE_NAME=com.taraweehcompanion.mentraos

# Required — at least one transcription key
GROQ_API_KEY=your_groq_api_key_here
# or
OPENAI_API_KEY=your_openai_api_key_here

# Optional
DEFAULT_SURAH=0          # 0 = auto-detect, 1-114 = start from specific surah
PIPELINE_VERSION=v4      # v3 or v4
TRANSLATION_LANG=        # '' = built-in English, or: en, ur, fr, es, id, tr, bn, zh, ru, sv
DISPLAY_MODE=both        # arabic | translation | both
```

### 3. Register your app in the Developer Portal

1. Go to [developer.mentraglass.com](https://developer.mentraglass.com)
2. Create a new app with:
   - **Package name:** `com.taraweehcompanion.mentraos`
   - **Permissions:** `microphone`
   - **Endpoint URL:** your server's public HTTPS URL (see step 5)
3. Copy your **API key** into `.env`

### 4. Run locally

```bash
# From repo root:
npm run mentraos:dev

# Or directly:
cd mentraos && npm run dev
```

### 5. Expose locally for testing

```bash
ngrok http 3000
```

Update the endpoint URL in the Developer Portal to your ngrok URL.

---

## Controls

### Button Controls

| Button | Action |
|---|---|
| Main — single press | Advance to next ayah |
| Main — long press | Go back to previous ayah |
| Secondary — single press | Cycle display mode (both → arabic → translation) |
| Secondary — long press | Reset pipeline (re-detect from scratch) |
| Volume Up | Toggle fast mode (quicker auto-advance) |
| Volume Down | Toggle slow mode (lingering display) |

### Head Gesture Controls

| Gesture | Action |
|---|---|
| Nod | Advance to next ayah |
| Shake | Go back to previous ayah |
| Look Up | Toggle Taraweeh mode |
| Look Down | Reset rakat counter (Taraweeh mode) |

---

## Display Modes

| Mode | What's shown |
|---|---|
| `both` (default) | Arabic verse (top) + transliteration or translation (bottom) |
| `arabic` | Arabic verse only (reference card with surah:ayah title) |
| `translation` | English/selected translation only |

Cycle modes at runtime with the secondary button.

---

## Deployment

### Railway (recommended — same as the Even G2 backend)

```bash
npm install -g @railway/cli
railway login
cd mentraos
railway up
```

Set environment variables in the Railway dashboard, then update the endpoint URL in the MentraOS Developer Portal.

### Fly.io

```bash
cd mentraos
fly launch
fly deploy
```

### Environment Variables for Production

```
MENTRA_API_KEY=...
MENTRA_PACKAGE_NAME=com.taraweehcompanion.mentraos
GROQ_API_KEY=...          # or OPENAI_API_KEY
PORT=3000
DISPLAY_MODE=both
DEFAULT_SURAH=0
PIPELINE_VERSION=v4
TRANSLATION_LANG=
```

---

## Differences from the Even G2 App

| Feature | Even G2 | MentraOS |
|---|---|---|
| Audio input | WebSocket PCM from browser/G2 mic | `session.audio.getMicrophoneStream()` |
| Display | HTML/CSS WebView in EvenHub | `session.layouts.*` (native HUD) |
| Controls | Touch UI in phone app | Button presses + head gestures |
| Transcription | Groq / OpenAI / HF Whisper | Same (unchanged) |
| Verse matching | AudioPipelineV4 | Same (unchanged) |
| Taraweeh mode | ✅ | ✅ |
| Fast/slow mode | ✅ | ✅ |
| Manual advance/prev | ✅ | ✅ (button + gesture) |
| Multi-language translation | ✅ | ✅ |
| Mushaf page display | ✅ (WebView) | ❌ (HUD too small) |

---

## File Structure

```
mentraos/
├── src/
│   ├── index.ts              # AppServer entry point
│   ├── mentraSessionBridge.ts # Wires MentraOS session → AudioPipelineV4
│   └── displayFormatter.ts   # Converts pipeline state → session.layouts.*
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

The existing backend files are imported directly from `../taraweeh-companion/backend/` — no duplication.
