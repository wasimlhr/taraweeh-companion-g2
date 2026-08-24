# Changelog

## 3.1.1 - 2026-08-24

- **Settings can now pin Practice to one surah.** 3.1.0 added `restrictSurah` to the shared engine but only the MentraOS tile exposed it. Picking a Default Surah now reveals **Only this surah** / **Allow any surah**, defaulting to restricting, because that is what choosing a surah already implies. Taraweeh never sends it and the hint says so — the imam picks the surah there, so pinning would strand the display.
- **Default Surah applies as soon as you pick it.** It was written only when the Settings panel closed, so the new toggle, and the init payload, read a stale value while the panel was open.

## 3.1.0 - 2026-08-23

- **Practice can pin the search to a single surah.** `preferredSurah` was only ever a bias: every search path falls back to a global scan, so while drilling one surah a near-miss could lock onto a similar ayah elsewhere. Selecting a surah reads as "only this surah", so now it can actually mean that. `restrictSurah` removes the fallback — if the recitation is not in that surah, nothing locks.
- Taraweeh is deliberately excluded: the imam chooses the surah, so pinning the search there would strand the display. The bias behaviour `preferredSurah` provides is unchanged, and a test now guards that.

## 3.0.9 - 2026-08-23

- **The saved API key was destroyed on every launch.** Browser localStorage is wiped when the `.ehpk` WebView restarts, so the bridge is the only durable store — but `Storage.attach()` flushed queued writes *before* hydrating from it. Boot calls `saveSettings()` (through `setReciteMode`) before the bridge attaches, and at that point settings are the empty defaults, so the flush wrote a blank key over the good bridge value and hydration then read back what it had just destroyed. The key was gone permanently, not merely for that session, which is why the app asked for it every single time.
- `attach()` now hydrates first, then flushes only keys the bridge did not already hold — genuine first-run migrations — matching the "bridge is the source of truth" rule the code already documented. Verified by replaying the exact cold-start sequence against both versions: before, key `(none)` in memory and on the bridge; after, preserved in both.

## 3.0.8 - 2026-08-23

- **The version banner took over the app's status line.** `setStatus` writes to `#status` — the one element that carries "Listening", the locked verse and every other message — and nothing clears it. `backend_version` arrives on every connect and re-init, so a mismatch re-stamped a red banner there permanently and the app was left with no working status display. It was reported as cosmetic; it was not.
- The notice now goes to the log only, never to the status line. It also no longer fires for the normal case: recognition fixes deploy server-side and reach a packed `.ehpk` without a repack, so a backend running *ahead* of an installed app is expected. Only a backend **older** than the app is worth mentioning, since it may lack an endpoint the app expects.

## 3.0.7 - 2026-08-22

- Accepts base64-encoded PCM over the WebSocket (`{"t":"a","d":"<base64>"}`) alongside the existing binary frames, so MentraOS miniapps can share this backend. Their background layer is a bare JS engine with no `Buffer`, and the native WebSocket bridge is not guaranteed to carry binary. Verified end to end: frames decoded at the expected RMS, reached Whisper, matched.
- `/api/transcription/compare` no longer falls back to the host's `SHARED_*_KEY` when the caller sends none — the route is unauthenticated and publicly reachable, so that let any caller spend the host's quota.

## 3.0.6 - 2026-08-22

**Glasses now keep up with the phone.** Every bridge call is a BLE round-trip and the queue is strictly serial, so one write per state change let the backlog outgrow the drain rate and the display fell steadily further behind.

- The countdown was the main source: it cleared `displayRebuilt` and pushed a full `rebuildPageContainer` — all three containers — every 2 seconds, only to redraw the seconds counter in the header. It is now a header-only `textContainerUpgrade`.
- Glasses writes coalesce. Only the newest frame is worth drawing, so a pending frame is overwritten rather than queued. Measured with a simulated 200ms bridge: 20 rapid frames collapse to 4 writes, the queue stays serial, and the frame drawn last is always the newest.

**Ring tap responds immediately.**

- Starting used to paint the glasses inside the mic-permission promise, so the phone said "Listening" at once while the glasses stayed on "Stopped" until the bridge answered. The glasses are painted on the tap now.
- Stopping closed the WebSocket, so resuming paid for a reconnect and a full pipeline re-init before anything happened. The socket now stays open — `stop` already idles the pipeline server-side — so resume is a single message. Taps also no longer queue behind the display backlog the countdown was generating.

