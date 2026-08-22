# Changelog

## 2.6.12 - 2026-08-22

- Practice uses the same first-lock as Taraweeh (instant Fatiha 1:2). The separate weaker Practice matcher is gone.
- Practice still has no auto-advance timer. Search/STT runs only while a verse is being recited — silence does not search.
- Reciting a different ayah still snaps the display; empty transcripts stay locked.

## 2.6.11 - 2026-08-22

- Practice stays on the matched verse. A 2.5s quiet gap (typical on the simulator) no longer drops back to Searching.
- Stop quoting Fatiha / "تلاوة" in the Whisper prompt — Groq was echoing that as the transcript and false-locking 1:1.

## 2.6.10 - 2026-08-22

- Clarified the two recitation modes: **Taraweeh** locks then auto-advances with the prayer; **Practice** only matches the verse you recite and stays there (no auto-forward).
- Practice no longer mixes the previous ayah's audio/transcript into the next match after a pause.

## 2.6.9 - 2026-08-20

- Groq and OpenAI each recognize recitation independently. Nothing is a backup; Auto failover is gone.
- Faster first lock: search starts at 2s (was 3s), Groq search gap 2.5s (was 4s), locked Groq checks every ~3.5s (was 6s). The 6s starve is what made matching fail and then hit rate limits.
- Quranic Whisper `prompt` plus last-transcript continuation on Groq and OpenAI so Arabic tokens land in the matcher sooner.
- First distinctive hit can lock (single-win 0.42 / margin 8) instead of waiting for a second 4–6s window.
- Rate-limit pauses cap at 12s. 429s are a byproduct of failed lock, not the product bug.

## 2.6.8 - 2026-08-20

- Download Even Realities EvenHub simulator + CLI with `npm run evenhub:download` / `npm run sim` (simulator 0.9.0, CLI 0.1.14).
- Optional Deepgram / ElevenLabs engines remain selectable independently (not used as failover).

## 2.6.7 - 2026-07-21

- Restored fast initial verse matching and visible search candidates.
- Added separate browser, simulator, and G2 microphone profiles.
- Fixed Taraweeh timer freezes with visible, bounded recitation resync.
- Reduced unnecessary transcription calls and Groq rate-limit pressure.
