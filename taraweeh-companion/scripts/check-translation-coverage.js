/**
 * Translation coverage check — walks all 6,236 ayahs through getVerseData() for
 * every selectable language and reports any verse that would reach the display
 * without Arabic, transliteration or translation.
 *
 * Practice mode can lock onto any verse in the Quran, so a gap anywhere here is
 * a verse the user can recite and get a blank line for.
 *
 * Usage:
 *   node scripts/check-translation-coverage.js            # built-in English
 *   node scripts/check-translation-coverage.js --all      # every language
 *   node scripts/check-translation-coverage.js --lang=ur
 *   node scripts/check-translation-coverage.js --all --samples
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..', 'backend');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
const { getVerseData } = await import(join(backendDir, 'verseData.js'));

// The set server.js will actually accept (LOCAL_TRANSLATION_LANGS). Anything
// outside it is rejected and falls back to built-in English, so only these
// count toward pass/fail.
const SELECTABLE_LANGS = ['', 'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv'];
let langs;
if (argv.includes('--all')) {
  langs = SELECTABLE_LANGS;
} else if (arg('lang', null) !== null) {
  langs = [arg('lang')];
} else {
  langs = [''];
}

const origLog = console.log;
console.log = () => {};
loadQuran();
console.log = origLog;

// Ayah counts are the authority for "which verses must exist".
// Derived from the corpus rather than hardcoded, so the check cannot inherit the
// same off-by-N as the table it is validating. A stale hardcoded copy is exactly
// how Al-Hashr's 24 verses went unnoticed as 12.
const { readFileSync } = await import('fs');
const corpus = JSON.parse(readFileSync(join(backendDir, 'data', 'quran-full.json'), 'utf8'));
const SURAH_AYAH_COUNTS = Array.from({ length: 114 }, (_, i) => (corpus[String(i + 1)] || []).length);
const TOTAL = SURAH_AYAH_COUNTS.reduce((a, b) => a + b, 0);
if (TOTAL !== 6236) {
  console.error(`corpus has ${TOTAL} ayahs, expected 6236 — corpus itself is incomplete`);
  process.exit(1);
}

let failures = 0;
const rows = [];

for (const lang of langs) {
  const missing = { verse: [], arabic: [], transliteration: [], translation: [], ayahTotal: [] };
  let checked = 0;
  for (let s = 1; s <= 114; s++) {
    for (let a = 1; a <= SURAH_AYAH_COUNTS[s - 1]; a++) {
      checked++;
      const v = getVerseData(s, a, lang);
      if (!v) { missing.verse.push(`${s}:${a}`); continue; }
      if (!v.arabic || !v.arabic.trim()) missing.arabic.push(`${s}:${a}`);
      if (!v.transliteration || !v.transliteration.trim()) missing.transliteration.push(`${s}:${a}`);
      if (!v.translation || !v.translation.trim()) missing.translation.push(`${s}:${a}`);
      // "Ayah N of M" in the header comes from ayahTotal, so a wrong total shows
      // the user things like "Ayah 20 of 12".
      if (v.ayahTotal !== SURAH_AYAH_COUNTS[s - 1]) missing.ayahTotal.push(`${s}:${a} (says ${v.ayahTotal}, is ${SURAH_AYAH_COUNTS[s - 1]})`);
    }
  }
  const worst = Math.max(...Object.values(missing).map((l) => l.length));
  if (worst > 0) failures++;
  rows.push({ lang: lang || '(built-in en)', checked, missing, worst });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nChecked ${TOTAL} ayahs per language across ${langs.length} language(s)\n`);
console.log(`${pad('language', 16)}${pad('verses', 8)}${pad('no-verse', 10)}${pad('no-arabic', 11)}${pad('no-translit', 13)}${pad('no-translation', 16)}bad-ayahTotal`);
console.log('-'.repeat(90));
for (const r of rows) {
  console.log(
    pad(r.lang, 16) + pad(r.checked, 8) +
    pad(r.missing.verse.length, 10) + pad(r.missing.arabic.length, 11) +
    pad(r.missing.transliteration.length, 13) + pad(r.missing.translation.length, 16) +
    r.missing.ayahTotal.length
  );
}

const problems = rows.filter((r) => r.worst > 0);
if (problems.length) {
  console.log('\nGaps (first 12 of each):');
  for (const r of problems) {
    console.log(`\n  ${r.lang}`);
    for (const [field, list] of Object.entries(r.missing)) {
      if (list.length) console.log(`    ${pad(field, 16)} ${list.length} → ${list.slice(0, 12).join(', ')}${list.length > 12 ? ' …' : ''}`);
    }
  }
}

if (argv.includes('--samples')) {
  console.log('\nSpot samples (one short and one long surah per language):');
  for (const lang of langs) {
    for (const [s, a] of [[112, 1], [2, 255], [55, 13], [78, 40]]) {
      const v = getVerseData(s, a, lang);
      const t = (v?.translation || '(none)').replace(/\s+/g, ' ').slice(0, 68);
      console.log(`  ${pad(lang || '(built-in en)', 16)} ${pad(`${s}:${a}`, 8)} ${t}`);
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} of ${rows.length} language(s) have gaps\n`);
process.exit(failures === 0 ? 0 : 1);
