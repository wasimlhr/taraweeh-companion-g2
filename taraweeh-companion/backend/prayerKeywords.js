/**
 * Acoustic cues that mark posture changes in salah, plus the Quran anchors the
 * tracker uses to correct itself.
 *
 * Whisper transcribes mosque audio through reverb and a loudspeaker, so the
 * same phrase comes back spelled a dozen ways ("الله أكبر" / "الله اكبى" /
 * "اللّٰه اكبر"). Everything here therefore matches against an aggressively
 * normalised form: marks and tatweel removed, alef/ya/teh-marbuta variants
 * folded together.
 *
 * Detection returns a confidence rather than a boolean because several cues are
 * also Quranic text. "وَلَذِكْرُ اللَّهِ أَكْبَرُ" (29:45) is a takbeer by
 * spelling and a verse by intent; the only thing separating them is that a real
 * transition cue is spoken alone, while the verse arrives surrounded by
 * recitation. Isolation is what the confidence measures.
 */

const MARKS_RE = /[\u064B-\u065F\u0610-\u061A\u0670\u06D6-\u06ED\u0640]/g;

/** Fold the spellings Whisper picks at random into one canonical form. */
export function normalizeCue(text) {
  return String(text || '')
    .replace(MARKS_RE, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')  // آ أ إ ٱ → ا
    .replace(/\u0649/g, '\u064A')                      // ى → ي
    .replace(/[\u0629\u06D5]/g, '\u0647')              // ة ە → ه
    .replace(/\u0624/g, '\u0648')                      // ؤ → و
    .replace(/\u0626/g, '\u064A')                      // ئ → ي
    .replace(/[^\u0600-\u06FF\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Cue patterns (all tested against normalizeCue output) ───────────────────

/** "الله أكبر" — every posture change except standing up from ruku'.
 *  Mosque ASR often hears the opening as "اللهم أكبر". */
const TAKBEER_RE = /الله(م)?\s*(و\s*)?(ال)?اكب[ريا]/u;

// "سمع الله لمن حمده" — the imam says this rising out of ruku'. Whisper hears
// the long vowel as often as not, so "سمع" and "سميع" both have to match, and
// the opening "سمع" is frequently dropped ("الله لمن حميدا").
const TASMEE_RE = /(سم[عي]ع?\s*)?ا?لله\s*(لمن|من)\s*حم[ي]?د/u;

/** "ربنا ولك الحمد" — the congregation's reply, so it also marks i'tidal.
 *  Small Whisper often returns just "ولك الحمد" / "أولك الحمد". */
const TAHMEED_RE = /ربنا\s*(و\s*)?(ل)?ك\s*ال\s*حمد|(ا?و)?لك\s*ال\s*حمد/u;

/** "السلام عليكم ورحمة الله" — ends the set of rak'ahs. */
const TASLEEM_RE = /(ال)?سلام\s*علي\s*كم|(ال)?سلام\s*عليكم/u;

/** Tashahhud openings — "التحيات لله", the shahada, the salah on the Prophet. */
const TASHAHHUD_RE =
  /التحيات|الت\s*حيات|اللهم\s*صل\s*علي\s*محمد|اشهد\s*ان\s*لا\s*اله\s*الا\s*الله/u;

/** Du'a al-Qunoot openings (witr). */
const QUNOOT_RE = /اللهم\s*اهدن[اي]|اللهم\s*انا\s*نستعينك|نستعينك\s*و\s*نستغفرك/u;

/** "ولا الضالين" — the last words of Al-Fatiha, i.e. a guaranteed qiyam. */
const FATIHA_END_RE = /(و\s*)?لا\s*ال\s*ضالين|(و\s*)?لا\s*الضالين/u;

/** "الحمد لله رب العالمين" — the first words of Al-Fatiha. */
const FATIHA_START_RE = /الحمد\s*لله\s*رب\s*ال\s*عالمين|الحمد\s*لله\s*رب\s*العالمين/u;

const AMEEN_RE = /^ا?مين(\s+ا?مين)*$/u;

/**
 * The 15 ayat of sajdah. Reciting one of these means the imam may prostrate
 * straight from qiyam, skipping ruku' entirely — the tracker has to be told so
 * it does not read those two takbeers as a rak'ah.
 */
export const SAJDAH_AYAT = Object.freeze([
  '7:206', '13:15', '16:50', '17:109', '19:58',
  '22:18', '22:77', '25:60', '27:26', '32:15',
  '38:24', '41:38', '53:62', '84:21', '96:19',
]);

const SAJDAH_SET = new Set(SAJDAH_AYAT);

export function hasSajdah(surah, ayah) {
  return SAJDAH_SET.has(`${Number(surah)}:${Number(ayah)}`);
}

// ── Boolean helpers (kept for call sites that only need a yes/no) ───────────

export function isTakbeer(text)   { return TAKBEER_RE.test(normalizeCue(text)); }
export function isTasmee(text)    { return TASMEE_RE.test(normalizeCue(text)); }
export function isTahmeed(text)   { return TAHMEED_RE.test(normalizeCue(text)); }
export function isTasleem(text)   { return TASLEEM_RE.test(normalizeCue(text)); }
export function isTashahhud(text) { return TASHAHHUD_RE.test(normalizeCue(text)); }
export function isQunoot(text)    { return QUNOOT_RE.test(normalizeCue(text)); }
export function isFatihaEnd(text) { return FATIHA_END_RE.test(normalizeCue(text)); }
export function isFatihaStart(text) { return FATIHA_START_RE.test(normalizeCue(text)); }
export function isAmeenCue(text)  { return AMEEN_RE.test(normalizeCue(text)); }

/** Backwards-compatible name used by the audio pipelines. */
export function isPrayerTransition(text) {
  const n = normalizeCue(text);
  return TAKBEER_RE.test(n) || TASMEE_RE.test(n);
}

// ── Cue detection with confidence ───────────────────────────────────────────

// Order matters: tasmee' contains "الله", and the tashahhud contains the
// shahada, so the more specific phrase has to be tested first.
const CUES = [
  { kind: 'tasmee',    re: TASMEE_RE,    words: 4 },
  { kind: 'tahmeed',   re: TAHMEED_RE,   words: 4 },
  { kind: 'tasleem',   re: TASLEEM_RE,   words: 4 },
  { kind: 'qunoot',    re: QUNOOT_RE,    words: 3 },
  { kind: 'tashahhud', re: TASHAHHUD_RE, words: 3 },
  { kind: 'takbeer',   re: TAKBEER_RE,   words: 2 },
];

function wordCount(s) {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Identify the posture cue in a transcript chunk, if any.
 *
 * `confidence` is the P_audio term of the voting formula, and it is driven by
 * what comes *after* the cue rather than by the length of the chunk. A
 * transcription window routinely spans the end of an ayah and the takbeer that
 * follows it — that is a real transition, and the cue sits at the end. A verse
 * that merely quotes the phrase keeps going afterwards: 29:45 is
 * "وَلَذِكْرُ اللَّهِ أَكْبَرُ وَاللَّهُ يَعْلَمُ مَا تَصْنَعُونَ", and those
 * trailing words are what give it away.
 *
 * @returns {{kind: string, confidence: number, text: string, match: string,
 *            leading: number, trailing: number}|null}
 */
export function detectPrayerCue(text) {
  const n = normalizeCue(text);
  if (!n) return null;
  for (const cue of CUES) {
    const m = n.match(cue.re);
    if (!m) continue;
    const leading = wordCount(n.slice(0, m.index));
    const trailing = wordCount(n.slice(m.index + m[0].length));
    const confidence = trailing === 0 ? 1
      : trailing <= 2 ? 0.7
      : trailing <= 5 ? 0.35
      : 0.15;
    return { kind: cue.kind, confidence, text: n, match: m[0], leading, trailing };
  }
  return null;
}
