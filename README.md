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

Create a `.env` file in `taraweeh-companion/backend/`:

```env
# Shared keys for free mode (Groq first, OpenAI failover on rate limit)
SHARED_GROQ_KEY=gsk_your_groq_key_here
SHARED_OPENAI_KEY=sk_your_openai_key_here

# Optional: Gemini for non-Quran detection (tasbeeh, takbeer)
# GEMINI_API_KEY=your_gemini_key
```

Users can also bring their own Groq or OpenAI key in **Settings → Use my own key** — no server env vars needed for BYOK.

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

**Manual URL entry (if QR doesn't work):** The Even Hub app lets you enter a URL manually. Use the **full URL including port**:
- `https://<your-pc-ip>:3443` (HTTPS — required for mic on LAN; accept the self-signed cert warning)
- `http://<your-pc-ip>:3001` (HTTP — mic may be blocked on non-localhost)

Replace `<your-pc-ip>` with your computer's LAN IP (e.g. `192.168.1.5`). Phone and PC must be on the same Wi‑Fi. If the page doesn't load, the WebView may be rejecting the self-signed certificate — try scanning the QR code from `npm run qr` instead, which uses the correct URL format.

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

### Rate limits and cost

All figures below are measured against the live APIs, reading each provider's own `x-ratelimit` response headers rather than trusting documentation.

Groq's free tier for `whisper-large-v3-turbo` is **20 requests/min, 2,000 requests/day, 7,200 audio-seconds/hour**. The 10-second minimum applies to **billing**, not to the rate-limit counter: a 6-second window draws exactly 6 audio-seconds from the bucket, and the bucket refills continuously at 2 audio-seconds per wall-clock second.

The pipeline spot-checks roughly every 5 seconds with a 6-second window, so under continuous recitation:

| | measured | cap | usage |
|---|---|---|---|
| requests/min | ~12 | 20 | 60% |
| audio-seconds drawn/sec | 1.18 | 2.00 refill | **59% of sustainable** |
| requests per 90-min session | ~1,080 | 2,000/day | **54%** |

So audio-seconds are **not** the binding limit — the pipeline draws well under the refill rate and never exhausts the bucket. The real constraint is **2,000 requests/day**, which allows about one 90-minute session per day per key. The 20 RPM cap is also easy to trip if anything else shares the key: running a second consumer alongside the pipeline pushed it over and produced 429s, which dropped tracking from 99.2% to 79.6% within one ayah until the backoff settled.

When 429s do occur the pipeline handles them: it honours `Retry-After`, backs off, surfaces the limit, resumes unaided and keeps tracking (verified by `scripts/check-rate-limit-handling.js`). Shared mode also fails over to OpenAI per chunk. Real Taraweeh includes ruku, sujud and pauses where the voice gate suppresses transcription, so actual usage is below these continuous-recitation figures.

Sending longer windows less often was measured and is **not** a good trade — accuracy falls off sharply:

| window / interval | audio-sec/hour | first 429 | within ±1 ayah |
|---|---|---|---|
| 6s / 5s (default) | 7,200 (100%) | ~60 min | **99.8%** |
| 10s / 6s | 6,275 (87%) | ~69 min | 94.7% |
| 10s / 7.5s | 4,968 (69%) | ~87 min | 83.1% |

To buy headroom at a known accuracy cost, raise `GROQ_LOCKED_MIN_INTERVAL_MS`.

### Groq vs OpenAI — measured head to head

Both providers were run on identical real recitations. **Tracking accuracy is a tie**; everything else favours Groq.

| | Groq `whisper-large-v3-turbo` | OpenAI `whisper-1` |
|---|---|---|
| tracking, An-Naba 275s (within ±1 ayah) | **99.2%** | **99.2%** |
| median latency | **343ms** | 1,249ms |
| p95 latency | **1,442ms** | 2,260ms |
| cost, same 275s recitation | **$0.006** | $0.042 |
| cost / 90-min session | **~$0.07** | ~$0.81 |
| cost / 30 nights | **~$2.16** | ~$24.30 |
| rate limit | 20 rpm, 2,000/day (54% per session) | 2,500 rpm (**0.6% used**) |
| word timestamps | yes | yes |

On isolated 6-second windows scored through the app's matcher (`scripts/compare-asr-providers.js`), OpenAI hit slightly more often — 74% vs 67% over 27 windows, a two-window difference that is within noise — but Groq matched with **noticeably higher confidence** when it did hit, median score 0.68 vs 0.49. Confidence matters here because the anchor state machine gates on score thresholds. End to end the two are indistinguishable.

**Use Groq as primary**: same accuracy, 3.6× faster, 7× cheaper, higher match confidence. Its one real constraint is 2,000 requests/day, about one long session per key per day, and the 20 rpm cap which nothing else should share.

**Use OpenAI as failover or primary if Groq access is a problem**: measurably just as accurate for tracking and effectively never rate-limited, at ~10× the cost and ~3× the latency. Its latency still sits inside the pipeline's 3s stale-result threshold — 0 of 69 calls were dropped.

### 2. Transcription providers

| Provider | Model | Notes |
|----------|-------|-------|
| **Groq** (primary) | `whisper-large-v3-turbo` | Fast, generous free tier; shared key tried first |
| **OpenAI** (failover) | `whisper-1` | Used automatically when Groq rate-limits (429) |
| **BYOK** | Either | User supplies their own key in app settings — uncapped |

Set `SHARED_GROQ_KEY` and `SHARED_OPENAI_KEY` on the server for free/shared mode. Sessions are capped at `MAX_MIN_PER_SESSION` minutes (default 90) to protect the budget.

### 3. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHARED_GROQ_KEY` | For shared mode | [Groq API key](https://console.groq.com/keys) |
| `SHARED_OPENAI_KEY` | Recommended | [OpenAI API key](https://platform.openai.com/api-keys) — failover on Groq 429 |
| `MAX_MIN_PER_SESSION` | No | Shared-mode session cap in minutes (default `90`) |
| `GEMINI_API_KEY` | No | Optional non-Quran detection |
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
| `SILENCE_THRESHOLD` | `0.005` | RMS threshold for silence detection |
| `GROQ_SEARCH_MIN_INTERVAL_MS` | `2000` | Minimum gap between search-mode Groq calls. Raising this slows the first lock |
| `GROQ_LOCKED_MIN_INTERVAL_MS` | `5000` | Minimum gap between locked-mode Groq spot checks |
| `SEARCH_VOICE_GATE_BYPASS_MS` | `6000` | Transcribe anyway after this long with buffered audio but no voice detected. Safety valve so a mis-tuned voice gate can never stop recognition |
| `SIGNAL_PRESENT_RMS` | `0.0003` | "Mic is producing something" floor. Below this the search buffer is trimmed to a short pre-roll |
| `VOICE_HANGOVER_MS` | `5000` | Silence after which the search buffer resets. Must exceed a between-ayah breath |
| `VOICE_MIN_ACTIVE_MS` | `500` | Detected speech required before a search call is preferred |
| `BROWSER_VOICE_MIN_ACTIVITY_RMS` | `0.0012` | Phone-mic voice gate floor (per ~85ms chunk) |
| `BROWSER_VOICE_MAX_ACTIVITY_RMS` | `0.0022` | Ceiling on how far room noise may raise the phone-mic gate |
| `G2_VOICE_MIN_ACTIVITY_RMS` | `0.0004` | G2-mic voice gate floor |
| `G2_VOICE_MAX_ACTIVITY_RMS` | `0.0009` | Ceiling on how far room noise may raise the G2-mic gate |
| `GROQ_TIMER_CUSHION` | `1.2` | Padding on every locked-mode display timer. Biased slow on purpose: running ahead shows an ayah the imam has not reached yet. Lower it for tighter tracking on even-paced recitation, raise it if the display overshoots |
| `GAP1_NUDGE_MS` | `500` | When Whisper places the reciter exactly one ayah ahead, compress the remaining timer to this instead of snapping. `0` restores the old ignore-it behaviour |
| `REPHASE_MIN_WORDS` | `2` | Re-phase the display timer once this many words of the current ayah have been heard, so the remaining time is scheduled instead of a whole ayah again. `0` disables |
| `REPHASE_TOLERANCE_MS` | `900` | Only re-phase when the scheduled and remaining times disagree by more than this |
| `FORWARD_JUMP_CONFIRMS` | `2` | Consecutive agreeing reports needed to follow a jump of more than 6 ayahs when confidence alone is too low |
| `DISPLAY_HOLD_SILENCE_MS` | `1200` | Hold the display once the mic has heard nothing for this long |
| `DISPLAY_HOLD_MAX_MS` | `20000` | Upper bound on that hold, so a mis-tuned voice gate cannot freeze the display |
| `PAUSE_EST_START_MS` | `900` | Starting estimate for the reciter's end-of-ayah breath before one is measured |
| `LEADING_EDGE_TAIL_MS` | `2600` | Re-match the newest words of each window to track the leading edge of the recitation. `0` disables |
| `LOCKED_SEND_MS` | `6000` | Locked-mode tail audio sent per Whisper request (ms) to reduce stale queue buildup |
| `LOCKED_MAX_INFLIGHT` | `2` | Max concurrent locked-mode Whisper requests per client (higher can improve responsiveness on async endpoints) |
| `LOCKED_RESULT_STALE_MS` | `3000` | Drop locked-mode confirmations older than this age when they point to the same/older ayah |

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

The app uses standard **OpenAI Whisper** models via hosted APIs:

- **Groq** — `whisper-large-v3-turbo` (primary; low latency, word-level timestamps)
- **OpenAI** — `whisper-1` (failover when Groq rate-limits, or BYOK choice)

Arabic transcription is passed to the local keyword matcher against the full Quran corpus. No HuggingFace token is required.

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
