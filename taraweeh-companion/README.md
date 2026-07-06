# Taraweeh Companion

**Real-time Quran recitation recognition on Even Realities G2 smart glasses.**

Taraweeh Companion listens to a reciter, identifies which ayah is being recited in real time, and displays the Arabic text, transliteration, and English translation — directly on the G2 glasses lens or on a phone screen. Built for Taraweeh, daily prayers, and Quran study sessions.

---

## How It Works

```
┌──────────────┐     BLE      ┌──────────────────┐    WebSocket    ┌─────────────────────┐
│  G2 Glasses  │◄────────────►│  Even Hub (iPhone)│◄──────────────►│  Node.js Backend    │
│  (display)   │              │  (WebView proxy)  │                │  (server.js :3001)  │
└──────────────┘              └──────────────────┘                └─────────────────────┘
                                      │                                     │
                                      │ loads app/index.html                │
                                      │ streams mic audio via WS            │
                                      │                                     ▼
                                                                   ┌─────────────────────┐
                                                                   │  Whisper ASR         │
                                                                   │  (Groq / OpenAI API) │
                                                                   └─────────────────────┘
```

1. The phone mic (or G2 glasses mic) captures live audio
2. Raw PCM audio streams over WebSocket to the Node.js backend
3. Overlapping audio chunks are sent to Whisper for Arabic transcription
4. The **Keyword Anchor Matcher** scores the transcription against the full Quran corpus (6,236 ayahs) using IDF-weighted token F1 scoring
5. The **Anchor State Machine** manages lock/search/resume states with sequential win tracking
6. The **Audio Pipeline** drives a reading-pace timer that advances the display smoothly, with drift correction when the reciter is ahead or behind
7. Verse data (Arabic + transliteration + translation) is pushed back to the frontend
8. The frontend renders on the phone screen and sends a formatted text layout to the G2 glasses via the Even Hub SDK

---

## Features

