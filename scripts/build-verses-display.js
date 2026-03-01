/**
 * Build backend/data/verses-display.json from src/data/quran.json.
 * Provides transliteration and translation for verses we have.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const quranPath = join(root, 'src', 'data', 'quran.json');
const outPath = join(root, 'backend', 'data', 'verses-display.json');

if (!existsSync(quranPath)) {
  console.error('quran.json not found');
  process.exit(1);
}

const quran = JSON.parse(readFileSync(quranPath, 'utf8'));
const result = {};

for (const surah of quran.surahs || []) {
  const sn = surah.surah_number;
  for (const ayah of surah.ayahs || []) {
    const key = `${sn}:${ayah.id}`;
    result[key] = {
      transliteration: ayah.transliteration || '',
      translation: ayah.meaning || '',
    };
  }
}

const dataDir = dirname(outPath);
if (!existsSync(dataDir)) {
  const { mkdirSync } = await import('fs');
  mkdirSync(dataDir, { recursive: true });
}

writeFileSync(outPath, JSON.stringify(result, null, 0));
console.log(`Wrote ${Object.keys(result).length} verses to ${outPath}`);
