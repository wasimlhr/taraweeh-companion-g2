/**
 * Fetch transliteration + English translation for all 6236 Quran verses
 * from the Quran.com API v4 and write backend/data/verses-display.json.
 *
 * Usage: node scripts/fetch-verses-display.js
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'backend', 'data', 'verses-display.json');

const BASE = 'https://api.quran.com/api/v4/verses/by_chapter';
const TRANSLIT_ID = 57;
const TRANSLATION_ID = 20; // Sahih International
const PER_PAGE = 300;
const TOTAL_SURAHS = 114;

function stripFootnotes(text) {
  return text
    .replace(/<sup.*?<\/sup>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*\d+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPages(surah, translationId) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `${BASE}/${surah}?translations=${translationId}&per_page=${PER_PAGE}&page=${page}&fields=text_uthmani`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for surah ${surah} page ${page}`);
    const data = await res.json();
    all.push(...data.verses);
    if (!data.pagination.next_page) break;
    page++;
  }
  return all;
}

async function fetchSurah(surah) {
  const [translitVerses, translationVerses] = await Promise.all([
    fetchPages(surah, TRANSLIT_ID),
    fetchPages(surah, TRANSLATION_ID),
  ]);

  const translitMap = {};
  for (const v of translitVerses) {
    const t = v.translations?.[0]?.text || '';
    translitMap[v.verse_key] = stripFootnotes(t);
  }

  const translationMap = {};
  for (const v of translationVerses) {
    const t = v.translations?.[0]?.text || '';
    translationMap[v.verse_key] = stripFootnotes(t);
  }

  const result = {};
  const keys = new Set([...Object.keys(translitMap), ...Object.keys(translationMap)]);
  for (const key of keys) {
    result[key] = {
      transliteration: translitMap[key] || '',
      translation: translationMap[key] || '',
    };
  }
  return result;
}

async function main() {
  const result = {};
  let total = 0;

  for (let s = 1; s <= TOTAL_SURAHS; s++) {
    process.stdout.write(`Surah ${s}/${TOTAL_SURAHS}...`);
    try {
      const data = await fetchSurah(s);
      Object.assign(result, data);
      const count = Object.keys(data).length;
      total += count;
      process.stdout.write(` ${count} verses\n`);
    } catch (err) {
      console.error(` ERROR: ${err.message}`);
      // retry once after 2s
      await new Promise(r => setTimeout(r, 2000));
      try {
        const data = await fetchSurah(s);
        Object.assign(result, data);
        total += Object.keys(data).length;
        console.log(`  Retry OK`);
      } catch (err2) {
        console.error(`  Retry failed: ${err2.message}`);
      }
    }
    // rate limit courtesy
    await new Promise(r => setTimeout(r, 200));
  }

  const dir = dirname(outPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(result));
  console.log(`\nDone! Wrote ${total} verses to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
