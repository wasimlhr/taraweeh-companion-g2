# Quran Verse Translator — standalone phone app (iOS + Android)

A live Quran verse translator: it listens to a recitation through the phone
microphone, finds the verse and shows it with its translation in the chosen
language. Same app and backend as the G2 glasses build, without the glasses.

## Spec

**Goal.** Ship the existing recitation tracker (ASR → Quran matcher → anchor
state machine → translation) as an installable iOS and Android app that works
as a general Quran translator, not only for Taraweeh. The translator core does
not change.

**Modes** (same in both builds; Translate is the default):

| Mode | What it does | Backend flags |
|---|---|---|
| 🌐 Translate | Follows Quran recitation (live, recording, video) verse by verse with auto-advance | `taraweehMode: false`, `practiceMode: false` |
| 📖 Practice | Matches the ayah you recite and stays there; no auto-advance | `practiceMode: true` |
| 🌙 Taraweeh | Listen plus posture tracking and the rak'ah counter | `taraweehMode: true` |

A client that sends neither flag (older glasses builds) still gets its legacy behavior; the standalone app explicitly starts in Translate mode.

**Architecture.** Capacitor 8 wraps the one shared frontend,
`../app/index.html`. Nothing is forked:

| Piece | G2 build (.ehpk) | Standalone app |
|---|---|---|
| Frontend | `app/index.html` | same file, copied into `www/` by `scripts/build-web.js` |
| Mode switch | Even Hub bridge detected | `window.__QURAN_TRANSLATOR_STANDALONE__` (injected; legacy `__TARAWEEH_STANDALONE__` still accepted) or native Capacitor runtime → `<html class="standalone">` |
| Audio in | G2 mic via bridge (phone mic optional) | phone mic via `getUserMedia`, 16 kHz PCM16 over the WebSocket (`audioSource: browser`) |
| Display | glasses HUD + phone | phone only; verse card enlarged |
| Backend | hosted Railway (`/ws`, `/api/*`) | same hosted backend, unchanged |
| STT keys | BYOK in Settings | same |
| Keep screen on | Wake Lock / silent audio | `@capacitor-community/keep-awake` (no silent tone next to the live mic) |
| Back button | — | Android back closes Settings/Help, else backgrounds the app (keeps the rak'ah count) |

**UI changes in standalone mode** (CSS classes `.g2-only` / `.standalone-only`):
glasses-only controls are hidden (G2/phone mic toggle, "second line on
glasses", glasses gestures help, "for Even Realities G2" splash line); the verse
Arabic, transliteration and translation are larger; the bridge probe is skipped
so Start is ready immediately; the translation language picker sits on the
main screen.

**Permissions.** Android: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`.
iOS: `NSMicrophoneUsageDescription`.

**Out of scope for v1.** Background capture with the screen off (keep-awake
holds the screen on instead), on-device ASR, offline mode, store listing assets.

## Build

Node 22+. Android needs JDK 21 and the Android SDK (`ANDROID_HOME`); iOS needs
macOS + Xcode.

    npm install
    npm test                 # www build checks
    npm run sync             # build www/ from ../app/index.html, then cap sync
    npm run android:debug    # → android/app/build/outputs/apk/debug/app-debug.apk
    npm run ios:open         # open in Xcode, pick a team, run on a device

CI: `.github/workflows/mobile.yml` builds the debug APK (uploaded as an
artifact) and an unsigned iOS simulator build on every change to `app/` or
`mobile/`.

Quick browser check of standalone mode without a phone: serve `www/` (or the
backend) and open it with `?standalone=1`.

## Remaining before store release

1. App icon and splash (`npx @capacitor/assets generate` from a 1024×1024 source).
2. Signing: Android upload keystore; Apple Developer team, certificates and
   provisioning profile — add as CI secrets for signed release builds.
3. On-device test on a real iPhone and Android phone during a recitation.
4. Store listings (privacy policy: audio is streamed to the backend and the
   user's STT provider while listening).
