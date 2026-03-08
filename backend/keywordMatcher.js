/**
 * Quran Text Matcher v5 — Token F1 + IDF reranking.
 * Ported from Python v5 test suite results.
 *
 * Scoring: score = 0.6 * tokenF1 + 0.4 * idfWeightedRecall
 * - tokenF1:        standard F1 on normalized word overlap (no short-verse bias)
 * - idfWeightedRecall: matched word IDF / total input word IDF (downweights الله, من, etc.)
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QURAN_PATHS = [
  join(__dirname, 'data', 'quran-full.json'),
  join(__dirname, '..', 'public', 'data', 'quran-full.json'),
];

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08E1\u08E3-\u08FF\uFE70-\uFE7F]/g;
const ALEF_VARIANTS    = /[\u0622\u0623\u0625\u0671\u0672\u0673\u0675]/g;
const HAMZA_VARIANTS   = /[\u0621\u0624\u0626]/g;
const TATWEEL          = /\u0640/g;
const SMALL_MARKS      = /[\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
const DAGGER_ALEF      = /\u0670/g;  // Arabic superscript small alef (Uthmani script)

function normalize(text) {
  return String(text)
    .replace(ARABIC_DIACRITICS, '')
    .replace(SMALL_MARKS, '')
    .replace(ALEF_VARIANTS, '\u0627')
    .replace(HAMZA_VARIANTS, '')
    .replace(TATWEEL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Alternative normalization: convert dagger alef → regular alef BEFORE stripping.
 * The Quran Uthmani script writes some alefs as dagger alef (ٰ U+0670), e.g. "إنسَٰن".
 * Whisper outputs standard Arabic "إنسان" with a regular alef.
 * Current normalize() strips dagger alef as a diacritic → "انسن" ≠ Whisper's "انسان".
 * This alternate form converts dagger→alef first so both forms enter the index.
 */
