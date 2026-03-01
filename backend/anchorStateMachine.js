/**
 * Keyword Anchor State Machine — tracks Quran recitation position.
 *
 * SEARCHING → findAnchor() → LOCKED
 * LOCKED → auto-advance + spot-check every N ayahs → RESUMING on fail
 * RESUMING → resync ±6 ayahs → full surah → SEARCHING
 */
import { findAnchor, spotCheck, resyncInSurah, extractKeywords } from './keywordMatcher.js';

const SPOT_CHECK_INTERVAL    = 4;   // spot-check every N ayahs
// With 10s locked chunks, each miss = ~10s of silence.
// 3 misses → ~30s of silence before RESUMING (reasonable pause between surahs/sections)
const MISSED_BEFORE_RESUMING = 3;
// 4 misses in RESUMING (~40s) → global re-search
const MISSED_BEFORE_LOST     = 4;

// Backward correction guard — keeps the display flowing forward.
// The reading-timer + pause-detection drive forward progress; Whisper corrects.
// Backward jumps larger than this cap are applied in stages (one cap per Whisper cycle)
// so the user never sees a jarring 3-5 ayah snap backward.
// e.g. display at 72, Whisper says 69 (dist=3):
//   Cycle 1: cap → jump to 70   (−2)
//   Cycle 2: dist=1, no cap    → jump to 69  (−1)
// With 5s Whisper chunks, each cycle is ~6s. Cap of 4 lets us realign in one cycle
// for most cases. Only truly huge gaps (5+) get staged across two cycles.
const BACK_STEP_CAP = 4;   // max ayahs to move backward in one Whisper cycle

// v5 ambiguity-aware lock — prevents premature lock on shared openings (e.g. 2:255 vs 3:2)
const LOCK_WINS_REQUIRED = 2;     // consecutive chunks must agree
const LOCK_MARGIN_MIN    = 5;     // score gap (% points) between #1 and #2
const LOCK_COVERAGE_MIN  = 0.25;  // ≥25% of target ayah's words must be matched
const LOCK_MIN_WORDS     = 3;     // matched words must be ≥ this to prevent single-word fast-locks
const FAST_LOCK_SCORE    = 0.75;  // instant lock when score ≥ this AND margin ≥ 30
const SINGLE_WIN_SCORE  = 0.45;  // solid IDF match on first chunk → lock
const SINGLE_WIN_MARGIN = 8;     // 8 point gap to #2 required

const SURAH_AYAH_COUNTS = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111,
  110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45,
  83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55,
  78, 96, 29, 22, 12, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20, 56,
  40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21, 11, 8,
  8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

function getNextAyah(surah, ayah) {
  const count = SURAH_AYAH_COUNTS[surah - 1] ?? 0;
  if (ayah < count) return { surah, ayah: ayah + 1 };
  // End of surah — don't cross to next surah
  return null;
}

function getPrevAyah(surah, ayah) {
  if (ayah > 1) return { surah, ayah: ayah - 1 };
  if (surah <= 1) return null;
  const prevCount = SURAH_AYAH_COUNTS[surah - 2] ?? 0;
  return { surah: surah - 1, ayah: prevCount };
}

export function createState() {
  return {
    mode: 'SEARCHING',
    surah: 0,
    ayah: 0,
    confidence: 0,
    missedChunks: 0,
    ayahsSinceLock: 0,
    ayahsSinceCheck: 0,
    lastKeywords: [],
    nonQuranText: undefined,
    nonQuranMeaning: undefined,
    nonQuranType: undefined,
    _matches: [],
    _locked: false,
    // v5: consecutive wins tracking for ambiguity-aware locking
    _wins: 0,
    _pendingMatch: null,
    // Sequential context: remembered across LOCKED → SEARCHING transitions
    lastLockedSurah: 0,
    lastLockedAyah: 0,
  };
}

/**
 * Process a Whisper transcription result through the keyword anchor pipeline.
 * @param {string} whisperText - cleaned Arabic text from Whisper
 * @param {object} state - current state
 * @param {object} options - {preferredSurah}
 * @returns {object} new state
 */
