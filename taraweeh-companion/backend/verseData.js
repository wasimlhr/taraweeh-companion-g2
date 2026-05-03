/**
 * Build lockedVerse display object from surah/ayah.
 * Uses verses-display.json for built-in English (lang='').
 * Uses quran-json (quran_{lang}.json + quran_transliteration.json) for other languages.
 * Uses quran-db (translator-specific JSON from github.com/faisalill/quran_db) for db:xxx.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getAyah, loadQuran } from './keywordMatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QURAN_JSON_DIR = join(__dirname, 'data', 'quran-json');
const QURAN_DB_DIR = join(__dirname, 'data', 'quran-db');

const SURAH_AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111,
  110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45,
  83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55,
  78, 96, 29, 22, 12, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56,
  40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8,
  8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

const SURAH_NAMES = [
  'Al-Fatihah', 'Al-Baqarah', 'Al-Imran', 'An-Nisa', 'Al-Ma\'idah', 'Al-An\'am', 'Al-A\'raf', 'Al-Anfal', 'At-Tawbah', 'Yunus',
  'Hud', 'Yusuf', 'Ar-Ra\'d', 'Ibrahim', 'Al-Hijr', 'An-Nahl', 'Al-Isra', 'Al-Kahf', 'Maryam', 'Ta-Ha',
  'Al-Anbiya', 'Al-Hajj', 'Al-Mu\'minun', 'An-Nur', 'Al-Furqan', 'Ash-Shu\'ara', 'An-Naml', 'Al-Qasas', 'Al-Ankabut', 'Ar-Rum',
  'Luqman', 'As-Sajdah', 'Al-Ahzab', 'Saba', 'Fatir', 'Ya-Sin', 'As-Saffat', 'Sad', 'Az-Zumar', 'Ghafir',
  'Fussilat', 'Ash-Shura', 'Az-Zukhruf', 'Ad-Dukhan', 'Al-Jathiyah', 'Al-Ahqaf', 'Muhammad', 'Al-Fath', 'Al-Hujurat', 'Qaf',
  'Adh-Dhariyat', 'At-Tur', 'An-Najm', 'Al-Qamar', 'Ar-Rahman', 'Al-Waqi\'ah', 'Al-Hadid', 'Al-Mujadila', 'Al-Hashr', 'Al-Mumtahanah',
  'As-Saf', 'Al-Jumu\'ah', 'Al-Munafiqun', 'At-Taghabun', 'At-Talaq', 'At-Tahrim', 'Al-Mulk', 'Al-Qalam', 'Al-Haqqah', 'Al-Ma\'arij',
  'Nuh', 'Al-Jinn', 'Al-Muzzammil', 'Al-Muddaththir', 'Al-Qiyamah', 'Al-Insan', 'Al-Mursalat', 'An-Naba', 'An-Nazi\'at', 'Abasa',
  'At-Takwir', 'Al-Infitar', 'Al-Mutaffifin', 'Al-Inshiqaq', 'Al-Buruj', 'At-Tariq', 'Al-A\'la', 'Al-Ghashiyah', 'Al-Fajr', 'Al-Balad',
  'Ash-Shams', 'Al-Layl', 'Ad-Duha', 'Ash-Sharh', 'At-Tin', 'Al-Alaq', 'Al-Qadr', 'Al-Bayyinah', 'Az-Zalzalah', 'Al-Adiyat',
  'Al-Qari\'ah', 'At-Takathur', 'Al-Asr', 'Al-Humazah', 'Al-Fil', 'Quraysh', 'Al-Ma\'un', 'Al-Kawthar', 'Al-Kafirun', 'An-Nasr',
  'Al-Masad', 'Al-Ikhlas', 'Al-Falaq', 'An-Nas',
];

const QURAN_JSON_LANGS = new Set([
  'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv',
  // v2.4: Tanzil-sourced via alquran.cloud
  'fa', 'ms', 'ps', 'hi', 'ha', 'sw', 'sq', 'bs', 'so', 'ta',
]);

/**
 * Languages we BELIEVE the G2 LVGL firmware font can render on the body
 * line. SDK docs only say "Unicode is supported within the firmware font
 * set" without enumerating coverage, so this is a conservative empirical
 * list — Latin (basic + extended) is almost certainly in the font; Cyrillic
 * usually is too. Anything not in this set falls back to English on glasses
 * so users never see a screen of empty boxes (□□□).
 *
 * If a script you've tested renders correctly on G2, add it here.
 * If a script renders as boxes/empty, leave it out.
 */
const GLASSES_RENDERABLE_LANGS = new Set([
  '',                                                                   // built-in English
  'en', 'fr', 'es', 'id', 'ms', 'tr', 'sq', 'bs', 'ha', 'sw', 'so', 'sv',  // Latin script
  'ru',                                                                 // Cyrillic
  // 'zh' — CJK glyphs rarely baked into embedded LVGL fonts; verify before enabling
  // 'ur', 'fa', 'ps', 'ar' — Arabic-script + RTL, almost never in LVGL
  // 'hi', 'bn', 'ta' — Indic complex shaping, almost never in LVGL
]);

