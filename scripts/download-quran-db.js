/**
 * Download quran_db translation files from GitHub to backend/data/quran-db/
 * Run: node scripts/download-quran-db.js
 *
 * Source: https://github.com/faisalill/quran_db
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'backend', 'data', 'quran-db');
const BASE = 'https://raw.githubusercontent.com/faisalill/quran_db/main';

const FILES = [
  'yahiyaemerick.json',
  'ummmuhammadsahihinternational.json',
  'wahiduddinkhan.json',
  'wordbyword2021.json',
  'wordforword2020.json',
  'talalitani2012.json',
  'talalitaniampampai2024.json',
  'muhammadmarmadukepickthall.json',
  'mfarookmalik.json',
  'abdulhye.json',
  'mustafakhattab2018.json',
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
    const url = `${BASE}/${file}`;
    process.stdout.write(`${file}... `);
    try {
      const text = await fetchUrl(url);
      const outPath = join(OUT_DIR, file);
      writeFileSync(outPath, text);
      console.log(`OK (${(text.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