export function processWhisperResult(whisperText, state, options = {}) {
  const { preferredSurah = 0, fastMode = false } = options;

  switch (state.mode) {
    case 'SEARCHING':
      return handleSearching(whisperText, state, preferredSurah);
    case 'LOCKED':
      return handleLocked(whisperText, state, fastMode);
    case 'RESUMING':
      return handleResuming(whisperText, state);
    default:
      return handleSearching(whisperText, state, preferredSurah);
  }
}

function handleSearching(whisperText, state, preferredSurah) {
  // After a surah completes, bias toward the NEXT surah (sequential order in Quran)
  // e.g. after Luqman (31) ends, boost As-Sajdah (32) ayah 1-10
  const lastSurah = state.lastLockedSurah;
  const lastAyah  = state.lastLockedAyah;
  const lastSurahSize = SURAH_AYAH_COUNTS[lastSurah - 1] ?? 0;
  const surahJustCompleted = lastSurah > 0 && lastAyah >= lastSurahSize;
  const postFatiha = lastSurah === 1 && surahJustCompleted;

  let seqHint;
  if (surahJustCompleted && lastSurah < 114 && lastSurah !== 1) {
    // Point to first ayahs of the NEXT surah (but NOT after Fatiha — in prayer Fatiha is
    // always followed by a different surah chosen by the imam, not necessarily surah 2).
    seqHint = { surah: lastSurah + 1, fromAyah: 1, toAyah: 10 };
  } else if (lastSurah > 0 && !surahJustCompleted) {
    // Normal mid-surah resync: look ahead up to 6 ayahs
    seqHint = { surah: lastSurah, fromAyah: Math.max(1, lastAyah), toAyah: lastAyah + 6 };
  } else {
    seqHint = null;
  }

  // Mid-surah resync: always try same surah first, then fall back to global.
  // When surah just completed, also try the same surah — the display may have raced ahead.
  // EXCEPTION: after Fatiha (surah 1), skip the same-surah search entirely — the imam
  // will recite a completely different surah, so searching surah 1 is pure waste.
  let matches, keywords;
  if (lastSurah > 0 && !postFatiha) {
    const sameSurahResult = findAnchor(whisperText, lastSurah, seqHint);
    matches  = sameSurahResult.matches;
    keywords = sameSurahResult.keywords;
    const sameBest = matches.length ? matches[0].score : 0;
    // Also try global search if same-surah match is weak or surah just completed
    if (sameBest < 0.55 || surahJustCompleted) {
      const globalResult = findAnchor(whisperText, preferredSurah, seqHint);
      if (globalResult.matches.length && globalResult.matches[0].score > sameBest) {
        console.log(`[Anchor] Global search beats same-surah (${globalResult.matches[0].score.toFixed(2)} > ${sameBest.toFixed(2)}): [${globalResult.matches[0].surah}:${globalResult.matches[0].ayah}]`);
        matches  = globalResult.matches;
        keywords = globalResult.keywords;
      } else if (!matches.length) {
        matches  = globalResult.matches;
        keywords = globalResult.keywords;
        if (matches.length) {
          console.log(`[Anchor] No match in surah ${lastSurah} — global search found [${matches[0].surah}:${matches[0].ayah}]`);
        }
      }
    }
  } else {
    ({ matches, keywords } = findAnchor(whisperText, preferredSurah, seqHint));
  }

  if (matches.length === 0) {
    console.log(`[Anchor] No matches for keywords=[${extractKeywords(whisperText).join(', ')}]`);
    // Only preserve pending wins for reasonably confident candidates (≥ SINGLE_WIN_SCORE).
    // Weak matches must NOT accumulate wins across noise windows — doing so lets a feeble
    // 0.48-score candidate reach wins=2 and trigger isConsistentLock prematurely.
    const pendingScore = state._pendingMatch?.score ?? 0;
    if (pendingScore >= SINGLE_WIN_SCORE) {
      return { ...state, _matches: [], _locked: false, lastKeywords: keywords };
    }
    return { ...state, _matches: [], _locked: false, _wins: 0, _pendingMatch: null, lastKeywords: keywords };
  }

  const top    = matches[0];
  const second = matches[1];
  // Use raw score for margin so the sequential boost doesn't inflate it
  const topRaw    = top.rawScore ?? top.score;
  const secondRaw = second ? (second.rawScore ?? second.score) : 0;
  const margin    = second ? (topRaw - secondRaw) * 100 : topRaw * 100;
  const coverage  = top.coverage || 0;

  console.log(`[Anchor] Top: [${top.surah}:${top.ayah}] score=${top.score.toFixed(2)}${top.seqBoosted ? '(+seq)' : ''} F1=${(top.f1||0).toFixed(2)} IDF=${(top.idfScore||0).toFixed(2)} margin=${margin.toFixed(1)} cov=${(coverage*100).toFixed(0)}%`);
  matches.slice(0, 3).forEach((m, i) =>
    console.log(`  ${i + 1}. [${m.surah}:${m.ayah}] score=${m.score.toFixed(2)} matched=[${m.matchedWords?.join(', ')}]`)
  );

  // Consecutive wins tracking — same candidate as last chunk?
  // Also carry wins forward if the reciter advanced 1-3 ayahs in the same surah
  // between windows — the candidate changed but it's sequential progression, not noise.
  const pending     = state._pendingMatch;
  const samePending = pending && pending.surah === top.surah && pending.ayah === top.ayah;
  const seqAdvance  = pending && pending.surah === top.surah
    && top.ayah > pending.ayah && top.ayah <= pending.ayah + 3;
  const wins = samePending ? (state._wins || 0) + 1
             : seqAdvance  ? (state._wins || 0) + 1
             : 1;
  if (seqAdvance && !samePending) {
    console.log(`[Anchor] Sequential advance ${pending.surah}:${pending.ayah} → :${top.ayah} — carrying wins (${wins})`);
  }

  // Cross-surah guard: if we just completed a surah and this candidate is NOT the next
  // sequential surah, demand a much higher bar (prevent random surah jumps after completion).
  // EXCEPTION 1: if the top match is back in the SAME surah that "ended", the display raced
  // ahead of the reciter (read-advance overshot). Treat as normal mid-surah resync.
  // EXCEPTION 2: Fatiha (surah 1) is recited at the start of every rak'ah in prayer —
  // it is NEVER unexpected regardless of which surah just completed. Without this,
  // the cross-surah penalty would block re-locking on Fatiha in each subsequent rak'ah.
  const displayRacedAhead = surahJustCompleted && top.surah === lastSurah && top.ayah < lastAyah;
  // After Fatiha (surah 1), the imam ALWAYS continues with a different surah — never surah 2
  // necessarily. Setting expectedNextSurah=2 after Fatiha would block re-locking on any
  // other surah with the harsh cross-surah penalty. Disable the expectation for surah 1.
  const expectedNextSurah = (surahJustCompleted && !displayRacedAhead && lastSurah !== 1) ? lastSurah + 1 : 0;
  const isFatihaCandiate  = top.surah === 1;   // always valid — starts every rak'ah
  const isUnexpectedSurah = expectedNextSurah > 0 && top.surah !== expectedNextSurah && !isFatihaCandiate;
  const crossSurahPenalty = isUnexpectedSurah
    ? { minScore: 0.50, minMargin: 10, minWins: 2 }
    : { minScore: 0,    minMargin: 0,  minWins: 0 };
  if (displayRacedAhead) {
    console.log(`[Anchor] Display raced ahead — resync in same surah ${lastSurah} (was at :${lastAyah}, found :${top.ayah})`);
  }

  // Bismillah guard: 1:1 ("بسم الله الرحمن الرحيم") is recited before EVERY surah,
  // so matching it doesn't confirm we're in Al-Fatiha. Require 2 consecutive wins
  // (i.e. the NEXT chunk must also land in Fatiha 1:2+) before locking.
  const isBismillahAmbiguous = top.surah === 1 && top.ayah === 1;

  const matchedWordCount = top.matchedWords?.length ?? 0;
  // 2-word minimum in three situations:
  //  1. Very high margin (≥50): gap to #2 is so large a coincidence is impossible
  //  2. Sequential context after surah completion: short ayahs (An-Naziaat style) with 2 wins
  //  3. Otherwise: standard LOCK_MIN_WORDS=3
  const minWords = (margin >= 50)
    ? 2
    : (surahJustCompleted && wins >= 2 && margin >= 10) ? 2
    : LOCK_MIN_WORDS;
  const hasEnoughWords   = matchedWordCount >= minWords;

  // Prefix-ambiguity guard: if ALL matched words of the top candidate also appear in the
  // second candidate, the current transcript cannot distinguish between them yet.
  // Classic case: 3:2 ("الله لا إله إلا هو الحي القيوم") is a strict prefix of 2:255.
  // Until exclusive words like "تأخذه", "سنة", "كرسيه" appear, we can't tell them apart.
  // → disable single-win locks; require 2 consecutive wins (the next chunk will disambiguate).
  const topMatchedWords  = top.matchedWords ?? [];
  const secondMatchedSet = new Set(second?.matchedWords ?? []);
  const topHasExclusiveWord = secondMatchedSet.size === 0
    || topMatchedWords.some(w => !secondMatchedSet.has(w));
  // High-confidence bypass: even without an exclusive word, a very high IDF score (≥0.80)
  // with solid coverage (≥40%) and ≥3 matched words strongly favours the top candidate.
  // At this confidence level the disambiguating word was almost certainly just misheard,
  // and requiring 2 wins would mean waiting another full 10-30s buffer cycle.
  const isHighConfidenceBypass = top.score >= 0.80
    && coverage >= 0.40
    && matchedWordCount >= 3
    && !isBismillahAmbiguous;  // bismillah is always too ambiguous regardless
  // After Fatiha, prefix-ambiguity is expected (short ayahs share words across surahs)
  // and we have no sequential context to disambiguate — rely on margin instead.
  const isPrefixAmbiguous = !topHasExclusiveWord
    && second !== undefined
    && second.score >= 0.30
    && !isHighConfidenceBypass
    && !postFatiha;
  if (isPrefixAmbiguous) {
    console.log(`[Anchor] Prefix-ambiguous: [${top.surah}:${top.ayah}] vs [${second.surah}:${second.ayah}] — top has no exclusive words yet, require 2 wins`);
  } else if (!topHasExclusiveWord && isHighConfidenceBypass) {
    console.log(`[Anchor] High-confidence bypass: [${top.surah}:${top.ayah}] score=${top.score.toFixed(2)} cov=${(coverage*100).toFixed(0)}% — treating as unambiguous`);
  }

  // Fast-lock: unmistakably high confidence
  const isFastLock = top.score >= FAST_LOCK_SCORE && margin >= 30
    && hasEnoughWords
    && (!isUnexpectedSurah || wins >= 2)
    && !isBismillahAmbiguous   // bismillah alone never fast-locks
    && !isPrefixAmbiguous;     // ambiguous prefix never fast-locks

  // Single-win lock: solid score + clear gap to #2 on first chunk
  const isSingleWinLock = top.score >= Math.max(SINGLE_WIN_SCORE, crossSurahPenalty.minScore)
    && margin   >= Math.max(SINGLE_WIN_MARGIN, crossSurahPenalty.minMargin)
    && coverage >= LOCK_COVERAGE_MIN
    && hasEnoughWords
    && wins     >= Math.max(1, crossSurahPenalty.minWins)
    && !isBismillahAmbiguous   // bismillah alone never single-win-locks
    && !isPrefixAmbiguous;     // ambiguous prefix never single-win-locks

  // High-margin lock: very large gap to #2 → no need for 2 wins.
  // With a margin ≥ 50, even 2 matched words are enough — the 50-point gap to #2 makes
  // a coincidental match essentially impossible (e.g. 79:10 "لمردودون في" margin=73.4).
  // After Fatiha (surah 1), relax to 2 words at margin ≥ 25 — the imam picks any surah
  // so we have zero sequential context and need to lock fast on whatever Whisper hears.
  // Ordinary high-margin (25-49) in other contexts still needs LOCK_MIN_WORDS=3.
  const highMarginMinWords = (margin >= 50 || (margin >= 25 && postFatiha)) ? 2 : LOCK_MIN_WORDS;
  const isHighMarginLock = margin >= 25 && top.score >= 0.40 && coverage >= LOCK_COVERAGE_MIN
    && matchedWordCount >= highMarginMinWords
    && !isUnexpectedSurah      // don't allow high-margin cross-surah hop
    && !isBismillahAmbiguous   // bismillah alone never high-margin-locks
    && !isPrefixAmbiguous;     // ambiguous prefix never high-margin-locks

  // Sequential lock: candidate is in the expected next-verse range — only need 1 win
  const isSeqLock = top.seqBoosted
    && (top.rawScore ?? top.score) >= 0.25
    && wins >= 1;

  // Standard ambiguity-aware lock: 2 consecutive wins + clear margin + enough coverage
  // IMPORTANT: require SINGLE_WIN_SCORE here too — two wins on a 0.48 score candidate is
  // not confidence, it's noise repeating. Without this gate, the "No-matches preserves wins"
  // optimisation can bridge a weak candidate across a quiet window to reach wins=2.
  const isConsistentLock = wins >= Math.max(LOCK_WINS_REQUIRED, crossSurahPenalty.minWins)
    && top.score >= SINGLE_WIN_SCORE
    && margin   >= LOCK_MARGIN_MIN
    && coverage >= LOCK_COVERAGE_MIN
    && hasEnoughWords;

  // Sequential-carry lock: 3+ wins accumulated via sequential advancement in the same
  // surah. Each window pointed at the next verse — that's strong directional evidence
  // even if individual margins are low (common words across surahs).
  const isSeqCarryLock = seqAdvance && wins >= 3
    && coverage >= LOCK_COVERAGE_MIN
    && matchedWordCount >= 2
    && !isBismillahAmbiguous;

  // High-score lock: score >= 0.80 with 2+ wins and good coverage is unambiguous
  // even if margin is low (e.g. "بما كانوا يعملون" appears in multiple surahs with
  // similar scores, but 2 consecutive wins at 0.96 is clearly correct).
  // Only require 2 matched words here — short ayahs with high scores are reliable.
  const isHighScoreLock = wins >= LOCK_WINS_REQUIRED
    && top.score >= 0.80
    && coverage >= LOCK_COVERAGE_MIN
    && matchedWordCount >= 2
    && !isBismillahAmbiguous;

  // Same-surah unanimous lock: ALL top candidates are in the same surah we were
  // already tracking.  Classic case: Ar-Rahman "فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ"
  // repeats 31 times → margin is always 0.0, yet we KNOW we are in surah 55.
  // The seqHint boosts the instance closest to our last confirmed position.
  // IMPORTANT: requires lastSurah > 0 — without prior context we can't pick the
  // right instance of a repeated verse (e.g. 55:13 vs 55:75 are identical).
  const allTopSameSurah = matches.slice(0, Math.min(3, matches.length)).every(m => m.surah === top.surah);
  const isSameSurahLock = allTopSameSurah
    && top.surah === lastSurah
    && lastSurah > 0
    && top.score >= SINGLE_WIN_SCORE
    && coverage  >= LOCK_COVERAGE_MIN
    && wins      >= LOCK_WINS_REQUIRED
    && !isBismillahAmbiguous;
  if (isSameSurahLock) {
    console.log(`[Anchor] Same-surah unanimous: all top-3 in ${top.surah}, locking on closest (${top.surah}:${top.ayah})`);
  }

  if (isFastLock || isSingleWinLock || isHighMarginLock || isConsistentLock || isHighScoreLock || isSeqLock || isSeqCarryLock || isSameSurahLock) {
    const reason = isFastLock       ? `fast-lock score=${top.score.toFixed(2)}`
                 : isSingleWinLock  ? `single-win score=${top.score.toFixed(2)} margin=${margin.toFixed(1)}`
                 : isHighMarginLock ? `margin-lock margin=${margin.toFixed(1)} score=${top.score.toFixed(2)}`
                 : isHighScoreLock  ? `high-score-lock wins=${wins} score=${top.score.toFixed(2)}`
                 : isSeqCarryLock   ? `seq-carry-lock wins=${wins} score=${top.score.toFixed(2)}`
                 : isSeqLock        ? `seq-lock wins=${wins} raw=${(top.rawScore??top.score).toFixed(2)}`
                 : isSameSurahLock  ? `same-surah-lock wins=${wins} score=${top.score.toFixed(2)}`
                 : `wins=${wins} margin=${margin.toFixed(1)} cov=${(coverage*100).toFixed(0)}%`;
    console.log(`[Anchor] LOCKED on ${top.surah}:${top.ayah} (${reason})`);
    return {
      ...createState(),
      mode: 'LOCKED',
      surah: top.surah,
      ayah: top.ayah,
      confidence: Math.round(top.score * 100),
      lastKeywords: keywords,
      lastLockedSurah: top.surah,
      lastLockedAyah: top.ayah,
      _matches: matches.slice(0, 3),
      _locked: true,
    };
  }

  console.log(`[Anchor] Pending [${top.surah}:${top.ayah}] wins=${wins}/${LOCK_WINS_REQUIRED} margin=${margin.toFixed(1)}/${LOCK_MARGIN_MIN} cov=${(coverage*100).toFixed(0)}%/${(LOCK_COVERAGE_MIN*100).toFixed(0)}%`);
  return {
    ...state,
    _matches: matches.slice(0, 3),
    _locked: false,
    _wins: wins,
    _pendingMatch: { surah: top.surah, ayah: top.ayah },
    lastKeywords: keywords,
  };
}


