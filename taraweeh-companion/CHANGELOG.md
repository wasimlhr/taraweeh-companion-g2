# Changelog

## 2.6.11 - 2026-08-22

- Choose your transcription provider and model in Settings.
- Added Deepgram alongside Groq and OpenAI.
- OpenAI now defaults to a model that is faster and half the price.

## 2.6.10 - 2026-08-22

- Display now keeps within one ayah of the reciter on real recitations.
- Verified against real audio from four reciters instead of synthetic tones.
- Rate-limit backoff confirmed: pauses and resumes on its own, no restart needed.

## 2.6.9 - 2026-08-22

- Display now tracks the reciter far more closely instead of trailing a verse behind.
- Reading pace is measured from the reciter's actual speech instead of a fixed guess.
- The end-of-ayah breath is learned, so slow recitation no longer runs ahead.
- Follows the reciter when they skip forward or start a different surah.
- Recovers within seconds after takbeer instead of showing the wrong surah.

## 2.6.8 - 2026-08-22

- Fixed recitation never being detected on quieter phone and G2 microphones.
- Restored the ~3.5s first lock, including the instant lock on Fatiha in Taraweeh.
- Restored Practice mode's immediate snap to the next verse after a pause.
- Position tracking checks the reciter every 5s again instead of every 6s.

## 2.6.7 - 2026-07-21

- Restored fast initial verse matching and visible search candidates.
- Added separate browser, simulator, and G2 microphone profiles.
- Fixed Taraweeh timer freezes with visible, bounded recitation resync.
- Reduced unnecessary transcription calls and Groq rate-limit pressure.
