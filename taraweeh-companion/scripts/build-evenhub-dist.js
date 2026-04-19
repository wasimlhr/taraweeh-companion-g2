/**
 * Copies the static frontend into dist/ so `evenhub pack app.json dist` finds entrypoint index.html.
 * @see https://hub.evenrealities.com/docs/reference/packaging
 */
import { mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'app', 'index.html');
const outDir = join(root, 'dist');
const dest = join(outDir, 'index.html');

mkdirSync(outDir, { recursive: true });
copyFileSync(src, dest);
console.log('[build-evenhub-dist] Wrote', dest);
