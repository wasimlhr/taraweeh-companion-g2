# Shelley Context — Taraweeh Companion

## Current State (v2.8.4)
Backend running as systemd service `taraweeh` on port 3001.
Logs tailing in tmux session `taraweeh-log` → `logs/` directory.

## Changes Made This Session (v2.8.4)

### audioPipelineV3.js
- Chunk size: 3s → 2s (LOCKED_MIN_MS=2000, LOCKED_MAX_MS=4000)
- Missed threshold: 12 → 16 (compensates for smaller chunks)
- Back-correction cooldown: 5s post-correction (BACK_CORRECT_COOLDOWN_MS=5000)
- Back-correction min confidence: 55% → 65%
- Back-correction wins required: lag=1 always needs 2 consecutive reports
- Manual cooldown: 30s → 10s (MANUAL_ADJUST_COOLDOWN_MS=10000)
- Display lag: 1800ms → 1200ms base
- Padding: 1.08× → 1.03×
- Max timer: 90s → 30s (READ_ADVANCE_MAX_MS=30000)
- Bump cap: 2 → 1 per ayah, threshold 12s → 15s
- Fast mode: 1.35× speed, 500ms/word floor, 11 cps, 0.6× lag
- Slow mode: 0.72× speed, 850ms/word floor, 6 cps, 1.4× lag
- Added per-chunk latency logging

### anchorStateMachine.js
- Back-correction threshold: 0.35 → 0.55
- Consistent lock: with 2+ wins AND coverage ≥ 40%, score threshold drops to 0.40 (was always 0.55)

### Frontend (app/index.html)
- Version bumped to v2.8.4

## Known Issues Still Open
1. **Long ayahs linger too long** — 2:196 (61 words) got 39s timer, even with 30s cap still slow
2. **Reciter mid-ayah repeats** — When imam repeats from middle of ayah, display races ahead during cooldown
3. **Client reconnect wipes state** — init/start resets pipeline to SEARCHING
4. **Search lock too strict** — 2:193 scenario where 2 wins + 63% coverage didn't lock (fixed with consistent lock score threshold)
5. **Whisper hallucinations** — "شكرا" appears frequently on quiet/low audio

## Backups
- audioPipelineV3.js.bak (original)
- anchorStateMachine.js.bak (original)

## Environment
- .env in backend/ with HF token + dedicated Whisper endpoint
- Whisper API avg latency: ~1.3s
- Chunk cycle: ~2s accumulate + ~1.3s Whisper = ~3.3s per decision

## Future Ideas
- Word-level highlighting (progressive reveal synced to timer)
- Whisper word timestamps (endpoint doesn't support yet)
- Server-side session persistence across reconnects