## 3.0.5 - 2026-08-22

- **Bismillah never locks, in any mode.** 3.0.2 fixed the ordinary path but kept an exception for Taraweeh after ruku, where Fatiha genuinely is next. Taraweeh is the default mode and `_expectFatiha` is true from session start, so that exception *was* the live path — and `isTaraweehFatihaLock` never consulted the guard at all, locking 1:1 on a single win the moment the imam said bismillah.
- The exception was wrong on its own terms: knowing Fatiha is next is no reason to lock on the formula, since the reciter is one breath from 1:2, which is real evidence. Bismillah is ambiguous unconditionally now.
- The preamble is shown rather than swallowed — it emits match progress so the panel shows what was heard while the anchor stays in SEARCHING.
- Backend-only: no repack was needed to pick this up.

## 3.0.4 - 2026-08-22

- **"Test key" said network fetch failed on a key that works.** The JSON API sent no CORS headers — only `/mushaf` and `/fonts` did. Packed, the app runs on the Even Hub's origin, so every `/api` call is cross-origin: the browser blocked them while transcription kept working, because WebSockets ignore CORS. That one difference is why the key tested as broken and transcribed fine.
- `/api/*` now sends `Access-Control-Allow-Origin` and answers the `OPTIONS` preflight, which the JSON POSTs need for their `Content-Type` header. This also un-breaks **Compare engines**, the backend status check, and endpoint warmup — all silently failing the same way.
- **Hardening:** `/api/transcription/compare` no longer falls back to the host's `SHARED_*_KEY` when the caller sends no key. The route is unauthenticated and publicly reachable, so that fallback let anyone spend the host's Groq/OpenAI quota. Compare is reached from Settings, where the user has already entered their own key. `/api/transcription/test-key` only ever used the caller's key.

## 3.0.3 - 2026-08-22

