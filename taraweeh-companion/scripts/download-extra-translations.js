/**
 * Fetch extra-language Quran translations and reshape to the quran-json format
 * we already use for English/Urdu/etc (matches https://github.com/risan/quran-json).
 *
 * Source: alquran.cloud REST API — returns clean JSON, one HTTP call per edition.
 * Run: node scripts/download-extra-translations.js
 *
 * Adds to backend/data/quran-json/quran_<code>.json:
 *   fa, ms, ps, hi, ha, sw, sq, bs, so, ta
 *
 * Each output file matches the existing shape:
 *   { "0": { id, name, transliteration, translation, type, total_verses, verses: [{id, text, translation}] }, "1": ..., ..., "113": ... }
 *
 * Surah metadata (name, transliteration, type, total_verses) is copied from the
 * existing quran.json so structure stays identical to risan/quran-json.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'backend', 'data', 'quran-json');
const ALQURAN = 'https://api.alquran.cloud/v1/quran';

// langCode → { edition, label } picked from Tanzil (most standard translator per language)
const EDITIONS = [
  { lang: 'fa', edition: 'fa.fooladvand', label: 'Persian (Fooladvand)' },
  { lang: 'ms', edition: 'ms.basmeih',    label: 'Malay (Basmeih)' },
  { lang: 'ps', edition: 'ps.abdulwali',  label: 'Pashto (Abdulwali)' },
  { lang: 'hi', edition: 'hi.farooq',     label: 'Hindi (Farooq Khan)' },
  { lang: 'ha', edition: 'ha.gumi',       label: 'Hausa (Gumi)' },
  { lang: 'sw', edition: 'sw.barwani',    label: 'Swahili (Al-Barwani)' },
  { lang: 'sq', edition: 'sq.nahi',       label: 'Albanian (Efendi Nahi)' },
  { lang: 'bs', edition: 'bs.korkut',     label: 'Bosnian (Korkut)' },
  { lang: 'so', edition: 'so.abduh',      label: 'Somali (Abduh)' },
  { lang: 'ta', edition: 'ta.tamil',      label: 'Tamil (Jan Turst Foundation)' },
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

function loadBaseStructure() {
  // Pull surah metadata (Arabic name, transliteration, type, verse counts) from
  // the existing quran.json so the output shape matches risan/quran-json exactly.
  const path = join(OUT_DIR, 'quran.json');
  if (!existsSync(path)) {
    throw new Error(`Missing base file: ${path}\nRun: node scripts/download-quran-json.js first`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function reshape(alquranData, base) {
  // alquran.cloud shape: { data: { surahs: [{ number, name, englishName, englishNameTranslation, revelationType, ayahs: [{ numberInSurah, text }] }] } }
  // Output (matches existing quran_xx.json): { "0": { id, name, transliteration, translation, type, total_verses, verses: [{ id, text, translation }] } }
  const out = {};
  const surahs = alquranData?.data?.surahs;
  if (!Array.isArray(surahs) || surahs.length !== 114) {
    throw new Error(`Expected 114 surahs, got ${surahs?.length}`);
  }
  for (let i = 0; i < 114; i++) {
    const src = surahs[i];
    const baseSurah = base[String(i)] || base[i];
    const verses = (src.ayahs || []).map((a, idx) => ({
      id: a.numberInSurah || (idx + 1),
      // text = original Arabic, copied from base; alquran returns translation in 'text' for translation editions
      text: baseSurah.verses[idx]?.text || '',
      translation: a.text || '',
    }));
    out[String(i)] = {
      id: src.number,
      name: baseSurah.name,                             // Arabic name
      transliteration: baseSurah.transliteration,       // Latin
      translation: src.englishNameTranslation || baseSurah.translation || '', // English meaning of surah name
      type: baseSurah.type || (src.revelationType || '').toLowerCase(),
      total_verses: verses.length,
      verses,
    };
  }
  return out;
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const base = loadBaseStructure();
  console.log(`Base structure loaded — ${Object.keys(base).length} surahs`);

  let ok = 0, skipped = 0, failed = 0;
  for (const e of EDITIONS) {
    const outPath = join(OUT_DIR, `quran_${e.lang}.json`);
    if (existsSync(outPath) && !process.argv.includes('--force')) {
      console.log(`  • ${e.lang} skip (exists, --force to overwrite)`);
      skipped++;
      continue;
    }
    try {
      process.stdout.write(`  • ${e.lang} (${e.label})… `);
      const data = await fetchJson(`${ALQURAN}/${e.edition}`);
      const reshaped = reshape(data, base);
      writeFileSync(outPath, JSON.stringify(reshaped));
      const sizeKB = Math.round((JSON.stringify(reshaped).length) / 1024);
      console.log(`${sizeKB}KB ✓`);
      ok++;
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nDone: ${ok} written, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