function handleLocked(whisperText, state, fastMode = false) {
  const keywords = extractKeywords(whisperText);
  if (keywords.length === 0) {
    const missed = state.missedChunks + 1;
    if (missed >= MISSED_BEFORE_RESUMING) {
      console.log(`[Anchor] Too many misses (${missed}), entering RESUMING`);
      return { ...state, mode: 'RESUMING', missedChunks: 0, _matches: [], _locked: false,
               lastLockedSurah: state.surah, lastLockedAyah: state.ayah };
    }
    return { ...state, missedChunks: missed, _matches: [], _locked: false };
  }

  // Helper: build a uniform advance result
  const makeAdvance = (match, reason) => {
    console.log(`[Anchor] ${reason}: ${state.surah}:${state.ayah} → ${match.surah}:${match.ayah} score=${match.score.toFixed(2)}`);
    return {
      ...state,
      surah: match.surah,
      ayah: match.ayah,
      confidence: Math.round(match.score * 100),
      missedChunks: 0,
      ayahsSinceLock: state.ayahsSinceLock + (match.ayah > state.ayah ? 1 : 0),
      ayahsSinceCheck: match.ayah !== state.ayah ? 0 : state.ayahsSinceCheck + 1,
      lastKeywords: keywords,
      lastLockedSurah: match.surah,
      lastLockedAyah: match.ayah,
      _matches: [{ surah: match.surah, ayah: match.ayah, score: match.score, matchedWords: match.matchedWords }],
      _locked: true,
    };
  };

  // Helper: apply BACK_STEP_CAP — never jump more than 2 ayahs backward per cycle.
  // Forward movement is always applied in full; backward is staged to avoid jarring snaps.
  const applyBack = (match, reason) => {
    if (match.surah !== state.surah || match.ayah >= state.ayah) {
      return makeAdvance(match, reason); // forward or same surah — no cap needed
    }
    const dist = state.ayah - match.ayah;
    if (dist <= BACK_STEP_CAP) {
      return makeAdvance(match, reason);
    }
    // Cap: move back BACK_STEP_CAP ayahs only — next Whisper cycle closes the rest
    const cappedAyah = state.ayah - BACK_STEP_CAP;
    console.log(`[Anchor] Back-cap (dist=${dist}>${BACK_STEP_CAP}): ${state.surah}:${state.ayah} → ${state.surah}:${cappedAyah} (target was :${match.ayah})`);
    return makeAdvance({ ...match, ayah: cappedAyah }, reason + ' (capped)');
  };

  // Fast mode: wider scan window and lower score threshold to keep up with brisk reciters.
  // scanThreshold lowered 0.18→0.14: a 40% Whisper match is enough to confirm position
  // and reset missedChunks — losing lock just because the refrain scored 0.15 is wrong.
  // wideThreshold lowered 0.25→0.18 for the same reason (wide recovery scan).
  const scanRadius    = fastMode ? 8  : 5;
  const scanThreshold = fastMode ? 0.15 : 0.15;
  const wideRadius    = fastMode ? 16 : 12;
  const wideThreshold = fastMode ? 0.20 : 0.20;

  // Back-corrections require stronger evidence than forward/same-position confirmations.
  // A low-score backward match is more likely Whisper hallucination than a real position error.
  const backThreshold = Math.max(scanThreshold, 0.35);

  // 1. Wide scan ±scanRadius from current: finds best match whether forward, current, or backward.
  const wideCheck = spotCheck(whisperText, state.surah, state.ayah, scanRadius);
  if (wideCheck.found && wideCheck.score >= scanThreshold) {
    if (wideCheck.ayah !== state.ayah) {
      const isBack = wideCheck.ayah < state.ayah;
      if (isBack && wideCheck.score < backThreshold) {
        // Weak backward match — treat as same-position confirmation instead of back-correcting
        console.log(`[Anchor] Weak back-match ignored: :${wideCheck.ayah} score=${wideCheck.score.toFixed(2)} < ${backThreshold} — holding :${state.ayah}`);
        return {
          ...state,
          confidence: Math.max(Math.round(wideCheck.score * 100), state.confidence),
          missedChunks: 0,
          lastKeywords: keywords,
          _matches: [{ surah: state.surah, ayah: state.ayah, score: wideCheck.score, matchedWords: wideCheck.matchedWords }],
          _locked: true,
        };
      }
      return applyBack(wideCheck, wideCheck.ayah > state.ayah ? 'Advanced' : 'Back-corrected');
    }
    // Still on same ayah — confirm position, reset missed count
    return {
      ...state,
      confidence: Math.round(wideCheck.score * 100),
      missedChunks: 0,
      ayahsSinceCheck: state.ayahsSinceCheck + 1,
      lastKeywords: keywords,
      _matches: [{ surah: state.surah, ayah: state.ayah, score: wideCheck.score, matchedWords: wideCheck.matchedWords }],
      _locked: true,
    };
  }

  // 2. Wider recovery scan — catches bigger drifts from aggressive auto-advance
  if (state.ayahsSinceCheck >= SPOT_CHECK_INTERVAL || state.missedChunks >= 2) {
    const check = spotCheck(whisperText, state.surah, state.ayah, wideRadius);
    if (check.found && check.score >= wideThreshold) {
      return applyBack(check, 'Wide-scan');
    }
  }

  // 3. Cross-surah detection: spotCheck found nothing in the current surah.
  //    Run a global search — if Whisper clearly hears a DIFFERENT surah, break lock.
  //    BUT: when the lock is well-established (many ayahs tracked), demand a much
  //    higher bar. A single garbage Whisper result should not destroy a stable lock.
  //    Also require at least 1 prior miss — one bad chunk alone is never enough.
  const lockStrength = state.ayahsSinceLock || 0;
  const priorMisses  = state.missedChunks || 0;
  const crossMinScore  = lockStrength >= 5 ? 0.65 : 0.50;
  const crossMinMargin = lockStrength >= 5 ? 30   : 20;
  const crossNeedMiss  = lockStrength >= 3 ? 2    : 1;

  if (priorMisses >= crossNeedMiss) {
    const globalCheck = findAnchor(whisperText, 0, null);
    if (globalCheck.matches.length > 0) {
      const gTop = globalCheck.matches[0];
      const gSecond = globalCheck.matches[1];
      const gMargin = gSecond ? (gTop.score - gSecond.score) * 100 : gTop.score * 100;
      const gMatchedWords = new Set(gTop.matchedWords || []).size;
      // Require at least 3 unique matched words to break lock — a single common
      // word like "جزاءً" should never destroy a stable lock.
      if (gTop.surah !== state.surah && gTop.score >= crossMinScore && gMargin >= crossMinMargin && gMatchedWords >= 3) {
        console.log(`[Anchor] Cross-surah detected: locked on ${state.surah} but Whisper hears ${gTop.surah}:${gTop.ayah} (score=${gTop.score.toFixed(2)}, margin=${gMargin.toFixed(1)}, ${gMatchedWords}uw, lockStrength=${lockStrength}) — breaking lock`);
        return {
          ...state,
          mode: 'SEARCHING',
          missedChunks: 0,
          _matches: [],
          _locked: false,
          _wins: 0,
          _pendingMatch: null,
          lastLockedSurah: state.surah,
          lastLockedAyah: state.ayah,
        };
      }
    }
  }

  // No match — increment missed
  const missed = state.missedChunks + 1;
  if (missed >= MISSED_BEFORE_RESUMING) {
    console.log(`[Anchor] Lost position after ${missed} misses, entering RESUMING`);
    return { ...state, mode: 'RESUMING', missedChunks: 0, _matches: [], _locked: false,
             lastLockedSurah: state.surah, lastLockedAyah: state.ayah };
  }
  return { ...state, missedChunks: missed, _matches: [], _locked: false };
}

