# Running Taraweeh Companion

**Target:** This app is built to run **inside Even Hub** (Even’s app distributes it), **Android-first**. The standalone build is for development and testing. See **EVEN_HUB_GOAL.md** for product and SDK alignment. To **test on G2 glasses** with the Even developer APK, use the **web** build and open its URL inside the Even app — see **EVEN_TEST.md**.

The project uses **Expo SDK 54** and **React Native 0.81** (upgraded for compatibility).

## Test on PC with Even Hub Simulator

You can test the app on PC without physical glasses using the **Even Hub Simulator**:

1. **Terminal 1** – start the web dev server:
   ```bash
   npm run web
   ```
   Wait until Expo is ready (usually http://localhost:8082).

2. **Terminal 2** – start the simulator:
   ```bash
   npm run simulator
   ```
   Or: `npm run sim`

The simulator opens a window that mimics the G2 glasses display and injects the Even Hub bridge. Your app loads at `http://localhost:8082` and connects to the bridge. You can test verse display, navigation, and glasses UI without hardware.

**Note:** The simulator supports Up, Down, Click, Double Click. Audio events work if you configure an input device (`npx evenhub-simulator --list-audio-input-devices`).

## Quick start

1. **Set environment (PowerShell):**
   ```powershell
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   ```
2. **Start Metro:** `npm start`
3. **Run on Android:** In another terminal (with the same env vars), `npm run android` (emulator or device must be connected).
4. **Run on iOS (Mac only):** `npm run ios`

## Android build: JDK version

The Android build fails with **Unsupported class file major version 69** if you use **JDK 25**. Gradle 8.x expects an older class file version.

**Fix:** Use **JDK 17** or **JDK 21** for the build.

- **Option A:** Set `JAVA_HOME` to a JDK 17 or 21 install before running `npm run android`.
- **Option B:** Use Android Studio’s embedded JDK (usually JDK 17): point `JAVA_HOME` to the JDK inside your Android Studio installation.
- **Option C:** Install JDK 17 (e.g. [Adoptium](https://adoptium.net/)) and set `JAVA_HOME` to that path.

Example (Windows, JDK 17 in `C:\Program Files\Eclipse Adoptium\jdk-17.0.x-hotspot`):

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.13.11-hotspot"
npm run android
```

**On this machine:** Android Studio’s JBR (JDK 21) works. In PowerShell, before `npm run android`:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
```

Then start an **emulator** (Android Studio → Device Manager → start a virtual device) or connect a **physical phone** with USB debugging enabled. After that, run `npm run android` again.

## If you see "Could not move temporary workspace" (Gradle on Windows)

This can be caused by antivirus or another process locking `android\.gradle`. Try:

1. **Build from Android Studio:** Open `QuranLiveMeaning/android` in Android Studio, wait for sync, then **Run** (green triangle) with an emulator or device selected. Metro: run `npm start` in the project root first.
2. **Exclude project from antivirus:** Add `C:\G2_DEV\QuranLiveMeaning` to your antivirus exclusions, then run `npm run android` again.
3. **Gradle version:** The project uses Gradle 8.8 (in `android/gradle/wrapper/gradle-wrapper.properties`) to avoid the React Native plugin "serviceOf" error with Gradle 8.14.

## Native project (android/)

The `android/` folder was generated with:

```bash
npx expo prebuild --platform android
```

If you need to regenerate it (e.g. after adding a native module), run the same command. Do not edit `app.json`/Expo config and then run prebuild again if you have custom native changes; consider using [config plugins](https://docs.expo.dev/guides/config-plugins/) to preserve them.

## Android build (Expo 54 / RN 0.81)

The project was upgraded from RN 0.73 to **RN 0.81** so it matches Expo SDK 54. The Android project uses the standard Expo/RN 0.81 setup: `com.facebook.react.settings` plugin, `autolinkLibrariesWithApp()`, Gradle 8.13.

**Build debug APK (PowerShell):**
```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\android\gradlew.bat -p android assembleDebug
```
The first build can take several minutes (downloads and compiles native code).

## Mic permission

On Android, the app requests **RECORD_AUDIO** when you open the Listening screen. The permission is declared in `android/app/src/main/AndroidManifest.xml`. If the user denies it, the Listening screen shows "Mic permission denied" and you can still use Prev/Next to cycle sample verses.
