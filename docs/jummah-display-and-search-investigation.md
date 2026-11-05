# Jummah display and recognition investigation — 2026-10-23

The physical-device report concerns v3.4.37. The changes below are local source changes and are not included in the existing v3.4.37 upload artifact or deployed backend.

## Display findings and changes

- The launcher and reader picker used four image transfers. They now use one native text container. Selection changes use `textContainerUpgrade`, with a rebuild only when the container is missing/rejected.
- A reader fallback still painted translation paragraphs onto the canvas when the glasses translation preference was disabled. Every generated translation page now uses native text, including this fallback.
- Translation content was part of the reader layout cache key. A new translation could rebuild the layout and retransmit all four Arabic tiles. Content now updates the native container; unchanged image tiles are retained.
- Startup built a generic page before the launcher, while older queued live updates could write over it. Startup now creates the native launcher directly. Menu entry invalidates old frame sessions, and live writes are suppressed while the launcher owns the display.
- Read Quran and Listen Quran explicitly handled double-tap as leaving the mode. Read Quran now advances the page; Listen Quran toggles playback. Live recognition double-tap advances a continuation or holds/resumes the verse. Exit confirmation is available only from the actual launcher. Picker/settings back actions remain local navigation.

Arabic Quran typography, the ornamental frame and the audio footer still use image containers. Native English and text menus eliminate those image transfers for their content; this is not an atomic-image-transfer fix for Arabic. A fast simulator rendering four tiles does not establish physical BLE performance.

### Live Translate Arabic flicker follow-up

The live recognition renderer rebuilt its Arabic image layout on every candidate repaint. The candidate animation runs every 400 ms. If another update arrived after the rebuild but during image transfer, the renderer abandoned the remaining tiles. The next repaint cleared the page again, allowing a slow connection to remain in a cycle of blank/partial Arabic.

The live renderer now reuses the installed layout and compares tile bytes before sending them. An active frame completes its tiles before the queue processes the latest pending frame; stopping or switching the capture session still cancels stale work. Native text changes use upgrades, with a complete rebuild/transfer recovery when the text container is rejected. Contextual menu changes invalidate the reused layout. A late failure from a stopped session cannot disable the Arabic preference or overwrite the launcher.

`scripts/verify-live-arabic-stability.mjs` runs the actual simulator renderer and candidate timer with a deliberate 650 ms delay before each image transfer. It verified one initial build, two initial Arabic tiles, identical framebuffer captures over subsequent candidate ticks, no extra image transfer when the candidate locks, and reuse of the same layout for the next verse. This models update timing; it does not certify physical BLE behavior.

## Live search evidence

Authenticated analytics and runtime logs were read from the main Railway backend. In the 20:40–21:00 UTC window (13:40–14:00 PDT), the retained session history contains 9 G2 sessions, 57 transcription responses, 2 verse matches and 0 provider errors. These sessions used `whisper-large-v3-turbo`.

The audio gate reported voice and nonzero input levels. Requests returned promptly, but transcripts repeatedly contained generic noise hallucinations such as “music” and “subscribe to the channel”, or garbled Arabic. One Al-Fatihah search locked at 1:2 after 20.1 seconds. The evidence points to transcription quality as a major search bottleneck; it does not prove whether microphone pickup, room acoustics or model choice caused it. Original audio is not retained, so the mosque recording cannot be replayed.

After both short G2/Groq search windows fail, the next scheduled search request now uses `whisper-large-v3`. This adds no request and preserves the selected provider, key and model for locked tracking. Match thresholds remain unchanged. Search traces now record the actual requested model and available provider confidence metrics. This retry is covered by mocked provider tests, but improved mosque recognition is not yet physically verified.

### Provider selection follow-up

Settings → Live recitation now starts with an expanded Speech recognition section containing separate Provider (Groq/OpenAI) and Model selectors. The provider status button opens this section directly, and its accessible label includes the selected provider/model. Connection status names the provider while initialization is pending rather than briefly showing an unnamed Ready state or an OpenAI cold-start warning. Model choices are remembered separately for each provider, and opening settings preserves an existing model even when older settings lack the per-provider model map.

The local simulator check `scripts/verify-provider-settings.mjs` verified the shortcut, outgoing provider/model pair, persistence after reload, provider-specific credentials/model controls, and layouts at 390 and 590 pixels. It records no audio and writes no keys into its evidence. Targeted UI, provider routing and network tests passed (110 tests).

## Validation

- Full automated suite after the live Arabic flicker fix: 307 passed, 0 failed.
- Even Hub distribution build and client network audit passed.
- Actual Even simulator SDK calls and framebuffer captures: native launcher/picker; zero menu image transfers; zero English paragraph canvas draws; English continuation with zero image transfers or layout rebuilds; no intermediate generic startup frame; Read Quran and Listen Quran double-tap remain in their modes.
- Actual media playback: Ar-Rahman ayahs 2–5 share a page and advance between recordings without a page rebuild or Arabic image transfer. Group boundary, backwards navigation and translation-only grouping passed.