### Core Recognition
- **Full Quran corpus** — all 114 surahs, 6,236 ayahs loaded locally (1.7 MB JSON, no cloud dependency for text)
- **IDF-weighted scoring** — common words (الله, من, في) are down-weighted; rare/distinctive words drive matching
- **Multiset intersection** — prevents inflated scores from repeated common words in Whisper output
- **Refrain detection** — handles repeated verses (e.g., Ar-Rahman's 31 identical refrains) with sequential position tracking
- **Dagger alef normalization** — bridges Uthmani script (ٰ) and Whisper's standard Arabic output

### Adaptive Pacing
- **Dynamic timer floors** — ayah display duration scales with transliteration character count, not a fixed timer
- **Elongation bonus** — stretched syllables (madd) and nasalized endings (noon sakinah) add recitation time
- **Drift multiplier** — gradually slows display when Whisper reports the reciter is behind, preventing jarring snap-backs
- **Smooth catch-up** — when the reciter jumps ahead (up to 6 ayahs), the display steps forward one ayah at a time

### Locking & State Management
- **Three-state anchor** — `SEARCHING` → `LOCKED` → `RESUMING` with configurable thresholds
- **Sequential win carry** — win counts persist when the reciter advances between Whisper windows
- **Cross-surah guards** — requires 3+ unique matched words and elevated thresholds to break an established lock
- **Anchor clamping** — prevents stale Whisper audio from back-correcting the anchor too far behind the display

### Taraweeh Mode
- **Takbeer detection** — recognizes "Allahu Akbar" to transition between Qiyam and Ruku
- **Rakat counting** — tracks prayer units automatically
- **Fatiha → resume** — after Fatiha completes, restores the pre-ruku surah position for seamless continuation
- **Ameen display** — flashes an overlay when Ameen is detected after Fatiha

### Display
- **Three-line verse card** — Arabic (Amiri font), transliteration, and English translation
- **G2 glasses rendering** — formatted text pushed to the 576×288 micro-LED display via Even Hub SDK
- **Dark mode** — full dark theme with smooth transitions
- **Whisper Live panel** — real-time scrolling view of what Whisper is hearing
- **Confidence meter** — visual indicator of match quality
- **Surah selector** — dropdown to hint the preferred surah for faster initial lock

### Modes
- **Fast Mode** — wider scan windows and faster timers for quick reciters
- **Taraweeh Mode** — prayer-aware state machine with ruku/qiyam tracking
- **Surah preference** — optional hint to prioritize a specific surah during search

---

## Project Structure

```
taraweeh-companion-g2/
├── app/
│   └── index.html              ← Single-file frontend (HTML + CSS + JS, 83 KB)
├── backend/
│   ├── server.js               ← Express + WebSocket server (HTTP & HTTPS)
│   ├── audioPipelineV2.js      ← Core pipeline: audio → Whisper → display timing
│   ├── anchorStateMachine.js   ← SEARCHING/LOCKED/RESUMING state machine
│   ├── keywordMatcher.js       ← IDF-weighted Quran text matcher
│   ├── verseData.js            ← Verse lookup (Arabic, transliteration, translation)
│   ├── whisperProvider.js      ← Legacy HF/local Whisper (optional)
│   ├── groqProvider.js         ← Groq whisper-large-v3-turbo
│   ├── openaiProvider.js       ← OpenAI whisper-1
│   ├── transcriptionRouter.js  ← Provider routing (Groq / OpenAI / Gemini)
│   ├── data/
│   │   ├── quran-full.json     ← Full Quran text (1.7 MB, local)
│   │   └── verses-display.json ← Transliterations + translations (1.7 MB, local)
│   └── certs/                  ← Self-signed HTTPS certs (auto-generated)
├── scripts/
│   └── qr-web-url.js          ← QR code generator for Even Hub scanning
├── G2.md                       ← Even Realities G2 SDK reference
└── package.json
```

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- **Groq and/or OpenAI API key** — for Whisper transcription ([Groq](https://console.groq.com/keys), [OpenAI](https://platform.openai.com/api-keys))

### Installation

```bash
git clone https://github.com/wasimlhr/taraweeh-companion-g2.git
cd taraweeh-companion-g2
npm install
cd backend && npm install && cd ..
```

### Configuration

Create a `.env` file in `backend/`:

```env
SHARED_GROQ_KEY=gsk_your_groq_key_here
SHARED_OPENAI_KEY=sk_your_openai_key_here

# Optional: Gemini for non-Quran detection
# GEMINI_API_KEY=your_gemini_key
```

Users can also bring their own Groq or OpenAI key in **Settings → Use my own key**.

### Run

```bash
npm run backend:dev
```

The server starts on:
- `http://localhost:3001` (HTTP)
- `https://localhost:3443` (HTTPS — needed for mic access on LAN)

### Connect G2 Glasses

1. Run `npm run qr` to generate a QR code
2. Open the Even Hub app on your iPhone
3. Scan the QR code — the app loads on your glasses
4. Tap the record button and start reciting

**G2 mic when hosted online:** The Even Hub app may not stream G2 microphone audio when the app is loaded from a remote URL (e.g. Railway). This can be due to WebView or bridge restrictions for external origins. **Workaround:** Enable **Phone mic** (main screen or Settings) to use the phone's microphone instead.

### Phone-Only Mode

Open `https://<your-lan-ip>:3443` in your phone browser (accept the self-signed cert warning). The full UI works without glasses connected.

---

## Deployment

Users need to **host the app** (backend + frontend). Transcription runs via **Groq** and **OpenAI** Whisper APIs — no GPU hosting required.

### 1. Host the app

Deploy the Node.js backend to Railway, Render, Fly.io, or your own VPS. The backend serves the app at `/` and the WebSocket at `/ws`.

| Platform | Notes |
|----------|-------|
| **Railway** | One-click from GitHub. Add `SHARED_GROQ_KEY` and/or `SHARED_OPENAI_KEY` in Variables. |
| **Render** | Web Service, set env vars in dashboard |
| **Fly.io** | `fly launch` then `fly secrets set SHARED_GROQ_KEY=... SHARED_OPENAI_KEY=...` |

**Same-origin:** When the app is served by the backend, it connects automatically. No extra config.

**Custom backend URL:** If users connect to a different backend, they enter the WebSocket URL in **Settings → Backend URL** (e.g. `wss://your-app.railway.app/ws`).

### 2. Transcription providers

| Provider | Model | Notes |
|----------|-------|-------|
| **Groq** (primary) | `whisper-large-v3-turbo` | Fast; shared key tried first |
| **OpenAI** (failover) | `whisper-1` | Automatic failover when Groq rate-limits |
| **BYOK** | Either | User key in app settings — uncapped |

Set `SHARED_GROQ_KEY` and `SHARED_OPENAI_KEY` for free/shared mode (`MAX_MIN_PER_SESSION` caps sessions, default 90 min).

### 3. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHARED_GROQ_KEY` | For shared mode | [Groq API key](https://console.groq.com/keys) |
| `SHARED_OPENAI_KEY` | Recommended | [OpenAI API key](https://platform.openai.com/api-keys) — failover on Groq 429 |
| `MAX_MIN_PER_SESSION` | No | Shared-mode session cap in minutes (default `90`) |
| `G2_SPLASH_IMAGE_DATA_URL` | No | Optional base64 image (`data:image/jpeg;base64,...`) for glasses startup splash; ignored unless `G2_STARTUP_SPLASH_ENABLED=true` |
| `G2_STARTUP_SPLASH_ENABLED` | `false` | Enables image-container startup splash path on glasses; keep `false` for text-only startup stability |
| `PORT` | No | Default 3001 |

---

## Architecture Deep Dive

### Audio Pipeline

The pipeline processes overlapping audio chunks to maintain continuous recognition:

```
Mic Audio → PCM Buffer → Overlapping Windows → Whisper API → Keyword Matcher
                                                                    │
                                                              Anchor State Machine
                                                                    │
                                                         ┌──────────┴──────────┐
                                                         │                     │
                                                    SEARCHING              LOCKED
                                                    (global scan)     (spot-check mode)
                                                         │                     │
                                                         └──────────┬──────────┘
                                                                    │
                                                              Display Timer
                                                         (character-based pacing)
                                                                    │
                                                              WebSocket Push
                                                         (verse data → frontend)
```

### Scoring Algorithm

Each Whisper transcription is scored against every ayah using:

```
score = 0.6 × tokenF1 + 0.4 × idfWeightedRecall
```

- **tokenF1** — standard F1 on normalized Arabic word overlap (multiset intersection prevents duplicate inflation)
- **idfWeightedRecall** — matched word IDF sum / total input word IDF sum (down-weights ultra-common words)
- **Normalization** — strips diacritics, normalizes alef variants and hamza, handles dagger alef for Uthmani script compatibility

### State Machine

```
SEARCHING ──(score ≥ threshold, wins ≥ N)──► LOCKED
    ▲                                           │
    │                                           │
    └──(consecutive misses)──── RESUMING ◄──────┘
```

Lock conditions include fast-lock (high score), sequential carry (advancing candidates), high-margin single win, and same-surah consistency checks.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HUGGINGFACE_TOKEN` | — | Legacy HF Whisper only (`TRANSCRIPTION_PROVIDER=whisper`) |
| `WHISPER_ENDPOINT_URL` | — | Legacy dedicated Whisper endpoint |
| `MODAL_KEY` / `MODAL_SECRET` | — | Legacy Modal proxy auth |
| `SHARED_GROQ_KEY` | — | Server-held Groq key for free/shared mode |
| `SHARED_OPENAI_KEY` | — | Server-held OpenAI key; failover when Groq 429s |
| `MAX_MIN_PER_SESSION` | `90` | Shared-mode session cap (minutes) |
| `GEMINI_API_KEY` | — | Google Gemini API key (optional non-Quran detection) |
| `TRANSCRIPTION_PROVIDER` | `groq` | `groq`, `openai`, `gemini`, or legacy `whisper` |
| `PORT` | `3001` | HTTP server port |
| `HTTPS_PORT` | `3443` | HTTPS server port |
| `READ_ADVANCE_CONFIDENCE` | `40` | Minimum confidence (%) for timer-based advance |
| `READ_WORDS_PER_SEC` | `1.5` | Base recitation speed estimate |
| `READ_ADVANCE_MIN_MS` | `4000` | Minimum ayah display duration (ms) |
| `READ_ADVANCE_MAX_MS` | `15000` | Maximum ayah display duration (ms) |
| `LOCKED_SEND_MS` | `6000` | Latest tail window (ms) sent per locked-mode Whisper request; smaller values reduce stale buffering on queued endpoints |
| `LOCKED_MAX_INFLIGHT` | `2` | Max concurrent locked-mode Whisper requests per client; allows overlap while preserving sequence guard |
| `LOCKED_RESULT_STALE_MS` | `3000` | Drop locked-mode Whisper results older than this (ms) when they are behind/current verse to prevent snap-back from queued responses |
| `ENDPOINT_ON_DEMAND_ENABLED` | `false` | Enables Settings "Wake endpoint" control (`/api/endpoint/warmup`) for on-demand endpoint spin-up |
| `MOBILE_ONLY_MODE` | `false` | Forces phone mic mode in Settings and labels deployment as mobile-only |
| `WHISPER_PROBE_ON_INIT` | `true` | If `false`, skips automatic endpoint probe on init (manual warmup can still probe) |
| `SILENCE_THRESHOLD` | `0.005` | RMS threshold for silence detection |

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML/CSS/JS (single file), Amiri Arabic font, Even Hub SDK |
| **Backend** | Node.js, Express, WebSocket (`ws`), ES Modules |
| **ASR** | OpenAI Whisper via Groq (`whisper-large-v3-turbo`) and OpenAI (`whisper-1`) |
| **Quran Data** | Local JSON (quran-json format), 6,236 ayahs with Arabic text |
| **Display Data** | Local JSON with transliterations (Sahih International) and translations |
| **Glasses** | Even Realities G2 via `@evenrealities/even_hub_sdk` |
| **Dev Tools** | `@evenrealities/evenhub-cli` (QR codes), `evenhub-simulator` |

---

## Transcription

The app uses standard **OpenAI Whisper** via **Groq** (`whisper-large-v3-turbo`) and **OpenAI** (`whisper-1`). No HuggingFace token is required.

---

## License

This project is for personal and educational use. The Quran text data is in the public domain. The Even Realities SDK is subject to its own license terms.

---

## Acknowledgments

- **Even Realities** — G2 smart glasses and SDK
- **OpenAI** — Whisper speech recognition model
- **Buraaq** — Quran recitation training data
- **quran-json** — Structured Quran text corpus
- **Sahih International** — English translation