- **The packed .ehpk connects again.** 2.6.5 dialled Railway unconditionally. 2.6.22 added a same-origin branch so the local simulator would work — but the Even Hub serves the packed bundle from an `http(s)` origin of its own, so that branch matched there too and the app opened a socket against the Hub host, which has no `/ws`. Fixing the simulator had broken the pack.
- Same-origin is now used only when the serving origin actually answers `/api/status`, probed once at boot. The simulator (loaded from the backend on :3001) still resolves same-origin; a packed build falls through to the hosted backend.
- The hosted default is now `taraweeh-companion-g2-production-150e.up.railway.app`, and both it and the older `taraweeh.up.railway.app` are whitelisted in `app.json` over https and wss. Verified: the packed URL opens a socket and completes the handshake.
- **Backend URL** is now an Advanced setting. Blank means auto; an explicit `http(s)://host` overrides everything, so a wrong guess on real hardware is recoverable without a repack. Settings shows which backend is in use and why.
- Added `scripts/check-stale-backend.js` (from PR #11), which flags a Railway backend too old to report a version.

## 3.0.2 - 2026-08-22

- **Bismillah no longer locks Al-Fatiha.** It opens every surah but At-Tawbah, so hearing it says nothing about which surah is being recited — yet it locked 1:1 on the *second* search window. The guard asked for two consecutive wins, but search windows overlap, so one utterance supplied both; and the main lock path (`isConsistentLock`) never consulted the guard at all.
- The opening a reciter actually uses — isti’adha *then* bismillah in one breath — was not recognised as preamble, because the bismillah pattern is anchored to the start of the chunk. Detection now strips a leading isti’adha first, and tolerates the missing space in `بسمالله` that Whisper often produces.
- The guard is now about vocabulary rather than one ayah number: a Fatiha hit whose matched words come entirely from the bismillah is the opening formula. That also covers 1:3 (`الرحمن الرحيم`), which is wholly contained in it.
- Still locks where bismillah is genuine evidence: Fatiha once the reciter reaches 1:2, An-Naml 27:30 where bismillah is quoted inside the verse, and Taraweeh after ruku where Fatiha is known to be next. Ten regression tests added (47 total).

## 3.0.1 - 2026-08-22

- **Settings redesign.** Six stacked sections became four — Microphone, Transcription engine, Reading, and a collapsed **Advanced**. Model choice, tracking style, engine comparison, service wake and the diagnostic trace moved into Advanced. The G2 gesture documentation left Settings entirely and now has its own screen behind the header `?` button.
- **Bring your own key.** The Free (shared) / My own key toggle is gone; a shared pool would hit rate limits. Pick an engine, paste that engine's key, and a “Get a key” link sits beside the field.
- **Engine and model selection no longer desync.** `setProvider()` persisted settings *before* refreshing the model list, so every switch stored the outgoing engine’s model against the incoming engine (`deepgram` + `gpt-4o-mini-transcribe`). The server discarded the invalid model and silently fell back to a default, so the picker showed one model while another ran. Models are now normalised through a single helper before anything is saved or sent, and the model chosen per engine is restored when you switch back.
- **Switching engines mid-recitation is smooth.** Every engine, model or key edit rebuilt the backend pipeline immediately and dropped the lock, so a burst of changes meant a burst of re-inits. They now coalesce into one.
- **Anti-aliased microphone downsampling.** The 48 kHz → 16 kHz step picked every third sample with no band limiting, folding everything above 8 kHz back into the speech band as noise. The graph now runs at 16 kHz where the browser allows it, and otherwise low-passes (two cascaded Butterworth biquads, ~7.2 kHz) before decimating. Measured: 12 kHz attenuated 24 dB while 440 Hz–3 kHz stays flat.
- **One version everywhere.** UI, root and app `package.json`, lockfiles, `app.json` and the backend package had drifted to four different numbers (4.6.0 / 2.6.27 / 1.0.0, with a `v5.0.2` comment in `server.js`). All now read 3.0.1, and `/api/status` reports `version` so local and Railway deployments can be checked directly.

## 2.6.27 - 2026-08-22

- Groq lock confirmed on live recitation. Pack for EvenHub upload.
- Main-screen provider labels stay on one line. Missing-key / 401 / 403 errors name the engine you picked (Groq, OpenAI, Deepgram, ElevenLabs), not always Groq.
- Ready is only shown when that engine actually has a key. A missing Groq key no longer looks Ready while the panel sits at 0.0s. Tapping Groq again does not tear down a live session.
- App version is 2.6.27 in the UI, both package.json files, app.json, and the backend package. Unknown engines are labeled Engine, not Groq or OpenAI.

## 2.6.26 - 2026-08-22

- Merges the rest of PR #11: pick provider **and** model in Settings. Groq turbo stays the Groq default; OpenAI defaults to `gpt-4o-mini-transcribe` (whisper-1 still selectable for word timings); Deepgram `nova-3` / `whisper-large`. Deepgram is a fast engine (~450ms, timestamps). ElevenLabs stays an independent extra engine — saving Settings no longer rewrites it to Groq.
- Skip-ahead hop, Practice stay-lock, empty Whisper prompt, and independent STT (no failover) are kept.

## 2.6.25 - 2026-08-22

- Merges the rest of PR #11 onto this branch: re-phase the display timer from how many words of the current ayah have been heard, so lag does not carry ayah to ayah. Real-recitation benches, Groq 429 backoff check, and live OpenAI quota/header reporting come with it. Groq and OpenAI stay independent engines.
- Skip-ahead hop from 2.6.24 is kept.

## 2.6.24 - 2026-08-22

- Taraweeh skip-ahead self-heal: if you jump recitation further down the same surah, lock hops to the heard ayah instead of holding the old one while the timer walks. Same-surah distinctive matches (3+ words) hop even when the local ±8 scan would have ignored them. Display snaps on gap 7+ at 35–40%, not 70%.

## 2.6.23 - 2026-08-22

- Practice is not Taraweeh: lock the ayah you recite (including repeats) and stay there. Do not wait for a few ayahs or show "Auto locking" after the verse is on glasses. Pause no longer drops back to searching.

## 2.6.22 - 2026-08-22

- Local EvenHub sim was blank after a hard-reload: `app.json` entrypoint `index.html` 404'd at `/index.html`, and `/app/sdk/even_hub_sdk.js` 404'd so the SDK fell through to CDN (blank WebView). Both paths now serve the app/SDK.

## 2.6.21 - 2026-08-22

- 90% is a lock. Live OpenAI Ya-Sin (`والقرآن الحكيم` + garbled 36:3) sat at Auto locking 1/2 wins with score 0.90 / coverage 100% / 36:2. A 2-word ayah is not asked for a 3rd word, and 80%+ with real coverage locks on the first hit.

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
