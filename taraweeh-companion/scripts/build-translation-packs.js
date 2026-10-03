/**
 * Compact per-language translation tables for optional on-device packs.
 * Not loaded at runtime unless the user downloads that language.
 *
 *   node scripts/build-translation-packs.js
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'backend/data/quran-json');
const destDir = join(root, 'app/translations');
const LANGS = ['en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv', 'uzc'];
export { LANGS as PACK_LANGS };

export function compactLang(lang) {
  const src = join(srcDir, `quran_${lang}.json`);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  const chapters = JSON.parse(readFileSync(src, 'utf8'));
  if (!Array.isArray(chapters) || chapters.length !== 114) {
    throw new Error(`${lang}: expected 114 chapters, got ${chapters?.length}`);
  }
  const verses = chapters.map((ch) => (ch.verses || []).map((v) => String(v.translation || '')));
  const ayahs = verses.reduce((n, s) => n + s.length, 0);
  if (ayahs !== 6236) throw new Error(`${lang}: expected 6236 ayahs, got ${ayahs}`);
  return { v: 1, lang, ayahs, verses };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  mkdirSync(destDir, { recursive: true });
  for (const lang of LANGS) {
    const payload = compactLang(lang);
    const dest = join(destDir, `${lang}.json`);
    writeFileSync(dest, JSON.stringify(payload));
    console.log(`[build-translation-packs] ${lang} ${payload.ayahs} ayahs -> ${dest}`);
  }
}
