/**
 * Copies the static frontend into dist/ so `evenhub pack app.json dist` finds entrypoint index.html.
 * Also bundles the Even Hub SDK locally so the app loads it from the same module
 * realm the host injects the bridge into, instead of fetching a fresh copy from
 * a CDN URL (suspected cause of v2.4.x display-sync / persistence issues).
 *
 * @see https://hub.evenrealities.com/docs/reference/packaging
 */
import { mkdirSync, copyFileSync, existsSync, rmSync, cpSync } from 'fs';
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
// Firmware font metrics. The packed app has no network guarantee, so ship it
// alongside the SDK rather than relying on the CDN fallback.
const pretextSrc = resolvePretext();
const vendorDir = join(outDir, 'vendor');
const pretextDest = join(vendorDir, 'pretext.js');

function resolvePretext() {
  for (const base of [root, join(root, '..')]) {
    const p = join(base, 'node_modules', '@evenrealities', 'pretext', 'dist', 'font_measure.js');
    if (existsSync(p)) return p;
  }
  return null;
}

// `dist` is generated output. Clear it first so a file removed from the app
// (such as a language pack) cannot silently remain in the next EHPK.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
copyFileSync(join(root,'app','readerPagination.js'),join(outDir,'readerPagination.js'));
copyFileSync(join(root,'app','readerArtwork.js'),join(outDir,'readerArtwork.js'));
copyFileSync(join(root,'app','glassesHome.js'),join(outDir,'glassesHome.js'));
for(const module of ['readerPlayback.js','readerAudioCache.js','listenQuran.js'])copyFileSync(join(root,'app',module),join(outDir,module));
copyFileSync(join(root,'app','audio-playback-test.html'),join(outDir,'audio-playback-test.html'));
cpSync(join(root,'app','artwork'),join(outDir,'artwork'),{recursive:true});
mkdirSync(join(outDir, 'fonts'), { recursive: true });
copyFileSync(join(root, 'app', 'fonts', 'AmiriQuran.ttf'), join(outDir, 'fonts', 'AmiriQuran.ttf'));
copyFileSync(join(root, 'app', 'fonts', 'OFL.txt'), join(outDir, 'fonts', 'OFL.txt'));
for(const file of ['DigitalKhattIndoPak.otf','IndoPak-OFL.txt'])copyFileSync(join(root,'app','fonts',file),join(outDir,'fonts',file));
console.log('[build-evenhub-dist] Wrote', dest);

if (existsSync(sdkSrc)) {
  mkdirSync(sdkDestDir, { recursive: true });
  copyFileSync(sdkSrc, sdkDest);
  console.log('[build-evenhub-dist] Bundled SDK ->', sdkDest);
} else {
  throw new Error('Required bundled SDK missing: '+sdkSrc);
}

if (pretextSrc) {
  mkdirSync(vendorDir, { recursive: true });
  copyFileSync(pretextSrc, pretextDest);
  console.log('[build-evenhub-dist] Bundled pretext ->', pretextDest);
} else {
  throw new Error('Required bundled font metrics missing');
}
