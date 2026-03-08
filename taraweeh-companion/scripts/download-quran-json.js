/**
 * Download quran-json files from CDN to backend/data/quran-json/
 * Run: node scripts/download-quran-json.js
 *
 * Source: https://github.com/risan/quran-json
 * CDN: https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist/
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'backend', 'data', 'quran-json');
const CDN = 'https://cdn.jsdelivr.net/npm/quran-json@3.1.2/dist';

const FILES = [
  'quran.json',
  'quran_transliteration.json',
  'quran_bn.json',
  'quran_zh.json',
  'quran_en.json',
  'quran_es.json',
  'quran_fr.json',
  'quran_id.json',
  'quran_ru.json',
  'quran_sv.json',
  'quran_tr.json',
  'quran_ur.json',
];

async function fetchUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Downloading to ${OUT_DIR}...`);

  for (const file of FILES) {
    const url = `${CDN}/${file}`;
    process.stdout.write(`${file}... `);
    try {
      const text = await fetchUrl(url);
      const outPath = join(OUT_DIR, file);
      writeFileSync(outPath, text);
      console.log(`OK (${(text.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