let versesDisplay = null;
const quranJsonCache = new Map(); // lang -> { translation: [...], transliteration: [...] }
const quranDbCache = new Map();   // filename -> parsed JSON

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function loadQuranDb(filename) {
  if (quranDbCache.has(filename)) return quranDbCache.get(filename);
  const path = join(QURAN_DB_DIR, `${filename}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  quranDbCache.set(filename, data);
  return data;
}

function loadVersesDisplay() {
  if (versesDisplay !== null) return versesDisplay;
  const path = join(__dirname, 'data', 'verses-display.json');
  if (!existsSync(path)) return null;
  versesDisplay = JSON.parse(readFileSync(path, 'utf8'));
  return versesDisplay;
}

function loadQuranJson(lang) {
  if (quranJsonCache.has(lang)) return quranJsonCache.get(lang);
  const transPath = join(QURAN_JSON_DIR, `quran_${lang}.json`);
  const translitPath = join(QURAN_JSON_DIR, 'quran_transliteration.json');
  if (!existsSync(transPath)) return null;
  const translation = JSON.parse(readFileSync(transPath, 'utf8'));
  const transliteration = existsSync(translitPath)
    ? JSON.parse(readFileSync(translitPath, 'utf8'))
    : null;
  const data = { translation, transliteration };
  quranJsonCache.set(lang, data);
  return data;
}

/**
 * Build lockedVerse object for state payload.
 * @param {number} surah - 1-114
 * @param {number} ayah - verse number
 * @param {string} [lang] - '' = built-in English (verses-display), else quran-json lang code (en, ur, fr, ...) or db:filename (quran_db)
 * @returns {object|null} { surah, ayah, surahName, ayahTotal, arabic, transliteration, translation }
 */
export function getVerseData(surah, ayah, lang = '') {
  loadQuran();
  const ayahData = getAyah(surah, ayah);
  if (!ayahData) return null;

  const ayahTotal = SURAH_AYAH_COUNTS[surah - 1] ?? 0;
  const surahName = SURAH_NAMES[surah - 1] ?? `Surah ${surah}`;

  let transliteration = '';
  let translation = '';

  if (lang && lang.startsWith('db:')) {
    const filename = lang.slice(3);
    const db = loadQuranDb(filename);
    if (db) {
      const surahObj = db[String(surah)];
      const ayahObj = surahObj?.Ayahs?.[String(ayah)];
      if (ayahObj && typeof ayahObj === 'object') {
        const val = Object.values(ayahObj)[0];
        if (val) translation = decodeHtmlEntities(val);
      }
      // Use built-in transliteration (quran_db has no transliteration)
      const display = loadVersesDisplay();
      if (display) {
        const key = `${surah}:${ayah}`;
        const d = display[key];
        if (d) transliteration = d.transliteration || '';
      }
    }
  } else if (lang && QURAN_JSON_LANGS.has(lang)) {
    const qj = loadQuranJson(lang);
    if (qj) {
      const ch = qj.translation?.[surah - 1];
      const verse = ch?.verses?.[ayah - 1];
      if (verse) translation = verse.translation || '';
      const chTranslit = qj.transliteration?.[surah - 1];
      const verseTranslit = chTranslit?.verses?.[ayah - 1];
      if (verseTranslit) transliteration = verseTranslit.transliteration || '';
    }
  } else {
    const display = loadVersesDisplay();
    if (display) {
      const key = `${surah}:${ayah}`;
      const d = display[key];
      if (d) {
        transliteration = d.transliteration || '';
        translation = d.translation || '';
      }
    }
  }

  // Glasses body line: if the selected language uses a script the LVGL
  // firmware can render, send the actual translation. Otherwise fall back
  // to English so users see real text instead of boxes.
  let translationGlasses = translation;
  const langKey = lang || '';
  if (!GLASSES_RENDERABLE_LANGS.has(langKey)) {
    const enVerse = getVerseData(surah, ayah, '');
    translationGlasses = enVerse?.translation || translation;
  }

  return {
    surah,
    ayah,
    surahName,
    ayahTotal,
    arabic: ayahData.text,
    transliteration,
    translation,
    translationGlasses,
  };
}

/** Quran DB translations (from github.com/faisalill/quran_db) — value = lang param (db:filename) */
export const QURAN_DB_TRANSLATIONS = [
  { value: 'db:yahiyaemerick', label: 'Yahiya Emerick', desc: 'A translator offering a modern and relatable interpretation.' },
  { value: 'db:ummmuhammadsahihinternational', label: 'Umm Muhammad (Sahih International)', desc: 'A widely used modern English translation.' },
  { value: 'db:wahiduddinkhan', label: 'Wahiduddin Khan', desc: 'Known for presenting the Qur\'an\'s message of peace and universal harmony.' },
  { value: 'db:wordbyword2021', label: 'Word by Word (2021)', desc: 'Provides a detailed word-by-word translation for study.' },
  { value: 'db:wordforword2020', label: 'Word for Word (2020)', desc: 'Provides a detailed word-by-word translation for study.' },
  { value: 'db:talalitani2012', label: 'Talal Itani (2012)', desc: 'Modern translation emphasizing clarity and readability.' },
  { value: 'db:talalitaniampampai2024', label: 'Talal Itani (2024)', desc: 'Modern translation emphasizing clarity and readability.' },
  { value: 'db:muhammadmarmadukepickthall', label: 'Muhammad Marmaduke Pickthall', desc: 'A highly regarded literary English translation.' },
  { value: 'db:mfarookmalik', label: 'M. Farook Malik', desc: 'Focused on clarity and easy comprehension for English readers.' },
  { value: 'db:abdulhye', label: 'Abdul Hye', desc: 'Known for providing traditional Islamic perspectives in translation.' },
  { value: 'db:mustafakhattab2018', label: 'Mustafa Khattab (Clear Quran)', desc: 'Known for "The Clear Quran," a simple and accurate translation.' },
];