Reproduce the simulator checks with `scripts/verify-native-glasses-menus.mjs` and `scripts/verify-listen-grouped-pages.mjs` against the owned simulator and local backend on port 3012. Screenshots and private log extracts are local evidence under `language-evidence/`; they are not release artifacts. Physical glasses performance, the accuracy retry in a mosque and a new packaged build remain separate verification steps.

## Local v3.4.38 upload package

Built `taraweeh-companion/taraweeh-companion-v3.4.38.ehpk` (664,332 bytes). SHA-256: `a1a79cd5639bfe5a85386912137f54b5f1921b81643f37f471cc06229a945fe2`.

Read Quran now exposes Single verse / Fit multiple verses beside Go to ayah and as explicit glasses menu actions. Aa includes a separate Show translation on glasses checkbox. Translation no longer overrides the selected layout. Multiple mode fits up to four complete short ayahs with numbered native translations; long ayahs retain complete Arabic/translation continuation pages. Bookmarks record the translation preference and older pagination bookmarks resume by ayah.

All 312 automated tests, version alignment, the package network audit and simulator checks passed. The simulator displayed Ar-Rahman ayahs 2–5 together with native translation, then switched to a single ayah through the glasses menu. Packaged frontend modules match the source files. Audio gain is unchanged.

This is a local upload artifact, not a published backend release. Both configured public backends were checked and still report v3.4.37 with the original three reciters. The Groq search quality retry and Saad/Noreen backend additions remain local until backend publication. The package contains the app-side menu, reader, provider-settings, playback and display fixes.

## Noreen automatic following and local v3.4.39

The v3.4.38 Noreen path was audio-only. The user explicitly requires automatic following; manual paging is not the solution.

Located published word timestamps in `zaibihassan/Quranic-Recitation-Data`, pinned revision `aa18b96aa182816377bc8dbf3769ce0b8ded799a`. The actual recording was compared against the original MP3Quran MP3 at three points in every chapter: all 114 chapters / 342 comparisons passed, minimum correlation 0.85732 and maximum measured offset 6.25 ms. Timings are bound to the exact source MP3 SHA-256 and duration. Cue boundaries use the published aligned word times and preserve inter-verse pauses; no duration scaling or evenly spaced verse estimates are used. This validates recording identity and cue structure, not a human audit of every ASR word timestamp.

Imported the primary Quranpedia Al-Duri mushaf 6 dump, version 2026-10-23: 6,218 source verses with explicit mappings to all 6,236 translation/timing references. Connected split and merged verses share one reading unit and include each translation once. Al-Fatihah's Bismillah remains unnumbered, while its final source verses 6–7 share the corresponding translation. The original source Arabic, numbered rosette glyphs and matching KFGQPC Douri font are preserved. All source and font licenses accompany the imported files. Translation remains native glasses text.

Noreen now uses timed ayah playback with automatic Arabic and translation following, grouped reading screens, relative seeking, play/pause, ayah navigation and offline audio. Old audio-only server manifests are rebuilt; the app rejects stale audio-only manifests rather than displaying them as synchronized. Changing reciters invalidates the reading identity and Arabic cache so the same numeric reference cannot retain the wrong reading. No new client network origin was introduced.

Validation: the complete suite passed 314 tests; all 25 affected data/import/reader tests passed again after the final source-glyph correction. Actual Even simulator playback crossed Noreen's first verse boundary without reloading or pausing the MP3, displayed the mapped final Al-Fatihah verses, showed Al-Ikhlas, switched to Dutch translation-only output, restored Saad's Arabic, and played both reciters offline. The grouped-listening regression still advances ayahs 2–5 without a page rebuild or Arabic tile transfer. Screenshots and receipts are under `language-evidence/new-reciters/` and `language-evidence/noreen/`.

Built `taraweeh-companion/taraweeh-companion-v3.4.39.ehpk` (797,657 bytes), SHA-256 `e3fba9bf5093e7c95c461ccb47e1a0d08dba7a903e99e2554ac061137dda7fb8`. Version alignment and the strict package network audit pass; packaged frontend/font bytes match source. Backend 3.4.39 is running locally on port 3012. No backend deployment, Git push, Even Hub publication or physical-glasses certification was performed. The EHPK contains the client; production automatic following also requires publishing the accompanying backend and its timing/Arabic data.

## Preserve position when changing reciter — v3.4.40

Reciter and surah changes shared a loader that always selected verse 1. The reciter handler now captures the current surah, translation/timing reference and playback intent before clearing the picker or pausing. It loads the new recording at the beginning of that same verse, resumes if already playing, and keeps paused audio paused. A different reciter has a different pace, so elapsed seconds are not copied between recordings.

Rapid reciter changes retain one pending position target and cancel obsolete media lookups. A reference inside a merged Al-Duri unit selects that containing unit; switching back to a Hafs recording retains the original reference rather than the group's first verse. Choosing another surah still starts at its beginning.

