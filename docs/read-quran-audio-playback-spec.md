# Read Quran: recitation playback with synchronized glasses

Status: implementation specification with a diagnostic playback prototype, 22 October 2026. Full Quran recitation playback and synchronization are not yet implemented. No version bump.

## Selected approach

User decision, 22 October 2026: implement direct phone-side playback inside the existing Even Hub package with `HTMLAudioElement`. Use the phone's current media route, including connected Bluetooth headphones. A separate Android helper APK is not part of this approach. Use the player's actual media position to synchronize ayahs and glasses pages; do not feed playback through transcription.

Implementation precedent: [Even Voice AI playback source](https://github.com/MrScautHD/Even-Voice-AI/blob/main/src/tts.ts) creates an HTML audio element for streamed and buffered audio. This establishes a concrete implementation pattern, not proof of uninterrupted Android screen-off playback. Validate that behavior in the packaged beta app before claiming it.

Additional engineering reference: [Matic's Even toolkit and measured findings](https://even.matic.sh/) ([source](https://github.com/maticsh/matic-even)). Its lifecycle notes distinguish overlay events from actual exit, recommend repeat-safe state checkpoints and connection recovery, and explicitly distinguish measured behavior from open background/long-lock questions. Use relevant findings as test inputs; adopting its runtime packages is not required.

## Android feasibility test

The packaged app now includes Settings → Diagnostics → Audio playback test (`app/audio-playback-test.html`). It generates a two-minute WAV test sound locally, or accepts a local recording without uploading it. Start requires an explicit tap; glasses show the audio element's actual elapsed position, with tap pause/resume. Results include play failures, media events, visibility changes and timer gaps, and can be copied or saved. Local and native storage receive bounded checkpoints; a fresh WebView records the previous run's final checkpoint instead of claiming playback continued.

The owned desktop simulator verified WAV decoding, real HTML media advancement, pause, stop, glasses rendering and local result persistence through `scripts/verify-audio-probe.mjs`. Development-PC playback was muted during verification. This is not physical Android/Bluetooth or screen-lock evidence.

Physical acceptance: pair headphones; open the test in the installed beta EHPK; tap Start; verify sound; lock for at least one minute; check that sound and glasses seconds both advance; unlock and inspect/save results. Repeat with another app foregrounded, headset pause/resume, and a local continuous recording. Record the Android and Even app versions. A stopped timer, restarted test page or interruption is a failed gate to investigate, not a successful background result.

## Outcome

In Read Quran, the user presses Play on the phone, hears the selected reciter through the phone's current audio output (including a paired Bluetooth headset), and sees the currently playing ayah on the G2. The default maximum-ayah page remains dense: highlight the playing ayah, retain that page until playback reaches an ayah outside it, then advance exactly once. Single-ayah layout remains available. Audio does not use transcription, the microphone, or the matching algorithms.

## Verified constraints

- The installed `@evenrealities/even_hub_sdk` is 0.0.16, minimum companion app 2.2.10. Its `audioControl` declaration opens/closes the phone or glasses **microphone**; it is not an audio-output method. The inspected bridge declarations expose no media-player or Bluetooth-output selector.
- Even's official SDK reference describes a web application inside the Even companion app's Flutter WebView. Use an HTML audio player in that WebView; do not send playback PCM through the glasses bridge. Bluetooth pairing and the output route belong to the phone OS. A web app cannot promise programmatic headset selection on every host.
- `HTMLMediaElement.setSinkId()` is permission- and browser-dependent. It is optional enhancement only, never a prerequisite. The baseline instructions are “Connect your headphones in your phone's Bluetooth settings.” Do not display an invented Bluetooth-connected status when the host does not expose one.
- User activation may be required for audible playback. The first phone Play handles a rejected `play()` promise and shows a concise retry. A glasses-menu click is not proven to count as browser user activation; after a blocked request ask for one phone Play rather than silently failing.
- Background audio and continuing glasses synchronization are **two different capabilities**. iOS native audio-session/background configuration and Android media-service behavior belong to the Even host, outside this packaged web app. Media Session metadata does not grant background execution. Screen-lock support must be tested on physical iOS and Android hosts before advertised.

Sources checked 22 October 2026:

- [Even official SDK reference](https://github.com/even-realities/everything-evenhub/blob/main/plugins/everything-evenhub/skills/sdk-reference/SKILL.md), corroborated against installed `node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts` (the online reference names an older SDK version).
- [MDN autoplay policy](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [output selection](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId), and [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API).
- [Apple audio session](https://developer.apple.com/documentation/avfaudio/avaudiosession) and [playback category](https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/playback).
- [Android background playback](https://developer.android.com/media/media3/session/background-playback).

## Existing integration points

`taraweeh-companion/app/index.html` owns the current reader, `loadReaderSurah`, `renderReaderPage`, `readerStep`, auto-scroll, bookmarks, reader menu and bridge queue. `app/readerPagination.js` supplies packed windows and single-ayah Arabic/translation pages. `app/readerArtwork.js` renders the existing 576×288 image. Reuse the four 288×144 image tiles and serialized bridge updates; hardware previously rejected more image containers. Preserve the separate basmala line, chapter heading, and Western/Arabic range labels.

The backend already supplies local chapter text at `/api/quran/:surah`. It has no recitation manifest or playback controller. `backend/usageJournal.js` currently models transcription sessions and has a 500-session retention limit; playback must have its own schema rather than pretend to be a transcription session. Reader bookmarks currently save page/layout/script with `pagination:2`; playback position needs separate state.

## Recitation ownership and runtime independence

Do not introduce Quran.com, EveryAyah, or any other public audio site as a runtime dependency. Do not equate freely downloadable recordings with permission to redistribute them. Recording rights and timing-data rights must be documented separately from Quran text rights.

Start with **one verified licensed reciter** covering all 114 surahs / 6,236 numbered ayahs, not a large unverified catalog. A specific recording source is not approved by this research; licensing and redistribution permission remain a concrete ingestion gate. Import from an identified rights holder or a dataset with explicit permissions for recordings, hosting, downloading, and timing redistribution; retain source revision, license text, attribution and checksums. If no suitable rights are available, commission or obtain permission for a recording before enabling public playback. This is a source gate, not a request to change the user's product scope.

Host approved assets under our Railway-controlled storage. Prefer an independently managed object store with our own media domain and backups for scale; a Railway volume is acceptable for a first limited catalog. Never put multi-GB recordings inside EHPK or a Git repository. An audio volume must not replace or obscure `/data/usage`; isolate `/data/audio` and preserve logger history. Provision storage and egress explicitly only when implementing.

The manifest exposes our own paths only. If a dedicated media domain is introduced, add exactly that owned domain to `network.whitelist` and audit the packaged bundle for accidental source URLs. Provenance URLs may be stored server-side, not used as playback fallbacks.

## Asset and API contracts

Prefer full-surah audio with validated ayah boundaries for continuous playback, avoiding audible gaps between thousands of individual files. The ingestion process can also accept per-ayah files as an explicitly gap-tolerant first delivery; do not claim seamless playback for that transport.

Suggested API:

- `GET /api/recitations` — installed reciters, language/name/style, available chapters, license/attribution, manifest version, offline byte totals. Return only installed, validated content.
- `GET /api/recitations/:reciter/:surah` — immutable revision, owned audio path, SHA-256, codec/MIME, byte length, duration, ordered `{ayah,startMs,endMs}` boundaries and optional validated word/segment cues. Include `introBasmala:{startMs,endMs}` separately where present.
- `GET /audio/:revision/:asset` — indexed immutable assets only; support HEAD, byte ranges (206/416), correct Content-Length/MIME, ETag and immutable caching. No arbitrary URL proxy or filesystem path supplied by a client.

Validate boundaries monotonically against the correct chapter counts, track duration and recording convention. Fatiha's numbered 1:1 is not a second intro; surah 9 has no opening basmala. A reciter's spoken intro, silence or isti‘adhah must not be falsely labelled ayah 1. Surah transitions use metadata, not a guessed fixed offset.

## Player model and controls

Extract a small `readerPlayback.js` controller with one long-lived audio element, a pure timeline lookup, and a view adapter. State: `idle`, `loading`, `ready`, `playing`, `buffering`, `paused`, `ended`, `error`. Store reciter, manifest revision, surah, playing ayah, media position, rate and epoch. The media element's actual `currentTime` is authoritative; JavaScript intervals never advance the Quran independently.

The phone has a compact sticky player within Read Quran: Play/Pause, previous/next ayah, progress/seek, reciter picker, and repeat controls in a collapsed sheet. Avoid displacing the main reader. Loading/error status uses the same player space. No new permanent technical status paragraphs. The glasses reader menu places Play/Pause and next/previous ayah near the top while playing, ahead of general mode switching; preserve page controls and bookmark availability. Idle reader page gestures retain their existing meaning.

First playback stops Translate/Practice/Taraweeh microphone capture and any existing listening session through its existing lifecycle, then disables reader timed auto-scroll. Never run two independent page clocks. Leaving Read Quran pauses audio by default. Changing reciter retains the selected ayah and pauses until the new source is ready; it must not reuse old timing offsets. No autoplay on app launch, bookmark restore, reload, or error recovery.

Optional playback rate is separate from Normal/Fast/Slow live-tracking pace; do not reuse those variables. Start at 1×, preserve pitch where supported, and keep rate changes out of the transcription pipeline. Repeat-one, bounded ayah range and repeat-surah are explicit options. At Quran end stop; no surprise wrap to Fatiha.

Seeking and previous/next ayah update audio time and the displayed page atomically under a new playback epoch. During playback, a manual page swipe enters paused browsing (pause first, then show the requested page); Play resumes from the browsed page's first ayah unless the user chooses the saved audio resume action. This avoids audio on one page and the phone/glasses on another. A separate “Follow audio” action returns to the actual playing position if browsing without pausing is added later.

## Synchronization and long ayahs

Use `timeupdate`, `seeking`, `seeked`, `playing`, `waiting`, `pause`, `ended` and a lightweight foreground scheduler to sample media time. Binary-search ayah boundaries. Update the phone active marker immediately; queue glasses output only when the page or highlighted ayah changes, never on every time sample. Coalesce queued updates to the newest playback epoch so slow image transfers cannot show old verses after a seek. Measure transfer completion separately from media position.

Packed layout: retain the current page if it contains the active ayah; move forward to the first following page containing it only at a validated segment transition. Phone and glasses expose the same range. Highlight the active ayah with a restrained outline/brightness change, respecting monochrome G2 and phone dark mode. Rendering must expose word-to-line/ayah geometry instead of trying to replace substrings inside a mixed Arabic line.

**Long ayah limitation:** existing packed/single pagination can split an ayah across several pages. Ayah-only timings cannot truthfully identify the spoken line within it. Do not allocate pages uniformly by word count and call that accurate. Ship automatic continuation only for recordings with verified segment/word cues, mapped by stable Quran word positions to page boundaries. With ayah-only timings show the first part and allow manual continuation while retaining the same active ayah; label that limitation in the feature capability, not a misleading timed animation. Alternatively generate and human-validate segment cues offline before enabling full automatic long-ayah following.

Single layout: short combined Arabic/translation pages remain combined. A separate translation-only page is not a spoken Arabic segment: default playback skips automatic translation-only pages and advances at the next audio ayah; a user can pause to read them. An optional “Pause for translation” setting pauses after the Arabic ayah and shows its translation pages, requiring Resume after the final page. Do not hold continuous recitation behind a visual translation timer by default.

Acceptance target in an active foreground host: phone active-ayah state within 250 ms of the validated cue; G2 visible update target within 1 second subject to measured bridge latency. Report misses and p95 latency; these are targets to measure, not guarantees already established. Bluetooth acoustic latency is outside media `currentTime` and varies by device; offer a bounded display-offset calibration only after measurement, never modify canonical cue files for one headset.

## Interruptions, persistence and offline use

- Buffering freezes progress and verse advancement. Network failure keeps the current page and offers retry; no skipped ayahs. Abort outdated fetches on source changes.
- Headset removal/phone call/audio focus: rely on host pause events where available and do not auto-resume. WebView route-change visibility is not guaranteed; physical testing must establish whether unplugging switches to the speaker. Do not promise automatic headphone-disconnect pause before that test.
- Glasses disconnect: pause by default and retain position. Reconnect restores the current page before an explicit Resume; no accumulated redraw queue.
- Save `readerPlaybackResume` separately from the reading star: reciter/revision/surah/ayah/positionMs/rate. Throttle writes and flush on pause/visibility change. Validate revision and bounds on restore; fall back to ayah start after a manifest change. Do not alter a deliberately saved reader bookmark each second.
- Feature-detect Media Session metadata/action handlers for supported lock-screen/headset transport controls; these are optional. Test a real lock/return cycle. If the host suspends JS, do not claim glasses continued following merely because audio continued.
- First release streams from our backend and prefetches only the next needed asset. Offline is a subsequent explicit download option: per-surah/reciter byte estimate, Wi-Fi preference, cancel/delete, quota handling, version/checksum validation and resumable download. IndexedDB/blob or supported cache storage needs host persistence tests; cache eviction must be recoverable. Never mark a surah offline until every required asset and cue manifest is verified. No full-Quran automatic download.

Capacity example, not a measured catalog: 30 hours of 64-kbit/s audio is roughly 864 MB decimal per reciter; 128-kbit/s is roughly 1.73 GB. Actual durations and file sizes must come from the chosen manifest. At 64-kbit/s an hour is roughly 28.8 MB before protocol overhead; set storage/egress budgets using actual assets and listener concurrency.

## Telemetry and privacy

Add bounded playback summaries to the persistent Railway journal: session mode `reader_playback`, manifest/reciter version, start/end/duration, time actually played, buffering totals, seek/repeat counts, structured error codes and display-sync latency aggregates. Keep provider/microphone fields absent or explicitly not applicable. Counts must not imply successful G2 presentation until bridge acknowledgements exist. Do not log raw audio, headset names, API keys, signed URLs, device identifiers or per-second timeline history. Reuse authenticated owner report access; persist diagnostic reports independently if not already done. Protect reports from public access.

Reading position and religious usage history remain private device state by default. Decide whether detailed ayah history is needed at all; aggregate counters suffice for playback reliability. Respect the existing diagnostics consent and retention behavior. No external analytics service is required.

## Implementation sequence and release gates

1. **Host feasibility spike:** one locally controlled test recording, phone Play, Bluetooth output, bridge display update, pause/seek, lock/unlock, route disconnect on physical G2 with current Even iOS and Android apps. Record foreground/background audio and display results separately. No public playback claim before this evidence.
2. **Licensed ingestion:** approve the recording rights, source provenance and timing rights; import one complete reciter; verify every chapter and basmala convention; independently inspect representative long-ayah cues.
3. **Backend delivery:** manifest validator, owned media routes/range tests, storage/backup setup, network allowlist and bandwidth limits. No arbitrary remote fallback.
4. **Pure playback controller:** injected audio adapter and clock; event/state tests, stale-epoch cancellation, timer exclusion and resume state.
5. **Reader integration:** compact controls, page/active-ayah geometry, native menu actions, translation-page policy, no regressions in manual reader or live modes.
6. **Reliability/telemetry:** interrupted downloads, slow media/bridge, retries, disconnects, private persistent reports; optional offline/Media Session only after capability testing.
7. **Release:** existing full tests, version test and packaging/network audit, actual simulator phone/G2 evidence, then physical Bluetooth matrix. No version bump or EHPK is part of this specification.

Required tests: all 114 chapters' cue/count validation; Fatiha 1:1; no basmala in chapter 9; two reciters with different intro lengths; long 2:255 and 2:282; packed range crossing; exact cue boundary seek; single Arabic/translation pages; seek while bridge busy; repeat/rate changes; pause during buffering; phone incoming call; headset disconnect/reconnect; G2 disconnect; lock 5+ minutes; app return; Bluetooth headset media buttons where supported; source 404/416; denied autoplay; corrupt/evicted offline cache; language/theme change; switch to each other mode; no microphone or ASR charges during playback; no unexpected third-party network request.

Open risks requiring evidence are recording redistribution rights, trustworthy segment timings, Even-host background execution and route-change behavior. They do not block building the controller and foreground UI, but they constrain the claims and capabilities of the first shipped release.
