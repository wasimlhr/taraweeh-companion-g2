# Even G2 App Development – Comprehensive Reference

Single reference for building Even Hub (G2) apps: ground rules, app structure, even-dev simulator, and links. Use this when starting or aligning new apps.

---

## For app developers (official guidance)

Your app should be a **standalone web app** with its own:

- **`index.html`** – entry point  
- **`package.json`** – dependencies and scripts  
- **`vite.config.ts`** – dev server config  

**No need** to conform to the old AppModule interface or write adapter files. Just a **regular web app** that uses the Even Hub SDK.

### Styling

- **Avoid** Tailwind or other CSS frameworks that need **build plugins** – your app may be served through even-dev’s Vite config, which won’t have those plugins.
- Prefer **inline styles** or **plain CSS**.
- **`@jappyjan/even-realities-ui`** works great for browser settings pages (Even design guidelines).

### Backend

- If your app has a **backend server**, put it in a **`server/`** directory with its **own `package.json`**.
- **even-dev** will auto-start it.

### References

- **G2 development notes** (app structure + even-dev section):  
  [G2.md – Even-dev simulator environment](https://github.com/nickustinov/even-g2-notes/blob/main/G2.md#even-dev-simulator-environment)
- **even-dev** (unified simulator + multi-app env):  
  [Full README – BxNxM/even-dev](https://github.com/BxNxM/even-dev)

---

## even-dev – unified simulator & app environment

**What it is:** Multi-application development environment for building and testing Even G2 apps with the Even Hub Simulator.

- **Repo:** [BxNxM/even-dev](https://github.com/BxNxM/even-dev)
- **G2 notes:** [nickustinov/even-g2-notes – G2.md](https://github.com/nickustinov/even-g2-notes/blob/main/G2.md)

### Requirements

- Node.js, npm, curl
- Even Hub Simulator

### Quick start

```bash
npm install
./start-even.sh
```

Pick an app from the launcher. Or run a specific app:

```bash
APP_NAME=demo ./start-even.sh
# or
./start-even.sh demo
```

### Run a local app by path (no edit to apps.json)

```bash
APP_PATH=../my-app ./start-even.sh
```

Resolves the directory, installs deps if needed, and launches. App name = directory basename.

### How apps are loaded

| Kind | Description |
|------|-------------|
| **Built-in** | Live in `apps/` (demo, clock, timer, quicktest, restapi). Share even-dev’s `index.html` and `src/Main.ts`; export `AppModule` from `apps/<name>/index.ts`. |
| **External** | **Standalone web apps** with their own `index.html`, `package.json`, and `vite.config.ts`. Registered in `apps.json` (Git URL or local path). even-dev serves the app’s `index.html` via Vite. |

**External app registration** (`apps.json`):

```json
{
  "chess": "https://github.com/dmyster145/EvenChess",
  "weather": "https://github.com/nickustinov/weather-even-g2.git",
  "my-local-app": "../my-local-app"
}
```

Values: **Git URLs** (cloned into `.apps-cache/`) or **local paths** (relative to even-dev root). For one-off runs without editing `apps.json`, use `APP_PATH` as above.

### Audio input (e.g. STT apps)

```bash
AUDIO_DEVICE="<exact-device-id>" ./start-even.sh stt
```

List devices:

```bash
npx @evenrealities/evenhub-simulator --list-audio-input-devices
```

Use the full device ID from the left column (not `default`).

---

## Building a G2 app – minimal structure

A G2 app is a **regular web app**: HTML, TypeScript, and the Even Hub SDK. No special framework required.

**Example repos:** [chess](https://github.com/dmyster145/EvenChess), [reddit](https://github.com/fuutott/rdt-even-g2-rddit-client).

### Minimal file layout

```
my-app/
  index.html          # entry point
  package.json        # dependencies and scripts
  vite.config.ts      # dev server config
  src/
    main.ts           # app bootstrap
  app.json            # app metadata (for packaging)
```

### index.html

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>My App</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### package.json (minimal)

```json
{
  "name": "my-even-app",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 5173",
    "build": "vite build"
  },
  "dependencies": {
    "@evenrealities/even_hub_sdk": "^0.0.7"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vite": "^7.3.1"
  }
}
```

### app.json (packaging / evenhub-cli)

```json
{
  "package_id": "com.example.myapp",
  "name": "my-app",
  "version": "0.1.0",
  "description": "What my app does",
  "author": "Your Name",
  "entrypoint": "index.html"
}
```

See [reddit app’s app.json](https://github.com/fuutott/rdt-even-g2-rddit-client) for a full example (e.g. permissions).

### Connecting to the Even bridge

```ts
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

bridge.onEvenHubEvent((event) => {
  // Handle tap, double-tap, swipe, etc.
})

// Send UI to the glasses
bridge.sendStartUpPage(container)
```

### even-dev tips (from README)

- **Use inline styles or plain CSS** – avoid Tailwind etc. that need build plugins; even-dev’s Vite config may not include them.
- **Keep the app standalone** – it should work with just `npm run dev`.
- **Backend:** Put it in **`server/`** with its own **`package.json`**; even-dev auto-starts it (see `vite-plugins/app-server.ts`).
- **Settings UI:** Use **`@jappyjan/even-realities-ui`** for consistent components.
- **Packaging/deploy:** Use **`@evenrealities/evenhub-cli`**; see reddit app for `pack` / `qr` script examples.

---

## even-dev project structure (reference)

```
apps.json           # External app registry (Git URLs or local paths)
start-even.sh       # Launcher: app selection, deps, Vite, simulator
index.html          # Entry for built-in apps
src/Main.ts         # Built-in app loader (AppModule)
apps/               # Built-in apps (demo, clock, timer, quicktest, restapi)
apps/_shared/       # Shared types (AppModule contract)
vite-plugins/       # Custom Vite plugins for external apps
.apps-cache/        # Cloned external repos (gitignored)
vite.config.ts      # Vite config, external app HTML serving
```

### Custom Vite plugins

When serving external apps, even-dev can run app-specific plugins from `vite-plugins/`:

| Plugin | Purpose |
|--------|--------|
| `app-server.ts` | Auto-starts an app’s `server/` process |
| `browser-launcher.ts` | Opens browser when dev server is ready |
| `chess-stockfish.ts` | Serves Stockfish WASM for chess app |
| `reddit-proxy.ts` | Proxies Reddit API (CORS) |
| `restapi-proxy.ts` | Proxies REST API for restapi app |

Plugins receive a `PluginContext` with `externalApps` (app name → resolved path). Return `null` if the plugin doesn’t apply.

---

## Ground rules checklist (for new apps)

Use this when starting or reviewing an Even G2 app:

- [ ] **Standalone web app** – own `index.html`, `package.json`, `vite.config.ts`.
- [ ] **No AppModule / adapter requirement** – plain web app + Even Hub SDK.
- [ ] **Styling** – inline styles or plain CSS; no Tailwind (or other build-plugin frameworks) unless the app is never served via even-dev.
- [ ] **Settings / browser UI** – consider `@jappyjan/even-realities-ui` for consistency.
- [ ] **Backend** – if needed, put in `server/` with its own `package.json` for even-dev auto-start.
- [ ] **Runs on its own** – `npm run dev` works without even-dev.
- [ ] **Packaging** – `app.json` + `@evenrealities/evenhub-cli` for pack/deploy/QR.

---

## G2 development notes (local)

**G2.md** in this folder contains detailed SDK notes: canvas (576×288), container model, text/list/image limits, event quirks, UI patterns from pong/snake/chess, browser UI, even-dev. Use it when improving the glasses display or in-app web GUI.

### Glasses display (Arabic, context, hints)

- **Arabic:** Not supported on G2 yet. The `arabic` field is kept in payloads; future firmware may add support.
- **Context:** Surah name, optional thematic context, and hints are shown. Format: `[Surah Name], Ayah N` + divider + context/hint + translation. ~480 chars fit.

## Developer resources (links)

| Resource | Link |
|----------|------|
| **SDK** | [@evenrealities/even_hub_sdk](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) |
| **CLI** | [@evenrealities/evenhub-cli](https://www.npmjs.com/package/@evenrealities/evenhub-cli) |
| **Simulator** | [@evenrealities/evenhub-simulator](https://www.npmjs.com/package/@evenrealities/evenhub-simulator) |
| **Community SDK** | [@jappyjan/even-better-sdk](https://www.npmjs.com/package/@jappyjan/even-better-sdk) (JappyJan) |
| **UI components** | [@jappyjan/even-realities-ui](https://www.npmjs.com/package/@jappyjan/even-realities-ui) (JappyJan) |
| **UI/UX guidelines** | [Figma – Even Realities Software Design Guidelines](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=2922-80782&t=ZIxZJDitnBnZJOwb-1) |
| **G2 development notes** | [G2.md](https://github.com/nickustinov/even-g2-notes/blob/main/G2.md) |
| **even-dev** | [BxNxM/even-dev](https://github.com/BxNxM/even-dev) |

---

## Example apps (from even-dev README)

| App | Description |
|-----|-------------|
| [chess](https://github.com/dmyster145/EvenChess) | Chess HUD |
| [clock](https://github.com/BxNxM/even-dev/tree/main/apps/clock) | App refresh showcase |
| [demo](https://github.com/BxNxM/even-dev/tree/main/apps/demo) | Simple control showcase |
| [epub](https://github.com/chortya/epub-reader-g2) | EPUB reader (chortya) |
| [reddit](https://github.com/fuutott/rdt-even-g2-rddit-client) | Reddit feed/comments |
| [stars](https://github.com/thibautrey/even-stars) | Real-time sky chart |
| [timer](https://github.com/BxNxM/even-dev/tree/main/apps/timer) | Countdown timer |
| [transit](https://github.com/langerhans/even-transit) | Public transport planner |
| [weather](https://github.com/nickustinov/weather-even-g2) | Weather forecast |
| [restapi](https://github.com/BxNxM/even-dev/tree/main/apps/restapi) | REST API client |
| [stt](https://github.com/nickustinov/stt-even-g2) | Real-time speech-to-text (Soniox) |
| [quicktest](https://github.com/BxNxM/even-dev/tree/main/apps/quicktest) | Fast UI test (misc/editor) |

---

## Discord / community notes

Real-world quirks and tips from the Even developer Discord are in **[DISCORD_NOTES.md](./DISCORD_NOTES.md)**:

- **listEvent** vs **textEvent**: tap reliability (list best for tap), scroll direction reversed in list, missing `currentSelectItemIndex` on click.
- **Container lifecycle**: when to shutdown + createStartUp vs rebuild; navigation between containers in code.
- **Image limits**: 200×100 max, slow multi-tile updates; refresh workflow (shutdown + reload).
- **Android**: WebView suspended when screen off; SDK 0.0.7 audio; HTTPS/CORS; open questions.

Keep that file updated when you see new Discord highlights.

---

## Relation to this project (Taraweeh Companion)

This app is currently **React Native + Expo** for dev/QA and **web build** when loaded inside the Even app. The guidance above applies to **new** apps and to a possible future **standalone web** variant:

- New G2 apps: prefer **standalone web (Vite + SDK)** as in this reference.
- Existing RN/Expo app: keep using the **adapter** in `src/adapters/evenHub.ts` and the web build for Even Hub; see [EVEN_HUB_GOAL.md](./EVEN_HUB_GOAL.md) and [SDK_UPDATES.md](./SDK_UPDATES.md).
