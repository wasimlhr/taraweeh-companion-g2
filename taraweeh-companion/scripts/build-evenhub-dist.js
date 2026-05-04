/**
 * Copies the static frontend into dist/ so `evenhub pack app.json dist` finds entrypoint index.html.
 * Also bundles the Even Hub SDK locally so the app loads it from the same module
 * realm the host injects the bridge into, instead of fetching a fresh copy from
 * a CDN URL (suspected cause of v2.4.x sideload-persistence issues).
 *
 * @see https://hub.evenrealities.com/docs/reference/packaging
 */
import { mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'app', 'index.html');
const outDir = join(root, 'dist');
const dest = join(outDir, 'index.html');
const sdkSrc = join(root, 'node_modules', '@evenrealities', 'even_hub_sdk', 'dist', 'index.js');
const sdkDestDir = join(outDir, 'sdk');
const sdkDest = join(sdkDestDir, 'even_hub_sdk.js');

mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
console.log('[build-evenhub-dist] Wrote', dest);

if (existsSync(sdkSrc)) {
  mkdirSync(sdkDestDir, { recursive: true });
  copyFileSync(sdkSrc, sdkDest);
  console.log('[build-evenhub-dist] Bundled SDK ->', sdkDest);
} else {
  console.warn('[build-evenhub-dist] WARN: SDK file not found at', sdkSrc, '— app will fall back to CDN import');
}