function handleResuming(whisperText, state) {
  const lastSurah = state.lastLockedSurah || state.surah;
  const lastAyah  = state.lastLockedAyah  || state.ayah;

  // Try ±10 ayahs from last known position (wider than before).
  // For same-surah re-locks (e.g. Ar-Rahman refrain) use a lower threshold (0.15)
  // because we already KNOW which surah we're in — any reasonable match confirms it.
  const check = spotCheck(whisperText, lastSurah, lastAyah, 10);
  const resumeThreshold = (check.found && check.surah === lastSurah) ? 0.15 : 0.22;
  if (check.found && check.score >= resumeThreshold) {
    console.log(`[Anchor] Resync nearby: ${check.surah}:${check.ayah} score=${check.score.toFixed(2)}`);
    return {
      ...state,
      mode: 'LOCKED',
      surah: check.surah,
      ayah: check.ayah,
      confidence: Math.round(check.score * 100),
      missedChunks: 0,
      ayahsSinceCheck: 0,
      lastLockedSurah: check.surah,
      lastLockedAyah: check.ayah,
      _matches: [{ surah: check.surah, ayah: check.ayah, score: check.score }],
      _locked: true,
    };
  }

  // Try full surah resync — lower threshold to 0.25
  if (lastSurah > 0) {
    const { matches } = resyncInSurah(whisperText, lastSurah);
    if (matches.length > 0 && matches[0].score >= 0.25) {
      const top = matches[0];
      console.log(`[Anchor] Resync surah ${lastSurah}: locked ${top.surah}:${top.ayah} score=${top.score.toFixed(2)}`);
      return {
        ...state,
        mode: 'LOCKED',
        surah: top.surah,
        ayah: top.ayah,
        confidence: Math.round(top.score * 100),
        missedChunks: 0,
        ayahsSinceCheck: 0,
        lastLockedSurah: top.surah,
        lastLockedAyah: top.ayah,
        _matches: matches.slice(0, 3),
        _locked: true,
      };
    }
  }

  // Still lost — go back to SEARCHING but preserve last known surah for seq hint
  const missed = (state.missedChunks || 0) + 1;
  if (missed >= MISSED_BEFORE_LOST) {
    console.log(`[Anchor] Lost — back to SEARCHING (seq hint: ${lastSurah}:${lastAyah})`);
    return {
      ...createState(),
      mode: 'SEARCHING',
      lastLockedSurah: lastSurah,
      lastLockedAyah: lastAyah,
    };
  }
  return { ...state, missedChunks: missed, _matches: [], _locked: false };
}