The actual simulator verified Ali Imran 3:13 across Husary/Saad switches while paused and playing, delayed rapid switches, the Hafs 3:49 → merged Al-Duri 3:48–49 → Hafs 3:49 round trip, and intentional surah changes. Phone and glasses screenshots are in `language-evidence/reciter-position/`. The simulator is left paused on Husary, Ali Imran 3:13, with normal audio restored. All 316 automated tests passed.

Built `taraweeh-companion/taraweeh-companion-v3.4.40.ehpk` (798,086 bytes), SHA-256 `1035a0c2e4b1e7f58955348b46f9eb796054a3cd96bec66ca9d8bd5210a3417e`. Version alignment and the package network audit passed; packaged frontend modules match source. The local backend on port 3012 reports 3.4.40. No remote deployment or publication was performed.

## Version pinned to 3.4.39; Listen Quran display and speed options

The user's latest instruction pins the app to **3.4.39**. All shipped version labels, Android versionCode and backend labels were restored to that version. The unrequested .40 artifact is retained only under local superseded evidence. The current .39 package replaces the earlier .39 package and retains the reciter-position fix.

Settings → Listen Quran now offers Arabic + translation, Arabic only, and Translation only. Arabic-only pages use up to six lines below the opening and preserve complete long-verse continuations, grouped verses, the surrounding border and the transport footer. They clear native translation content rather than leaving the previous language over the Arabic.

Playback speed supports 1× (default), 1.25×, 1.5× and 2× in Settings, beside the seek bar and in a native glasses picker. Speed changes set the real media playbackRate/defaultPlaybackRate with pitch preservation, keep media position and paused/playing state, and persist across verse changes, reciter changes and reloads. Audio-clock-driven verse/page following naturally follows the new rate. Display and speed pickers use native text. Reading-page navigation has a submenu, keeping the main glasses menu within the ten-item SDK limit.

All 318 automated tests passed. The actual simulator verified the default, all controls, actual 2× audio-clock progression, saved speed after reload and reciter changes, Arabic-only clearing/filling, native glasses options, long-verse reading-page navigation, and layouts at 390 and 590 pixels. Evidence is in `language-evidence/listen-options/`. The new .39 package is 799,367 bytes; its hash and simulator receipt are in `language-evidence/listen-options/release-3.4.39.json`. Version alignment, packaged source comparison and the strict network audit pass. The local backend reports .39; no remote deployment or physical-device certification was performed.

## Blank phone after Listen Quran → Back → Read Quran

Reproduced the user's transition in the running simulator: the reader had loaded Al-Imran's 200 verses, but `readerView.hidden` was false while its inline `display` was still `none`; both the main and settings views were also hidden. Listen Quran's follow handler had hidden the shared reader with an inline style, while the Read Quran entry handler restored only the HTML hidden attribute.

Both listening paths now hide the reader through its hidden attribute. Opening Read Quran also removes a stale inline display property so an already affected DOM can recover. The actual simulator passed Settings → Back → Read Quran, repeated Listen → Read transitions, and an explicitly restored legacy inline-hidden state across three cycles. Phone and glasses both visibly show Al-Imran 3:13 again; captures are under `language-evidence/reader-navigation/`. All 70 affected UI/reader tests pass. The package was rebuilt at the user's pinned version **3.4.39**, 799,380 bytes, with a passing network audit and packaged-source comparison. Its current hash is recorded in `language-evidence/reader-navigation/release-3.4.39.json`. No remote deployment was performed.

## Translation remains stuck after changing reciter

The user clarified that the translation stays on older text rather than disappearing. Paused and playing switches retained visible translation in the captured simulator state, but the same-page optimization skipped every native text update when changing reciters without changing the page. A deliberately stale native frame demonstrated the gap: the app expected Ar-Rahman 32–33 while the glasses retained an earlier translation, and changing reciter sent zero text updates.

`followListenAyah` now detects a reciter change, invalidates the native-content cache and refreshes the selected page even when its index is unchanged. Tile-byte caching still avoids sending unchanged Arabic; normal ayah advances within a grouped page retain the previous optimization.

The actual simulator recovered the deliberately stale translation, matched its expected framebuffer, and sent zero unchanged upper Arabic tiles. Nine paused/playing switches across Noreen, Alafasy and Saad retained translation; actual playback then advanced from the 32–33 group to the 34–36 group with new native English. The regression compares rendered translation pixels with an explicit write of the intended text, so merely retaining nonempty cached text is insufficient. Evidence is under `language-evidence/reciter-translation/`. All 81 affected UI, reader and playback tests pass.

Updated the existing **3.4.39** package (799,524 bytes; SHA-256 `77408c31994fe9695d20345a5ece7e54eb7fcef1cad5be8fef7c7005b2b807c6`). Version alignment, packaged-source comparison and the network audit pass. No remote deployment or physical-device certification was performed.
