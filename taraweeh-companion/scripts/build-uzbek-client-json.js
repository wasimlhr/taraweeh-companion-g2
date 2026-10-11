/**
 * Compact Alauddin Mansour Cyrillic for the packed app. The hosted backend
 * can lag the .ehpk; the glasses/phone still need Uzbek without waiting.
 *
 *   node scripts/build-uzbek-client-json.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'backend/data/quran-json/quran_uzc.json');
const dest = join(root, 'app/uzbek-cyrillic.json');

const chapters = JSON.parse(readFileSync(src, 'utf8'));
if (!Array.isArray(chapters) || chapters.length !== 114) {
  throw new Error(`expected 114 chapters, got ${chapters?.length}`);
}
const cyr = chapters.map((ch) => (ch.verses || []).map((v) => String(v.translation || '')));
const ayahs = cyr.reduce((n, s) => n + s.length, 0);
if (ayahs !== 6236) throw new Error(`expected 6236 ayahs, got ${ayahs}`);

const payload = { v: 1, src: 'alauddin-mansour', cyr };
writeFileSync(dest, JSON.stringify(payload));
console.log(`[build-uzbek-client-json] ${ayahs} ayahs -> ${dest}`);