// ── Simple event transitions (silence, manual controls, non-quran) ──

export function transition(state, event) {
  switch (event.type) {
    case 'RESET':
      return createState();

    case 'SILENCE':
      if (state.mode === 'LOCKED') {
        const missed = (state.missedChunks || 0) + 1;
        if (missed >= MISSED_BEFORE_RESUMING) return { ...state, mode: 'RESUMING', missedChunks: 0 };
        return { ...state, missedChunks: missed };
      }
      return state;

    case 'NON_QURAN':
      return {
        ...state,
        mode: 'PAUSED',
        nonQuranText: event.text,
        nonQuranMeaning: event.meaning,
        nonQuranType: event.speechType,
      };

    case 'AUDIO_RETURN':
      if (state.mode === 'PAUSED') return { ...state, mode: 'RESUMING', missedChunks: 0 };
      return state;

    case 'MANUAL_ADVANCE': {
      if (state.mode !== 'LOCKED') return state;
      const next = getNextAyah(state.surah, state.ayah);
      if (!next) {
        console.log(`[Anchor] End of surah ${state.surah} — back to SEARCHING (clean slate)`);
        return { ...createState(), mode: 'SEARCHING', lastLockedSurah: 0, lastLockedAyah: 0 };
      }
      return { ...state, surah: next.surah, ayah: next.ayah, missedChunks: 0,
               lastLockedSurah: next.surah, lastLockedAyah: next.ayah };
    }

    case 'MANUAL_PREV': {
      if (state.mode !== 'LOCKED') return state;
      const prev = getPrevAyah(state.surah, state.ayah);
      return prev ? { ...state, surah: prev.surah, ayah: prev.ayah, missedChunks: 0,
                      lastLockedSurah: prev.surah, lastLockedAyah: prev.ayah } : state;
    }

    default:
      return state;
  }
}
