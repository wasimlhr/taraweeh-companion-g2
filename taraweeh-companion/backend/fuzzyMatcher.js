/**
 * Fuzzy matcher for backend - matches Whisper Arabic output to Quran.
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QURAN_PATHS = [
  join(__dirname, 'data', 'quran-full.json'),
  join(__dirname, '..', 'public', 'data', 'quran-full.json'),
];

const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u06F0-\u06F9]/g;

function normalizeArabic(text) {
  return String(text)
    .replace(ARABIC_DIACRITICS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const lenA = a.length;
  const lenB = b.length;
  const matrix = [];
  for (let i = 0; i <= lenA; i++) matrix[i] = [i];
  for (let j = 0; j <= lenB; j++) matrix[0][j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return 1 - matrix[lenA][lenB] / Math.max(lenA, lenB);
}

function substringOverlap(query, text) {
  const nq = normalizeArabic(query);
  const nt = normalizeArabic(text);
  if (!nq.length) return 0;
  // Short queries (< 5 chars normalized) are too ambiguous for substring matching
  if (nq.length < 5) return 0;
  if (nt.includes(nq)) {
    const coverage = nq.length / nt.length;
    // Full containment: score based on how much of the verse the query covers
    return Math.min(1, coverage * 1.5 + 0.2);
  }
  let best = 0;
  for (let len = Math.min(nq.length, 15); len >= 5; len--) {
    for (let i = 0; i <= nq.length - len; i++) {
      if (nt.includes(nq.slice(i, i + len))) best = Math.max(best, len / nq.length * 0.7);
    }
  }
  return best;
}

function combinedScore(query, text) {
  const sim = similarity(normalizeArabic(query), normalizeArabic(text));
  const overlap = substringOverlap(query, text);
  return Math.max(sim, overlap);
}

let ayahList = [];

export function loadQuran() {
  if (ayahList.length > 0) return;
  const path = QURAN_PATHS.find((p) => existsSync(p));
  if (!path) throw new Error('quran-full.json not found. Put it in backend/data/ or public/data/');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const [surahStr, ayahs] of Object.entries(data)) {
    const surah = parseInt(surahStr, 10);
    for (const a of ayahs) {
      ayahList.push({ surah, ayah: a.verse, text: a.text });
    }
  }
}

/**
 * Fuzzy search for whisper text against Quran.
 * @param {string} whisperText - Arabic text from Whisper
 * @param {number} topN - Max candidates to return
 * @param {number} minScore - Minimum score threshold
 * @param {number} [preferredSurah] - If 1-114, only search within that surah (faster lock-on)
 */
export function fuzzySearch(whisperText, topN = 5, minScore = 0.5, preferredSurah = 0) {
  if (!whisperText || whisperText.length < 2) return [];
  if (ayahList.length === 0) loadQuran();

  const candidates = [];
  const filterSurah = preferredSurah >= 1 && preferredSurah <= 114 ? preferredSurah : 0;
  for (const { surah, ayah, text } of ayahList) {
    if (filterSurah && surah !== filterSurah) continue;
    const score = combinedScore(whisperText, text);
    if (score >= minScore) candidates.push({ surah, ayah, score, arabic: text });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN);
}

export function shouldLock(matches, topThreshold = 0.65, gapThreshold = 0.10) {
  if (matches.length < 1) return false;
  const top = matches[0].score;
  if (top < topThreshold) return false;
  if (matches.length === 1) return true;
  if (top - matches[1].score >= gapThreshold) return true;
  // If top score is very high (>= 0.8), lock even without gap (multiple verses can contain same phrase)
  return top >= 0.8;
}

/** Get verse by surah:ayah. Returns { surah, ayah, arabic } or null. */
export function getAyah(surah, ayah) {
  if (ayahList.length === 0) loadQuran();
  return ayahList.find((a) => a.surah === surah && a.ayah === ayah) ?? null;
}
