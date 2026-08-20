# Changelog

## 2.6.8 - 2026-08-20

- Groq rate-limits no longer freeze the session: Auto mode failsover to Deepgram, ElevenLabs, then OpenAI and sticks with the provider that works.
- Added Deepgram Nova-3 Arabic and ElevenLabs Scribe v2 as selectable STT engines, plus a "Compare providers" mic test.
- Stopped applying Groq's 6s RPM throttle when another engine is available (that throttle is what made matching feel broken).
- Download Even Realities EvenHub simulator + CLI with `npm run evenhub:download` / `npm run sim` (simulator 0.9.0, CLI 0.1.14).

## 2.6.7 - 2026-07-21

- Restored fast initial verse matching and visible search candidates.
- Added separate browser, simulator, and G2 microphone profiles.
- Fixed Taraweeh timer freezes with visible, bounded recitation resync.
- Reduced unnecessary transcription calls and Groq rate-limit pressure.