function normalizeDaggerAlef(text) {
  return String(text)
    .replace(DAGGER_ALEF, '\u0627')   // dagger alef → regular alef (keep as letter)
    .replace(ARABIC_DIACRITICS, '')
    .replace(SMALL_MARKS, '')
    .replace(ALEF_VARIANTS, '\u0627')
    .replace(HAMZA_VARIANTS, '')
    .replace(TATWEEL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitWords(text) {
  return normalize(text).split(/\s+/).filter(Boolean);
}

// Whisper spells out huruf muqatta'at — map them to what appears in the Quran
const MUQATTAAT_ALIASES = {
  'ياسين': 'يس', 'يس': 'يس',
  'طه': 'طه', 'طاها': 'طه',
  'حاميم': 'حم', 'حم': 'حم',
  'الم': 'الم',
  'المص': 'المص',
  'الر': 'الر',
  'المر': 'المر',
  'كهيعص': 'كهيعص',
  'طسم': 'طسم', 'طس': 'طس',
  'ص': 'ص', 'صاد': 'ص',
  'ق': 'ق', 'قاف': 'ق',
  'ن': 'ن', 'نون': 'ن',
};

let ayahList = [];
let wordIndex = new Map();   // word → Set<ayahIndex>
let idfMap   = new Map();    // word → IDF score (capped at 8.0)

// Refrain index: surah → [{ normText, words, ayahs: sorted number[] }]
// Built at load time for verses that share identical normalized text within a surah
// (e.g. Ar-Rahman's "فبأي آلاء ربكما تكذبان" appears 31 times).
let refrainBySurah = new Map();

export function loadQuran() {
  if (ayahList.length > 0) return;
  const path = QURAN_PATHS.find(p => existsSync(p));
  if (!path) throw new Error('quran-full.json not found');
  const data = JSON.parse(readFileSync(path, 'utf8'));

  for (const [surahStr, ayahs] of Object.entries(data)) {
    const surah = parseInt(surahStr, 10);
    for (const a of ayahs) {
      const normText = normalize(a.text);
      let words = normText.split(/\s+/).filter(Boolean);

      // Also add dagger-alef-expanded form: Quran Uthmani uses ٰ (U+0670) for alefs
      // that Whisper outputs as regular alef. e.g. "ٱلۡإِنسَٰنَ"→"الانسن" (stripped)
      // but Whisper gives "الانسان" (with alef). Add the expanded form to index too.
      const normTextAlt = normalizeDaggerAlef(a.text);
      const wordsAlt = normTextAlt.split(/\s+/).filter(Boolean);

      // Add common Whisper spellings for muqatta'at letters
      const extraWords = [];
      for (const w of words) {
        for (const [alias, canonical] of Object.entries(MUQATTAAT_ALIASES)) {
          if (w === normalize(canonical)) extraWords.push(normalize(alias));
        }
      }

      // Union: original + dagger-alef-expanded + muqatta'at aliases
      words = [...new Set([...words, ...wordsAlt, ...extraWords])];
      const idx = ayahList.length;
      ayahList.push({ surah, ayah: a.verse, text: a.text, normText, words });
      for (const w of new Set(words)) {
        if (!wordIndex.has(w)) wordIndex.set(w, new Set());
        wordIndex.get(w).add(idx);
      }
    }
  }

  // Build IDF map: IDF(w) = min(8, ln(N / df(w)))
  const N = ayahList.length;
  for (const [w, indices] of wordIndex.entries()) {
    const df = indices.size;
    idfMap.set(w, Math.min(8.0, Math.log(N / Math.max(1, df))));
  }

  // Build refrain index: group identical normText within each surah
  const textGroups = new Map();
  for (const a of ayahList) {
    const key = `${a.surah}:${a.normText}`;
    if (!textGroups.has(key)) textGroups.set(key, []);
    textGroups.get(key).push(a.ayah);
  }
  let refrainGroupCount = 0;
  let refrainVerseCount = 0;
  for (const [key, ayahs] of textGroups) {
    if (ayahs.length < 2) continue;
    const surah = parseInt(key.slice(0, key.indexOf(':')), 10);
    const normText = key.slice(key.indexOf(':') + 1);
    const words = normText.split(/\s+/).filter(Boolean);
    if (!refrainBySurah.has(surah)) refrainBySurah.set(surah, []);
    refrainBySurah.get(surah).push({ normText, words, ayahs: ayahs.sort((a, b) => a - b) });
    refrainGroupCount++;
    refrainVerseCount += ayahs.length;
  }

  console.log(`[KeywordMatcher] Loaded ${ayahList.length} ayahs, ${wordIndex.size} unique words (IDF v5), ${refrainGroupCount} refrain groups (${refrainVerseCount} verses)`);
  if (process.env.DEBUG_IDF) {
    const sorted = [...idfMap.entries()].sort((a, b) => a[1] - b[1]);
    console.log('  Lowest IDF:', sorted.slice(0, 5).map(([w, v]) => `${w}=${v.toFixed(1)}`).join(', '));
    console.log('  Highest IDF:', sorted.slice(-5).reverse().map(([w, v]) => `${w}=${v.toFixed(1)}`).join(', '));
  }
}

/**
 * Score a candidate ayah against input words using Token F1 + IDF reranking.
 * Returns { score, f1, idfScore, matchedWords, coverage }
 */
function scoreCandidate(inputWords, ayahWords) {
  if (inputWords.length === 0 || ayahWords.length === 0) {
    return { score: 0, f1: 0, idfScore: 0, matchedWords: [], coverage: 0 };
  }

  // Multiset intersection: each input word matches at most as many times
  // as it appears in the ayah. Prevents "ما" × 27 inflation.
  const ayahBag = new Map();
  for (const w of ayahWords) ayahBag.set(w, (ayahBag.get(w) || 0) + 1);

  const matched = [];
  const usedBag = new Map();
  for (const w of inputWords) {
    const avail = (ayahBag.get(w) || 0) - (usedBag.get(w) || 0);
    if (avail > 0) {
      matched.push(w);
      usedBag.set(w, (usedBag.get(w) || 0) + 1);
    }
  }
  if (matched.length === 0) {
    return { score: 0, f1: 0, idfScore: 0, matchedWords: [], coverage: 0 };
  }

  const precision = matched.length / inputWords.length;
  const recall    = matched.length / ayahWords.length;
  const f1 = (precision + recall === 0) ? 0 : (2 * precision * recall) / (precision + recall);

  const fallbackIdf = 1.0;
  const inputIdfSum   = inputWords.reduce((s, w) => s + (idfMap.get(w) ?? fallbackIdf), 0);
  const matchedIdfSum = matched.reduce((s, w)  => s + (idfMap.get(w) ?? fallbackIdf), 0);
  const idfScore = inputIdfSum === 0 ? 0 : matchedIdfSum / inputIdfSum;

  const score    = 0.25 * f1 + 0.75 * idfScore;
  const coverage = matched.length / ayahWords.length;

  return { score, f1, idfScore, matchedWords: matched, coverage };
}

// Boost applied to candidates that are in the expected sequential range after the last lock
const SEQ_BOOST = 0.18;

/**
 * Find best matching ayah(s) by Token F1 + IDF scoring.
 *
 * @param {string} whisperText
 * @param {number} filterSurah - restrict to one surah (0 = all)
 * @param {object|null} seqHint - { surah, fromAyah, toAyah } predicted range from last lock
 */
export function findAnchor(whisperText, filterSurah = 0, seqHint = null) {
  if (ayahList.length === 0) loadQuran();
  const inputWords = splitWords(whisperText);
  if (inputWords.length === 0) return { matches: [], keywords: inputWords };

  // Fast path: intersect word index to find candidate ayahs
  const candidateSet = new Set();
  for (const w of inputWords) {
    const indices = wordIndex.get(w);
    if (!indices) continue;
    for (const idx of indices) candidateSet.add(idx);
  }

  // Also force-include sequential hint range so they're always evaluated
  if (seqHint) {
    for (const a of ayahList) {
      if (a.surah === seqHint.surah && a.ayah >= seqHint.fromAyah && a.ayah <= seqHint.toAyah) {
        const idx = ayahList.indexOf(a);
        if (idx >= 0) candidateSet.add(idx);
      }
    }
  }

  const results = [];
  for (const idx of candidateSet) {
    const a = ayahList[idx];
    if (filterSurah && a.surah !== filterSurah) continue;

    const { score, f1, idfScore, matchedWords, coverage } = scoreCandidate(inputWords, a.words);
    if (score < 0.01 && !(seqHint && a.surah === seqHint.surah && a.ayah >= seqHint.fromAyah && a.ayah <= seqHint.toAyah)) continue;

    // Require 2+ matched words; 3+ for longer ayahs
    if (matchedWords.length < 2) continue;
    if (matchedWords.length < 3 && a.words.length > 4) continue;

    // Sequential boost: candidate is the expected next verse(s) after last lock
    const inSeqRange = seqHint
      && a.surah === seqHint.surah
      && a.ayah >= seqHint.fromAyah
      && a.ayah <= seqHint.toAyah;
    const boostedScore = inSeqRange ? Math.min(1, score + SEQ_BOOST) : score;

    results.push({
      surah: a.surah, ayah: a.ayah,
      score: boostedScore, rawScore: score,
      f1, idfScore, coverage,
      arabic: a.text, matchedWords,
      seqBoosted: inSeqRange,
    });
  }

  results.sort((a, b) => b.score - a.score || a.surah - b.surah || a.ayah - b.ayah);
  return { matches: results.slice(0, 5), keywords: inputWords };
}

export function extractKeywords(text) {
  return splitWords(text);
}

/**
 * Check if whisperText matches any ayah within ±window of expected position.
 */
export function spotCheck(whisperText, expectedSurah, expectedAyah, window = 4) {
  if (ayahList.length === 0) loadQuran();
  const inputWords = splitWords(whisperText);
  if (inputWords.length === 0) return { found: false, surah: expectedSurah, ayah: expectedAyah, score: 0 };

  const startAyah = Math.max(1, expectedAyah - window);
  const endAyah   = expectedAyah + window;

  // ── Fast path: refrain resolution ──────────────────────────────────────────
  // If the input closely matches a known refrain in this surah, resolve directly
  // to the next instance at or after expectedAyah. No ambiguity, high confidence.
  const refrainResult = _resolveRefrain(inputWords, expectedSurah, expectedAyah, startAyah, endAyah);
  if (refrainResult) return refrainResult;

  // ── Normal scoring path ────────────────────────────────────────────────────
  let best = null;
  for (const a of ayahList) {
    if (a.surah !== expectedSurah) continue;
    if (a.ayah < startAyah || a.ayah > endAyah) continue;

    const { score, matchedWords, coverage } = scoreCandidate(inputWords, a.words);
    if (matchedWords.length < 2) continue;

    // High-coverage boost: when most/all of the ayah's words matched (e.g. short refrains),
    // the IDF score is low because the words are common, but the match is actually solid.
    const effectiveScore = (coverage >= 0.80 && matchedWords.length >= 3) ? Math.max(score, 0.50) : score;

    if (!best || effectiveScore > best.score) {
      best = { found: true, surah: a.surah, ayah: a.ayah, score: effectiveScore, matchedWords };
    } else if (effectiveScore === best.score) {
      const bestAhead = best.ayah >= expectedAyah;
      const candAhead = a.ayah >= expectedAyah;
      if (candAhead && !bestAhead) {
        best = { found: true, surah: a.surah, ayah: a.ayah, score: effectiveScore, matchedWords };
      } else if (candAhead === bestAhead) {
        if (Math.abs(a.ayah - expectedAyah) < Math.abs(best.ayah - expectedAyah)) {
          best = { found: true, surah: a.surah, ayah: a.ayah, score: effectiveScore, matchedWords };
        }
      }
    }
  }

  return best || { found: false, surah: expectedSurah, ayah: expectedAyah, score: 0 };
}

/**
 * Resolve a refrain match: if the input words are a close match to a known repeated
 * verse in this surah, return the next instance at or after expectedAyah (within bounds).
 * Returns null if no refrain match found.
 */
function _resolveRefrain(inputWords, surah, expectedAyah, startAyah, endAyah) {
  const groups = refrainBySurah.get(surah);
  if (!groups) return null;

  for (const { words: refrainWords, ayahs } of groups) {
    const { matchedWords, coverage } = scoreCandidate(inputWords, refrainWords);

    // Require high coverage of the refrain AND that most input words matched.
    // This catches both exact matches and Whisper's slightly garbled versions.
    if (coverage < 0.75 || matchedWords.length < 3) continue;
    const inputCoverage = matchedWords.length / inputWords.length;
    if (inputCoverage < 0.50) continue;

    // Find the next refrain instance at or after expectedAyah, within bounds
    let resolved = null;
    for (const ay of ayahs) {
      if (ay < startAyah || ay > endAyah) continue;
      if (ay >= expectedAyah) { resolved = ay; break; }
      if (!resolved || ay > resolved) resolved = ay;
    }

    if (resolved !== null) {
      console.log(`[KeywordMatcher] Refrain resolved: ${surah}:${resolved} (expected :${expectedAyah}, group has ${ayahs.length} instances, cov=${(coverage * 100).toFixed(0)}%)`);
      return {
        found: true,
        surah,
        ayah: resolved,
        score: 0.85,
        matchedWords,
      };
    }
  }

  return null;
}

export function resyncInSurah(whisperText, surah) {
  return findAnchor(whisperText, surah);
}

export function getAyah(surah, ayah) {
  if (ayahList.length === 0) loadQuran();
  return ayahList.find(a => a.surah === surah && a.ayah === ayah) ?? null;
}

export function isRefrain(surah, ayah) {
  const groups = refrainBySurah.get(surah);
  if (!groups) return false;
  return groups.some(g => g.ayahs.includes(ayah));
}
