# Changelog

## 2.6.20 - 2026-08-22

- Merges PR #11 (quiet-mic first lock, display sync, benches, Al-Hashr/translation coverage) onto this branch's matcher, EvenHub sim path, and empty Whisper prompt.
- Quiet-mic first lock: lower VAD floors, adaptive gate from observed audio, search voice-gate bypass at 6s, Groq search gap 2s, hangover 5s, locked Groq checks every 5s.
- Display stays with the reciter: onset-to-onset pace, learned breath, timer cushion 1.2, gap-1 nudge, leading-edge tail rematch. Do not stretch a timer past the ayah.
- Practice: after a shown verse plus pause, next recitation is a fresh global search (surah jumps). First lock still uses the Taraweeh matcher; empty transcripts stay locked.
- Spoken-form matcher from 2.6.18–2.6.19 is kept (stutter collapse, latin `S`, unique 1-letter / ح↔ه / ق↔ك, 4-letter Ya-Sin OOV). `الله` and `يوسف` are not rewritten.
- Benches: `scripts/run-lock-bench.sh`, `scripts/run-sync-bench.sh`. Al-Hashr ayah count and translation coverage checks.

## 2.6.19 - 2026-08-22

- Matcher is more tolerant of weak Groq: collapse stutter (`ياسسين` → `يس`), map latin `S` (`يESSSS` → `يس`), unique 1-letter / ح-ه / ق-ك repairs, and 4-letter Ya-Sin-shaped OOV (`يجيس`). Known Quran words such as `الله` and `يوسف` are not rewritten.

## 2.6.18 - 2026-08-22

- Live Ya-Sin lock: Groq already heard the opening (`يسي`, `ياسين والقرمان الهكيم`, `إن لك للمرسلين`) and the matcher dropped it. Spoken-form aliases, distinctive 1-word muqatta'at openers, and ه/ح + extra-letter repair now lock surah 36. Fatiha lock is not the bar.

## 2.6.17 - 2026-08-22

- Restore 2.6.7 live matching: 3s first search window, 4s Groq search gap, 6s locked checks, no Whisper prompt, no client-side sim gain.
- Backend quiet-boost is back to the 2.6.7 per-source profiles (only when RMS is below that source’s threshold). Loud recitation is not multiplied.

## 2.6.16 - 2026-08-22

- Simulator PC mic no longer applies a flat 8× gain. Quiet frames still boost (cap 8×); loud recitation is sent as-is. Flat 8× was clipping live recitation so Groq emitted `ترجمة نانسي قنقر` / `من` instead of the verse.

## 2.6.15 - 2026-08-22

- Simulator/app boot: `DEFAULT_SETTINGS` was missing its closing brace after `reciteMode` was added, so the page script never ran and EvenHub showed a dead shell.
- Same-origin WebSocket on LAN/Cloud IPs (no silent Railway redirect). Bundled EvenHub SDK served at `/sdk/even_hub_sdk.js`.
- Live pipeline strips leading isti'adha (not mid-verse 16:98) so the opening of a recitation cannot false-lock An-Nahl.
- YouTube replay is live PCM → STT → lock/sync only. Auto-captions are not used.

## 2.6.14 - 2026-08-22

- Removed quiet-boost for every source (G2, simulator, browser). 20× gain was distorting recitation — live Taraweeh logs turned `الحمد لله` into `حال الله` / `موسيقى`.
- G2 PCM is sent as-is. PC mic through the EvenHub simulator gets a limited 8× capture gain (clip, not a 20× boost) so Groq can hear it.
- Browser mic graph is muted so the PC speaker does not echo into STT.
- YouTube recitation replay: `npm run replay:youtube -- <url>` streams 16 kHz PCM through the same V4 pipeline.

## 2.6.13 - 2026-08-22

- Simulator search no longer 20×-boosts quiet noise into Groq. That was producing `موسيقى` / `ترجمة نانسي قنقر` instead of Fatiha.
- STT search waits for real recitation RMS in both modes.
- Practice selection is persisted and is no longer overwritten by Taraweeh status echoes. Init prefers Practice when the client asked for it.

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
