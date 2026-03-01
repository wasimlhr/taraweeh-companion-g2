/**
 * AudioPipeline v2 — cumulative pre-lock + cumulative post-lock.
 *
 * SEARCHING (pre-lock):
 *   Accumulates audio into a growing buffer.
 *   Sends to Whisper at increasing windows: 3s → 5s → 10s → 20s → 30s.
 *   Whisper gets more context each attempt — reduces hallucinations on short clips.
 *   After 30s without lock, buffer resets.
 *
 * LOCKED (post-lock):
 *   Accumulates 10-15s chunks (same as SEARCHING) for accurate Whisper context.
 *   Position advances ONLY when Whisper confirms the next ayah — no timer-based auto-advance.
 *   This prevents runaway advancement while the reciter is still on one ayah.
 *
 * Pipeline only processes audio when active (start() called).
 * Buffers drain on stop(), halting Whisper calls immediately.
 */
import { transcribe } from './transcriptionRouter.js';
import { processWhisperResult, transition, createState } from './anchorStateMachine.js';
import { getVerseData } from './verseData.js';
import { probeWhisperEndpoint } from './whisperProvider.js';

const SAMPLE_RATE    = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS   = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

// Pre-lock: try Whisper at these cumulative buffer sizes
const SEARCH_WINDOWS_MS  = [3000, 5000, 10000, 20000, 30000];
const MAX_SEARCH_BUF_MS  = 35000;   // must be > last window (30s) so the 30s window fires before reset

// Post-lock: accumulate audio just like search mode — send longer chunks to Whisper
// so it has enough context to transcribe accurately (3s is too short → garbage output).
// Call Whisper when we have at least LOCKED_MIN_MS of fresh audio.
const LOCKED_MIN_MS    = parseInt(process.env.LOCKED_MIN_MS    || '10000', 10);  // min audio before calling Whisper
const LOCKED_MAX_MS    = parseInt(process.env.LOCKED_MAX_MS    || '15000', 10);  // cap buffer at this (send latest N seconds)
const LOCKED_MIN_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MIN_MS);
const LOCKED_MAX_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MAX_MS);

const SILENCE_THRESHOLD = parseFloat(process.env.SILENCE_THRESHOLD || '0.005');

// ── Reading-timer advance ────────────────────────────────────────────────────
// Primary display driver: once locked, the display advances continuously.
// Two complementary mechanisms:
//
//  1. PAUSE DETECTION (preferred): monitors raw PCM RMS in 250ms windows.
//     When RMS stays below PAUSE_THRESHOLD for PAUSE_ADVANCE_MS ms → inter-ayah
//     pause detected → advance immediately.  Works perfectly for reciters like
//     Sheikh Yunus Aswalus who extend final syllables then pause before the next ayah.
//
//  2. WORD-COUNT TIMER (fallback): if no clear pause is detected within the
//     estimated reading time for the current ayah, advance anyway.
//     This catches reciters with shorter pauses or quiet mics.
//
// Whisper acts as a corrector:
//   • display behind Whisper by 1-5 ayahs  → smooth step-catch-up
//   • display ahead of  Whisper by 2+ ayahs → snap back immediately
//
const READ_ADVANCE_CONFIDENCE  = parseInt(process.env.READ_ADVANCE_CONFIDENCE  || '40',  10);
const READ_WORDS_PER_SEC       = parseFloat(process.env.READ_WORDS_PER_SEC     || '3.5');
const READ_ADVANCE_MIN_MS      = parseInt(process.env.READ_ADVANCE_MIN_MS      || '5000', 10);
const READ_ADVANCE_MAX_MS      = parseInt(process.env.READ_ADVANCE_MAX_MS      || '20000', 10);
const SMOOTH_ADVANCE_MAX_GAP   = parseInt(process.env.SMOOTH_ADVANCE_MAX_GAP   || '5',    10);
const SMOOTH_ADVANCE_STEP_MS   = parseInt(process.env.SMOOTH_ADVANCE_STEP_MS   || '1200', 10);

// ── Pause detection ───────────────────────────────────────────────────────────
// Analyse incoming PCM in PAUSE_ANALYSIS_MS windows.  When consecutive quiet
// windows accumulate PAUSE_ADVANCE_MS ms of silence, fire a pause-advance.
// PAUSE_THRESHOLD should be ≤ SILENCE_THRESHOLD.  PAUSE_COOLDOWN_MS prevents
// double-fires (reciter's breath before very next ayah also triggers silence).
const PAUSE_ANALYSIS_MS   = parseInt(process.env.PAUSE_ANALYSIS_MS   || '250',  10); // analysis window size
const PAUSE_ANALYSIS_BYTES= Math.floor(BYTES_PER_MS * PAUSE_ANALYSIS_MS);
const PAUSE_THRESHOLD     = parseFloat(process.env.PAUSE_THRESHOLD    || '0.005'); // quiet below this → pause
const PAUSE_ADVANCE_MS    = parseInt(process.env.PAUSE_ADVANCE_MS     || '700',  10); // sustained quiet before advancing
const PAUSE_COOLDOWN_MS   = parseInt(process.env.PAUSE_COOLDOWN_MS    || '2500', 10); // min gap between pause-advances

// ── Noise filtering ──────────────────────────────────────────────────────────
const NOISE_WORDS = new Set([
  'موسيقى', 'تبا', 'تباً', 'هممم', 'همم', 'مممم', 'ممم',
  'music', 'applause', 'laughter', 'silence',
  'اشترك', 'للاشتراك',
  'مرحبا', 'مرحباً', 'اهلا', 'أهلاً', 'اهلاً',
  'صباح', 'مساء',
  'شكرا', 'شكراً',
]);
const NOISE_PHRASES = [
  'مرحبا بك', 'مرحباً بك', 'أهلا بك', 'اهلا بك',
  'صباح الخير', 'مساء الخير', 'كيف حالك',
  'شكرا لكم', 'ترجمه لكي', 'توقف عن الاشتراك', 'ماذا يفعلون',
];

// Pre-recitation phrases that Whisper may transcribe but are NOT Quranic verses.
// "أعوذ بالله من الشيطان الرجيم" (isti'adha) and common tasmiyah-only fragments.
// These should be skipped rather than sent to the keyword matcher.
const ISTI_ADHA_PATTERNS = [
  /اعوذ\s+بالله/,       // أعوذ بالله (seeking refuge)
  /أعوذ\s+بالله/,
  /اعوذ\s+ب/,
  /الشيطان\s+الرجيم/,   // الشيطان الرجيم (the accursed Satan)
  /^بسم\s+الله\s+الرحمن\s+الرحيم/,  // bismillah as pre-recitation phrase
];

const AMEEN_RE = /^(آمين|أمين|امين)(\s+(آمين|أمين|امين))*$/;
function isAmeen(text) {
  if (!text) return false;
  return AMEEN_RE.test(text.replace(/[\u064b-\u065f\u0670]/g, '').trim());
}

function isPreRecitationPhrase(text) {
  const stripped = text.replace(/[\u064B-\u065F\u0670]/g, '').trim();
  return ISTI_ADHA_PATTERNS.some(p => p.test(stripped));
}

function computeRms(pcm) {
  const n = Math.floor(pcm.length / 2);  // guard against odd-length buffers
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n * 2; i += 2) s += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(s / n);
}

// Clip guard: normalize loud audio down to prevent Whisper hallucinations.
// G2 mic clean audio: silence ~0.001, recitation ~0.005-0.050.
// Only activates for abnormally loud input (speaker/headphone bleed).
const CLIP_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.10');
const CLIP_TARGET    = parseFloat(process.env.CLIP_TARGET    || '0.04');
const QUIET_BOOST_THRESHOLD = 0.008;  // G2 mic often 0.001–0.002 — HF soundfile fails on near-silence
const QUIET_BOOST_TARGET   = 0.03;   // boost to usable level
function applyClipGuard(pcm, rms) {
  let gain = 1;
  if (rms > 0 && rms < QUIET_BOOST_THRESHOLD) {
    gain = QUIET_BOOST_TARGET / rms;
    console.log(`[Pipeline] G2 quiet boost: rms=${rms.toFixed(4)} → ${QUIET_BOOST_TARGET} (gain=${gain.toFixed(0)})`);
  } else if (rms > CLIP_THRESHOLD) {
    gain = CLIP_TARGET / rms;
    console.log(`[Pipeline] Audio normalize: rms=${rms.toFixed(3)} → ${CLIP_TARGET} (gain=${gain.toFixed(3)})`);
  } else {
    return pcm;
  }
  const out = Buffer.alloc(pcm.length);
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n * 2; i += 2) {
    const s = pcm.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * gain))), i);
  }
  return out;
}


function cleanWhisperText(text) {
  let t = text.replace(/[\[\(].*?[\]\)]/g, '').replace(/^[\[\(]+|[\]\)]+$/g, '').replace(/\s+/g, ' ').trim();
  // Strip common Whisper hallucination prefixes that get prepended to real text
  t = t.replace(/^(شكرا|شكراً|ترجمة[^\s]*)\s*/g, '').trim();
  return t;
}

// Strip bismillah prefix from Whisper output before sending to the matcher.
// "بسم الله الرحمن الرحيم" is recited before every surah — if it appears at the
// start of the transcription followed by actual Quranic text, remove it so the
// matcher only sees the verse content (otherwise bismillah words inflate short-ayah scores).
// Works on the fully normalised (diacritic-free) form so Whisper variants always match.
const QURAN_MARKS_RE    = /[\u064B-\u065F\u0610-\u061A\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0615\u0652\u06D9\uFE70-\uFEFF]/g;
const BISMILLAH_NORM_RE = /^بسم\s+الله\s+الرحمن\s+الرحيم[\s\u06D9\u060C]*/;  // include pause marks after
function stripBismillahPrefix(text) {
  // Normalise: strip all diacritics and Quran marks for reliable matching
  const norm = text.replace(QURAN_MARKS_RE, '').replace(/\s+/g, ' ').trim();
  const match = norm.match(BISMILLAH_NORM_RE);
  if (!match) return norm;                         // return norm (diacritics stripped) — matcher normalises anyway
  const remainder = norm.slice(match[0].length).trim();
  if (remainder.length < 5) return norm;           // nothing left — standalone bismillah handled by isPreRecitationPhrase
  console.log(`[Pipeline] Stripped bismillah prefix → "${remainder.substring(0, 60)}"`);
  return remainder;
}

function isNoise(text) {
  if (!text || text.trim().length < 2) return true;
  const n = text.replace(/[\u064B-\u065F]/g, '').trim();
  if (!/[\u0600-\u06FF]/.test(n)) return true;
  if (/^[a-zA-Z0-9\s.,!?]+$/.test(n)) return true;
  if (/(.)\1{10,}/.test(n)) return true;
  if (NOISE_PHRASES.some(p => n.startsWith(p))) return true;
  const words = n.split(/\s+/);
  if (words.length <= 2 && words.every(w => NOISE_WORDS.has(w))) return true;
  return false;
}

// ── Taraweeh: detect takbeer (Allahu Akbar) cue ──────────────────────────────
// Whisper frequently writes "اللَّهُ الْأَكْبَارُ" (with the definite article "ال" before
// أكبر and an extra alef in "أكبار").  We also need to handle the case where the
// takbeer is followed by Fatiha text in the same window (captured together).
// Strategy: check that the text STARTS WITH "الله" + any variant of أكبر/الأكبر/الأكبار.
// This avoids false-triggering on Quran verses that contain "الله أكبر" mid-sentence
// (e.g. 29:45 "ولذكر الله أكبر" — starts with "ولذكر", not "الله").
const TAKBEER_RE = /^الله\s+(ال)?[اأآ]كبا?ر/u;
function isTakbeer(text) {
  if (!text) return false;
  // Strip all tashkeel + tatweel so variant spellings collapse
  const n = text.replace(/[\u064b-\u065f\u0670\u0640]/g, '').trim();
  return TAKBEER_RE.test(n);
}

// ── AudioPipeline class ───────────────────────────────────────────────────────
export class AudioPipeline {
  constructor({ onStateUpdate, onStatus, onError, preferredSurah = 0, hfToken, whisperOpts }) {
    this.onStateUpdate = onStateUpdate;
    this.onStatus      = onStatus || (() => {});
    this.onError       = onError  || (() => {});
    this.preferredSurah = preferredSurah;
    this.whisperOpts   = whisperOpts || (hfToken ? { apiKey: hfToken } : null);

    this.state     = createState();
    this.active    = false;   // set true only when user presses Start
    this.processing = false;

    // Tracks which surah just completed — shown as "Surah X ✓ done" before next search
    this._completedSurah = 0;

    // Pre-lock cumulative buffer
    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;   // index into SEARCH_WINDOWS_MS
    this._searchGen    = 0;   // incremented on every reset — invalidates stale async callbacks

    // Post-lock sliding window
    this._lockedBuf      = Buffer.alloc(0);
    this._lastTexts      = [];
    this._lastLockedCall = 0;

    // Reading timer — advances display at word-count pace; self-reschedules continuously.
    this._displayAdvanceTimer = null;
    this._nextAdvanceMs = 0;
    this._timerStartedAt = 0;
    // Smooth catch-up timer — steps display forward one ayah at a time.
    this._smoothAdvanceTimer  = null;

    // Throttled audio heartbeat: emit audio:active every 3s while PCM is flowing.
    this._lastAudioStatusMs = 0;
    // Track when we moved to the current ayah — used in linger diagnostics.
    this._ayahStartTime = 0;

    // Pause detection — accumulates incoming PCM in 250ms windows, tracks silence.
    this._pauseAnalysisBuf   = Buffer.alloc(0);
    this._pauseAccumMs       = 0;    // accumulated quiet time in current silence run
    this._lastPauseAdvanceMs = 0;    // timestamp of last pause-triggered advance

    // Fast mode — faster timers, shorter pauses, more aggressive forward tracking
    this.fastMode = false;

    // Adaptive timer penalty: doubles after a back-correction (timer was too fast),
    // resets to 1.0 after a forward advance or confirm (timer is back in sync).
    this._timerPenalty = 1.0;
    this._backCorrectionStreak = 0;
    this._whisperConfirmCount = 0;
    this._sameAyahStreak = 0;  // consecutive Whisper confirmations of the SAME ayah (reciter repeating)
    this._latencyGapStreak = 0; // consecutive gap=-2 reports (timer running away)

    // Whisper reference clock: measures the reciter's actual pace by tracking how many
    // words Whisper confirmed over what time span.  _measuredWps starts at the default
    // and is updated every time Whisper confirms a new ayah position.
    this._measuredWps            = READ_WORDS_PER_SEC;
    this._whisperLastConfirmMs   = 0;     // timestamp of last Whisper position confirm
    this._whisperLastConfirmAyah = 0;     // ayah number at that timestamp
    this._whisperLastConfirmSurah = 0;    // surah at that timestamp

    // Pace tracking: rolling window of recent WPS samples for trend detection
    this._paceHistory    = [];
    this._paceCategory   = '';
    this._paceTrend      = 0;
    this._lastPaceEmitMs = 0;

    // Taraweeh mode — tracks prayer positions, detects Allahu Akbar transitions
    this.taraweehMode    = false;
    this._taraweehPos    = 'QIYAM'; // 'QIYAM' | 'RUKU'
    this._rakatCount     = 0;
    // Remember where we were before ruku so we can resume after Fatiha
    this._preRukuSurah   = 0;
    this._preRukuAyah    = 0;

    // Proactive model health check — fires immediately so frontend knows what's going on
    probeWhisperEndpoint(this.whisperOpts, this.onStatus).catch(() => {});
  }

  /** Toggle fast mode — speeds up reading timer and pause detection */
  setFastMode(enabled) {
    this.fastMode = !!enabled;
    console.log(`[Pipeline] Fast mode ${this.fastMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'fast_mode', enabled: this.fastMode });
  }

  /** Toggle taraweeh mode */
  setTaraweehMode(enabled) {
    this.taraweehMode = !!enabled;
    if (!this.taraweehMode) { this._taraweehPos = 'QIYAM'; this._rakatCount = 0; }
    console.log(`[Pipeline] Taraweeh mode ${this.taraweehMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'taraweeh_mode', enabled: this.taraweehMode,
      position: this._taraweehPos, rakat: this._rakatCount });
  }

  /** Reset rakat counter (e.g. at start of salah) */
  resetRakat() {
    this._rakatCount = 0;
    this._taraweehPos = 'QIYAM';
    this._emitTaraweeh();
  }

  _emitTaraweeh() {
    this.onStateUpdate({
      type: 'taraweeh',
      position: this._taraweehPos,
      rakat: this._rakatCount,
    });
  }

  // After Fatiha ends in Taraweeh, restore the pre-ruku surah/ayah so the anchor
  // machine searches the right surah instead of doing a blind global search.
  _restorePreRukuIfNeeded(completedSurah) {
    if (this.taraweehMode && completedSurah === 1
        && this._preRukuSurah > 1) {
      this.state.lastLockedSurah = this._preRukuSurah;
      this.state.lastLockedAyah  = this._preRukuAyah;
      console.log(`[Pipeline] Taraweeh: Fatiha done → resuming from ${this._preRukuSurah}:${this._preRukuAyah}`);
    }
  }

  /** Called when user presses Start — enables processing */
  start() {
    if (this.active) {
      console.log('[Pipeline] Already active — ignoring duplicate start');
      return;
    }
    this._cancelReadAdvance();
    this.active = true;
    this.state  = createState();
    this._preRecitSkips = 0;
    this._resetSearchBuf();
    console.log('[Pipeline] Started');
  }

  /** Called when user presses Stop — halts processing, clears buffers */
  stop() {
    this.active = false;
    this._resetSearchBuf();
    this._lockedBuf          = Buffer.alloc(0);
    this._lastLockedCall     = 0;
    this._pauseAnalysisBuf   = Buffer.alloc(0);
    this._pauseAccumMs       = 0;
    this._cancelReadAdvance();
    this.state = createState();
    this._emitState(null, null);
    console.log('[Pipeline] Stopped');
  }

  /** Receive raw PCM from WebSocket */
  ingest(pcmData) {
    if (!this.active) return;   // ignore audio when not started

    // Throttled audio heartbeat: keep UI audio pill live between chunk cycles.
    // Fires every 3s regardless of whether we're in SEARCHING or LOCKED.
    const now = Date.now();
    if (now - this._lastAudioStatusMs >= 3000) {
      this._lastAudioStatusMs = now;
      const rms = computeRms(pcmData);
      console.log(`[Pipeline] Audio: rms=${rms.toFixed(4)} mode=${this.state.mode}`);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });
    }

    // ── Pause detection ───────────────────────────────────────────────────────
    // Only active while the word-count timer is running (LOCKED, not mid smooth-catch-up).
    // Accumulates incoming PCM into 250ms analysis windows.  When consecutive quiet
    // windows total PAUSE_ADVANCE_MS ms, fire an advance (reciter's inter-ayah breath).
    if (this.state.mode === 'LOCKED' && this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
      this._pauseAnalysisBuf = Buffer.concat([this._pauseAnalysisBuf, pcmData]);
      if (this._pauseAnalysisBuf.length >= PAUSE_ANALYSIS_BYTES) {
        const pauseRms = computeRms(this._pauseAnalysisBuf);
        this._pauseAnalysisBuf = Buffer.alloc(0);
        if (pauseRms < PAUSE_THRESHOLD) {
          this._pauseAccumMs += PAUSE_ANALYSIS_MS;
          const pauseTarget   = PAUSE_ADVANCE_MS;
          const pauseCooldown = PAUSE_COOLDOWN_MS;
          if (this._pauseAccumMs >= pauseTarget &&
              (now - this._lastPauseAdvanceMs) >= pauseCooldown) {
            this._pauseAccumMs = 0;
            this._triggerPauseAdvance();
          }
        } else {
          this._pauseAccumMs = 0; // audio active — reset accumulator
        }
      }
    } else {
      // Not in pause-detection mode — drain buffer to avoid stale data on re-entry
      if (this._pauseAnalysisBuf.length > 0) this._pauseAnalysisBuf = Buffer.alloc(0);
      this._pauseAccumMs = 0;
    }

    if (this.state.mode === 'LOCKED') {
      const minBytes = LOCKED_MIN_BYTES;
      const maxBytes = LOCKED_MAX_BYTES;
      this._lockedBuf = Buffer.concat([this._lockedBuf, pcmData]);

      if (this._lockedBuf.length > maxBytes) {
        this._lockedBuf = this._lockedBuf.subarray(this._lockedBuf.length - maxBytes);
      }

      if (this._lockedBuf.length >= minBytes && !this.processing) {
        const chunk = Buffer.from(this._lockedBuf);
        this._lockedBuf = Buffer.alloc(0);   // reset — start fresh accumulation
        this._lastLockedCall = Date.now();
        this._processLockedChunk(chunk);
      }
    } else {
      // Pre-lock: cumulative buffer — grows until we reach next window threshold
      this._searchBuf = Buffer.concat([this._searchBuf, pcmData]);
      const bufMs = this._searchBuf.length / BYTES_PER_MS;

      if (bufMs >= MAX_SEARCH_BUF_MS) {
        // Buffer full — reset and start fresh (reciter probably paused)
        console.log('[Pipeline] Search buffer full (30s) — resetting');
        this._resetSearchBuf();
        this.onStatus({ component: 'search', status: 'reset', message: 'Buffer reset — resume reciting' });
        return;
      }

      const targetMs = SEARCH_WINDOWS_MS[this._searchWinIdx];
      if (bufMs >= targetMs && !this.processing) {
        this._processSearchChunk();
      }
    }
  }

  _resetSearchBuf() {
    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;
    this.processing    = false;
    this._searchGen    = (this._searchGen || 0) + 1;  // invalidate any in-flight async
  }

  // ── Pre-lock: send cumulative buffer to Whisper ───────────────────────────
  async _processSearchChunk() {
    this.processing = true;
    const myGen = this._searchGen;   // capture generation — if this changes we are stale
    const bufMs = Math.round(this._searchBuf.length / BYTES_PER_MS);

    // Helper: bail out if this call was invalidated by a buffer reset or pipeline stopped
    const stale = () => this._searchGen !== myGen || !this.active;

    try {
      const rms = computeRms(this._searchBuf);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });

      if (rms < SILENCE_THRESHOLD) {
        console.log(`[Pipeline] Search silent (${bufMs}ms, rms=${rms.toFixed(4)})`);
        if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
        return;
      }

      console.log(`[Pipeline] Search ${bufMs}ms rms=${rms.toFixed(3)}, window=${this._searchWinIdx + 1}/${SEARCH_WINDOWS_MS.length}`);
      this.onStatus({ component: 'search', status: 'transcribing', audioSec: bufMs / 1000, window: this._searchWinIdx + 1 });

      let text = '';
      try {
        const audioToSend = applyClipGuard(this._searchBuf, rms);
        const result = await transcribe(audioToSend, this.whisperOpts, this.onStatus);
        text = result.text || '';
        if (stale()) { console.log('[Pipeline] Stale search result discarded'); return; }
        console.log(`[Pipeline] Whisper (${bufMs}ms): "${text.substring(0, 80)}"`);
      } catch (err) {
        console.error('[Pipeline] Transcription error:', err.message?.substring(0, 100));
        this.onError(err.message);
        if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
        return;
      }

      const cleaned = stripBismillahPrefix(cleanWhisperText(text.trim()));

      // Taraweeh mode: takbeer signals a prayer-position transition
      if (this.taraweehMode && isTakbeer(cleaned)) {
        console.log(`[Pipeline] Taraweeh takbeer detected (pos=${this._taraweehPos})`);
        if (!stale()) {
          if (this._taraweehPos === 'QIYAM') {
            // Going into ruku — save position so we can resume after Fatiha
            if (this.state.lastLockedSurah > 1) {
              this._preRukuSurah = this.state.lastLockedSurah;
              this._preRukuAyah  = this.state.lastLockedAyah;
              console.log(`[Pipeline] Saved pre-ruku position: ${this._preRukuSurah}:${this._preRukuAyah}`);
            }
            this._taraweehPos = 'RUKU';
            this._rakatCount++;
            this._cancelReadAdvance();
            this.state = createState();
            this._resetSearchBuf();
          } else {
            // Coming back up from ruku — ready to recite again
            this._taraweehPos = 'QIYAM';
            this._resetSearchBuf();
          }
          this._emitTaraweeh();
          this.processing = false;
        }
        return;
      }

      if (!cleaned || isNoise(cleaned)) {
        console.log(`[Pipeline] Noise/empty at ${bufMs}ms: "${cleaned}" — advancing window`);
        this.onStatus({ component: 'search', status: 'noise', audioSec: bufMs / 1000 });
        if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
        return;
      }

      // Ameen detection — show on screen in Taraweeh mode, skip otherwise
      if (isAmeen(cleaned)) {
        if (this.taraweehMode) {
          console.log(`[Pipeline] Ameen detected — displaying`);
          this.onStateUpdate({ type: 'ameen' });
        } else {
          console.log(`[Pipeline] Ameen — skipping (not taraweeh)`);
        }
        this.onStatus({ component: 'search', status: 'noise', audioSec: bufMs / 1000 });
        if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
        return;
      }

      if (isPreRecitationPhrase(cleaned)) {
        this._preRecitSkips = (this._preRecitSkips || 0) + 1;
        if (this._preRecitSkips <= 2) {
          console.log(`[Pipeline] Pre-recitation phrase — skipping (${this._preRecitSkips}): "${cleaned}"`);
          this.onStatus({ component: 'search', status: 'noise', audioSec: bufMs / 1000 });
          if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
          return;
        }
        console.log(`[Pipeline] Pre-recitation phrase repeated ${this._preRecitSkips}× — letting through to matcher`);
      } else {
        this._preRecitSkips = 0;
      }

      // Run through anchor state machine
      this.state = processWhisperResult(cleaned, this.state, { preferredSurah: this.preferredSurah, fastMode: this.fastMode });

      // Emit match progress for UI (even if not yet locked)
      this._emitMatchProgress(text, rms, bufMs);

      if (this.state.mode === 'LOCKED') {
        console.log(`[Pipeline] LOCKED on ${this.state.surah}:${this.state.ayah} after ${bufMs}ms`);
        this._resetSearchBuf();   // clear cumulative buffer after lock (bumps gen)
        this._lastLockedCall = 0; // allow first locked Whisper call immediately
        this._lockedBuf = Buffer.alloc(0);
        this._ayahStartTime = Date.now();
        // Reset Whisper reference clock for this lock session
        this._measuredWps            = READ_WORDS_PER_SEC;
        this._whisperLastConfirmMs   = Date.now();
        this._whisperLastConfirmAyah = this.state.ayah;
        this._whisperLastConfirmSurah = this.state.surah;
        this._timerPenalty           = 1.0;
        this._backCorrectionStreak = 0;
        this._whisperConfirmCount = 0;
        this._sameAyahStreak = 0;
        this._latencyGapStreak = 0;
        this._scheduleReadAdvance(this.state.confidence); // start reading timer for initial lock
        this._emitState(text, rms);
        return;  // processing already cleared by _resetSearchBuf
      } else {
        // Not locked yet — emit state so UI can show candidate if score >= 40%
        if (!stale()) this._emitState(text, rms);
        // Advance to next window
        if (!stale()) this._advanceSearchWindow();
      }
    } catch (err) {
      console.error('[Pipeline] Search error:', err.message);
      this.onError(err.message);
      if (!stale()) this._advanceSearchWindow();
    }

    if (!stale()) {
      this.processing = false;
      // If the buffer already has enough audio for the next window, schedule
      // processing on the next tick (setTimeout 0) rather than calling directly.
      // Direct recursion here caused a stack overflow when errors repeated rapidly.
      const bufMs2 = this._searchBuf.length / BYTES_PER_MS;
      const nextTarget = SEARCH_WINDOWS_MS[this._searchWinIdx];
      if (nextTarget && bufMs2 >= nextTarget && this.state.mode !== 'LOCKED') {
        setTimeout(() => {
          if (!this.processing && this.state.mode !== 'LOCKED' && this.active) {
            this._processSearchChunk();
          }
        }, 0);
      }
    }
  }

  _advanceSearchWindow() {
    if (this._searchWinIdx >= SEARCH_WINDOWS_MS.length - 1) {
      console.log('[Pipeline] All search windows exhausted — resetting');
      this._resetSearchBuf();
      this.onStatus({ component: 'search', status: 'reset', message: 'No match — resume reciting' });
      return;
    }
    this._searchWinIdx++;
  }

  // ── Post-lock: long-window Whisper call (same quality as initial search) ────
  async _processLockedChunk(chunk) {
    this.processing = true;
    try {
      const rms = computeRms(chunk);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });

      if (rms < SILENCE_THRESHOLD) {
        const newState = transition(this.state, { type: 'SILENCE' });
        if (newState.mode !== this.state.mode) {
          this.state = newState;
          this._emitState(null, rms);
        }
        this.processing = false;
        return;
      }

      const chunkMs = Math.round(chunk.length / BYTES_PER_MS);
      console.log(`[Pipeline] Locked check ${chunkMs}ms rms=${rms.toFixed(3)}, ayah=${this.state.surah}:${this.state.ayah}`);

      let text = '';
      try {
        const audioToSend = applyClipGuard(chunk, rms);
        const result = await transcribe(audioToSend, this.whisperOpts, this.onStatus);
        text = result.text || '';
      } catch (err) {
        console.error('[Pipeline] Transcription error:', err.message?.substring(0, 100));
        this.processing = false;
        return;
      }

      if (!this.active || this.state.mode !== 'LOCKED') {
        console.log('[Pipeline] Stale locked-check result discarded');
        this.processing = false;
        return;
      }

      const cleaned = stripBismillahPrefix(cleanWhisperText(text.trim()));

      // Taraweeh mode: takbeer while locked = going into ruku
      if (this.taraweehMode && isTakbeer(cleaned)) {
        // Save current position — this is where we'll resume after Fatiha
        if (this.state.surah > 1) {
          this._preRukuSurah = this.state.surah;
          this._preRukuAyah  = this.state.ayah;
        }
        console.log(`[Pipeline] Taraweeh takbeer (LOCKED→RUKU) saved=${this._preRukuSurah}:${this._preRukuAyah}`);
        this._taraweehPos = 'RUKU';
        this._rakatCount++;
        this._cancelReadAdvance();
        this.state = createState();
        this._resetSearchBuf();
        this._emitTaraweeh();
        this.processing = false;
        return;
      }

      if (!cleaned || isNoise(cleaned)) {
        this.processing = false;
        return;
      }

      // Ameen while locked — show on screen, don't process as verse
      if (isAmeen(cleaned)) {
        if (this.taraweehMode) {
          console.log(`[Pipeline] Ameen detected (LOCKED)`);
          this.onStateUpdate({ type: 'ameen' });
        }
        this.processing = false;
        return;
      }

      // Hallucination guard: same text 3x → skip
      this._lastTexts.push(cleaned);
      if (this._lastTexts.length > 3) this._lastTexts.shift();
      if (this._lastTexts.length >= 3 && this._lastTexts.every(t => t === cleaned)) {
        console.log(`[Pipeline] Repeated hallucination — skipping`);
        this.processing = false;
        return;
      }

      // DON'T cancel timer upfront — only cancel in paths that change position.
      // Cancelling here was resetting the countdown every Whisper cycle (~10s),
      // preventing the timer from ever firing when Whisper confirms the same ayah.

      const displaySurah = this.state.surah, displayAyah = this.state.ayah;
      const prevMissed = this.state.missedChunks || 0;
      this.state = processWhisperResult(cleaned, this.state, { preferredSurah: this.preferredSurah, fastMode: this.fastMode });

      if (this.state.mode !== 'LOCKED') {
        console.log('[Pipeline] Lost lock — back to searching');
        this._cancelReadAdvance();
        this._timerPenalty = 1.0;
        this._measuredWps  = READ_WORDS_PER_SEC;
        this._whisperLastConfirmMs = 0;
        this._resetSearchBuf();
        this._emitState(text, rms);
      } else if (this.state.surah !== displaySurah && this.state.surah !== 0) {
        console.log(`[Pipeline] Surah mismatch: display=${displaySurah} whisper=${this.state.surah} — releasing lock to re-search`);
        this._cancelReadAdvance();
        this._timerPenalty = 1.0;
        this._measuredWps = READ_WORDS_PER_SEC;
        this._resetSearchBuf();
        this.state = createState();
        this._emitState(text, rms);
        this.processing = false;
        return;
      } else {
        const confirmedSurah = this.state.surah, confirmedAyah = this.state.ayah;
        const sameSurah = confirmedSurah === displaySurah;
        const gap       = sameSurah ? confirmedAyah - displayAyah : 0;

        // ── Whisper reference clock: measure reciter's actual pace ──────────
        // Every time Whisper confirms a NEW ayah in the same surah, compute
        // how many words the reciter covered since the last confirmation, and
        // how long it took.  This gives us real words-per-second for this reciter.
        const now = Date.now();
        if (sameSurah && confirmedAyah !== this._whisperLastConfirmAyah
            && this._whisperLastConfirmMs > 0
            && this._whisperLastConfirmSurah === confirmedSurah) {
          const elapsedMs = now - this._whisperLastConfirmMs;
          if (elapsedMs > 2000) {
            // Count total Arabic words between the two confirmed positions
            const fromAyah = Math.min(this._whisperLastConfirmAyah, confirmedAyah);
            const toAyah   = Math.max(this._whisperLastConfirmAyah, confirmedAyah);
            let totalWords = 0;
            for (let a = fromAyah; a <= toAyah; a++) {
              const v = getVerseData(confirmedSurah, a);
              totalWords += v?.transliteration
                ? v.transliteration.split(/\s+/).length
                : (v?.arabic ? v.arabic.split(/\s+/).length : 4);
            }
            const rawWps = totalWords / (elapsedMs / 1000);
            // Aggressive EMA: 40% old + 60% new — converges within 1-2 cycles.
            // The old 70/30 split took 4-5 cycles (~50s) to converge, causing the
            // timer to race ahead for the first minute of every lock session.
            // Clamp to [0.5, 5.0] to prevent extreme outliers.
            const clampedWps = Math.max(0.5, Math.min(5.0, rawWps));
            this._measuredWps = this._measuredWps * 0.4 + clampedWps * 0.6;
            console.log(`[Pipeline] Whisper clock: ${totalWords}w in ${(elapsedMs/1000).toFixed(1)}s = ${rawWps.toFixed(2)} wps → measured=${this._measuredWps.toFixed(2)} wps`);
            this._updatePace(clampedWps, now);
          }
        }
        if (sameSurah && confirmedAyah !== this._whisperLastConfirmAyah) {
          this._whisperLastConfirmMs    = now;
          this._whisperLastConfirmAyah  = confirmedAyah;
          this._whisperLastConfirmSurah = confirmedSurah;
        }

        if (sameSurah && gap > 1) {
          // Display is BEHIND Whisper. Always smooth-step — never snap forward.
          this._cancelReadAdvance();
          const stepMs = gap <= 3 ? SMOOTH_ADVANCE_STEP_MS
                       : gap <= 6 ? Math.round(SMOOTH_ADVANCE_STEP_MS * 0.60)
                       :             Math.round(SMOOTH_ADVANCE_STEP_MS * 0.35);
          this._backCorrectionStreak = 0;
          this._sameAyahStreak = 0;
          this._latencyGapStreak = 0;
          this._whisperConfirmCount++;
          console.log(`[Pipeline] Smooth catch-up: ${displaySurah}:${displayAyah} → ${confirmedSurah}:${confirmedAyah} (${gap} steps, ${stepMs}ms/step)`);
          this.state = { ...this.state, surah: displaySurah, ayah: displayAyah };
          this._emitState(text, rms);
          this._smoothAdvanceTimer = setTimeout(
            () => this._smoothAdvanceTo(confirmedSurah, confirmedAyah, stepMs),
            stepMs
          );
        } else {
          // Snap back if display was AHEAD of Whisper, or same ayah, or different surah.
          // Whisper latency offset: Whisper reports the midpoint of a ~10s chunk, so by
          // the time we process the result the reciter is ~1 ayah ahead.  When the gap
          // is only -1 or -2, don't snap back — the display is likely correct or close.
          // Only apply real back-correction for gap <= -3 (timer genuinely raced ahead).
          const moved = confirmedSurah !== displaySurah || confirmedAyah !== displayAyah;
          if (gap === -1 && sameSurah) {
            // gap=-1: normal Whisper latency. Timer is fine, don't touch it.
            this.state = { ...this.state, surah: displaySurah, ayah: displayAyah };
            this._latencyGapStreak = 0;
            console.log(`[Pipeline] Whisper latency (gap=-1): keeping ${displaySurah}:${displayAyah}, timer undisturbed`);
            if (!this._displayAdvanceTimer) {
              const keepConf = Math.max(this.state.confidence, READ_ADVANCE_CONFIDENCE);
              this._scheduleReadAdvance(keepConf);
            }
          } else if (gap === -2 && sameSurah) {
            // gap=-2: borderline. If it keeps happening, slow down.
            this._latencyGapStreak++;
            if (this._latencyGapStreak >= 3) {
              // Persistent gap=-2 → snap back to Whisper+1, mild penalty
              this._cancelReadAdvance();
              const snapAyah = Math.min(confirmedAyah + 1, displayAyah);
              this.state = { ...this.state, surah: confirmedSurah, ayah: snapAyah };
              this._timerPenalty = 1.3;
              this._latencyGapStreak = 0;
              console.log(`[Pipeline] Latency realign: ${displaySurah}:${displayAyah} → ${confirmedSurah}:${snapAyah} (streak=3)`);
              this._ayahStartTime = Date.now();
              this._emitState(text, rms);
              const keepConf = Math.max(this.state.confidence, READ_ADVANCE_CONFIDENCE);
              this._scheduleReadAdvance(keepConf);
            } else {
              this.state = { ...this.state, surah: displaySurah, ayah: displayAyah };
              console.log(`[Pipeline] Whisper latency (gap=-2, streak=${this._latencyGapStreak}): keeping ${displaySurah}:${displayAyah}, timer undisturbed`);
              if (!this._displayAdvanceTimer) {
                const keepConf = Math.max(this.state.confidence, READ_ADVANCE_CONFIDENCE);
                this._scheduleReadAdvance(keepConf);
              }
            }
          } else if (gap < 0) {
            // Large gap (3+ ayahs with back-cap=4): timer genuinely raced ahead.
            // Snap to Whisper + 1 (latency offset) and keep timer running slowly.
            this._cancelReadAdvance();
            const snapAyah = Math.min(confirmedAyah + 1, displayAyah);
            this.state = { ...this.state, surah: confirmedSurah, ayah: snapAyah };
            this._timerPenalty = 1.5;
            this._sameAyahStreak = 0;
            this._latencyGapStreak = 0;
            console.log(`[Pipeline] Realign: ${displaySurah}:${displayAyah} → ${confirmedSurah}:${snapAyah} (gap=${gap})`);
            this._ayahStartTime = Date.now();
            this._emitState(text, rms);
            const keepConf = Math.max(this.state.confidence, READ_ADVANCE_CONFIDENCE);
            this._scheduleReadAdvance(keepConf);
          } else {
            // Forward advance or confirm — timer was right, reset penalty
            this._backCorrectionStreak = 0;
            this._latencyGapStreak = 0;
            this._whisperConfirmCount++;
            this._timerPenalty = 1.0;
            if (moved) {
              this._sameAyahStreak = 0;
              this._cancelReadAdvance();
              this._ayahStartTime = Date.now();
              this._emitState(text, rms);
              this._scheduleReadAdvance(this.state.confidence);
            } else {
              // Same ayah — only count as "reciter repeating" if the CURRENT match
              // scored well. The anchor updates state.confidence to the current score.
              // Require >= 55% to count: Ar-Rahman's refrain can false-match at 40-50%.
              if (this.state.confidence >= 55) {
                this._sameAyahStreak++;
                if (this._sameAyahStreak >= 2) {
                  this._cancelReadAdvance();
                  console.log(`[Pipeline] Reciter repeating ${displaySurah}:${displayAyah} (${this._sameAyahStreak}× confirmed, conf=${this.state.confidence}%) — holding timer`);
                }
              } else {
                console.log(`[Pipeline] Same ayah ${displaySurah}:${displayAyah} but low conf=${this.state.confidence}% — not counting as repeat`);
              }
              this._emitState(text, rms);
              if (!this._displayAdvanceTimer) {
                // If confidence tanked from garbage Whisper, don't let the timer
                // fall into the 15s fallback — use at least READ_ADVANCE_CONFIDENCE
                // so the normal word-based duration applies.
                const timerConf = Math.max(this.state.confidence, READ_ADVANCE_CONFIDENCE);
                this._scheduleReadAdvance(timerConf);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[Pipeline] Locked chunk error:', err.message);
    }
    this.processing = false;
  }

  // ── Emit helpers ─────────────────────────────────────────────────────────
  _emitMatchProgress(whisperText, rms, bufMs) {
    const matches = (this.state._matches || []).slice(0, 3);
    const top    = matches[0];
    const second = matches[1];
    const margin = top && second ? Math.round((top.score - second.score) * 100) : (top ? Math.round(top.score * 100) : 0);

    const candidates = matches.map(m => ({
      surah: m.surah, ayah: m.ayah,
      score: Math.round(m.score * 100),
      arabic: m.arabic?.substring(0, 60),
    }));

    this.onStateUpdate({
      type: 'match_progress',
      audioSec: Math.round(bufMs / 100) / 10,
      whisperText,
      candidates,
      lockProgress: {
        wins: this.state._wins || 0,
        winsRequired: 2,
        margin,
        coverage: top ? Math.round((top.coverage || 0) * 100) : 0,
        pendingMatch: this.state._pendingMatch,
      },
    });
  }

  _emitState(whisperText, rms) {
    const isDisplayable = this.state.mode === 'LOCKED' || this.state.mode === 'PAUSED' || this.state.mode === 'RESUMING';

    // In SEARCHING, show the top candidate if score >= 0.40 AND margin >= 5
    // Margin guard prevents briefly showing a wrong verse when top-2 scores are nearly tied
    const topMatch    = this.state._matches?.[0];
    const secondMatch = this.state._matches?.[1];
    const topScore    = topMatch?.score ?? 0;
    const topMargin   = secondMatch ? Math.round((topScore - secondMatch.score) * 100) : 100;
    const SHOW_THRESHOLD = 0.35;  // lowered for IDF-dominant scoring
    const SHOW_MARGIN    = 5;     // must lead #2 by at least 5 points
    const isCandidate = !isDisplayable && this.state.mode === 'SEARCHING'
      && topScore >= SHOW_THRESHOLD
      && topMargin >= SHOW_MARGIN;

    const verseSource = isDisplayable ? this.state : (isCandidate ? topMatch : null);
    const lockedVerse = verseSource
      ? getVerseData(verseSource.surah ?? verseSource.surah, verseSource.ayah ?? verseSource.ayah)
      : null;

    if (this.state.mode === 'LOCKED') {
      console.log(`[Emit] LOCKED ${this.state.surah}:${this.state.ayah} "${(lockedVerse?.translation || '').substring(0, 50)}"`);
      this._completedSurah = 0;  // new lock clears the completion banner
    } else if (isCandidate) {
      console.log(`[Emit] CANDIDATE ${topMatch.surah}:${topMatch.ayah} score=${topScore.toFixed(2)} "${(lockedVerse?.translation || '').substring(0, 50)}"`);
    }

    const candidates = (this.state._matches || []).map(m => ({
      surah: m.surah, ayah: m.ayah, score: +(m.score || 0).toFixed(3),
      arabic: m.arabic?.substring(0, 60),
      matchedWords: m.matchedWords || [],
    }));

    // Send remaining timer duration so the frontend countdown matches exactly
    const timerMs = (this._displayAdvanceTimer && this._timerStartedAt)
      ? Math.max(0, (this._nextAdvanceMs || 0) - (Date.now() - this._timerStartedAt))
      : 0;

    this.onStateUpdate({
      type: 'state',
      state: {
        mode: this.state.mode,
        surah: lockedVerse?.surah ?? this.state.surah,
        ayah:  lockedVerse?.ayah  ?? this.state.ayah,
        surahName:      lockedVerse?.surahName,
        ayahTotal:      lockedVerse?.ayahTotal,
        arabic:         lockedVerse?.arabic,
        transliteration: lockedVerse?.transliteration,
        translation:    lockedVerse?.translation,
        confidence: this.state.confidence <= 1
          ? this.state.confidence
          : (this.state.confidence || 0) / 100,
        timerMs: timerMs || undefined,
        isCandidate:     isCandidate || false,
        candidateScore:  isCandidate ? Math.round(topScore * 100) : undefined,
        candidateMargin: isCandidate ? topMargin : undefined,
        completedSurah:     this._completedSurah || undefined,
        completedSurahName: this._completedSurah
          ? (getVerseData(this._completedSurah, 1)?.surahName ?? `Surah ${this._completedSurah}`)
          : undefined,
        nonQuranText:    this.state.nonQuranText,
        nonQuranMeaning: this.state.nonQuranMeaning,
        nonQuranType:    this.state.nonQuranType,
        pace: this._paceCategory ? {
          wps: +this._measuredWps.toFixed(2),
          category: this._paceCategory,
          trend: this._paceTrend > 0 ? 'accelerating' : this._paceTrend < 0 ? 'decelerating' : 'steady',
        } : undefined,
      },
      whisperText: whisperText ?? null,
      rms: rms != null ? +rms.toFixed(4) : null,
      candidates: candidates.length > 0 ? candidates : undefined,
    });
  }

  _updatePace(rawWps, now) {
    this._paceHistory.push({ wps: rawWps, ts: now });
    if (this._paceHistory.length > 8) this._paceHistory.shift();

    const wps = this._measuredWps;
    const cat = wps < 1.0 ? 'slow' : wps < 2.0 ? 'normal' : wps < 3.0 ? 'fast' : 'very-fast';

    let trend = 0;
    if (this._paceHistory.length >= 4) {
      const mid = Math.floor(this._paceHistory.length / 2);
      const firstHalf  = this._paceHistory.slice(0, mid);
      const secondHalf = this._paceHistory.slice(mid);
      const avgFirst  = firstHalf.reduce((s, p) => s + p.wps, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, p) => s + p.wps, 0) / secondHalf.length;
      const delta = avgSecond - avgFirst;
      if (delta > 0.3)       trend = 1;
      else if (delta < -0.3) trend = -1;
    }

    const changed = cat !== this._paceCategory || trend !== this._paceTrend;
    this._paceCategory = cat;
    this._paceTrend    = trend;

    if (now - this._lastPaceEmitMs >= 3000 || changed) {
      this._lastPaceEmitMs = now;
      const trendLabel = trend > 0 ? 'accelerating' : trend < 0 ? 'decelerating' : 'steady';
      console.log(`[Pipeline] Pace: ${wps.toFixed(2)} wps [${cat}] trend=${trendLabel} (${this._paceHistory.length} samples)`);
      this.onStateUpdate({
        type: 'pace',
        wps: +wps.toFixed(2),
        category: cat,
        trend: trendLabel,
        samples: this._paceHistory.length,
      });
    }
  }

  // ── Pause-triggered advance ───────────────────────────────────────────────
  // Fires when inter-ayah silence is detected in the raw PCM stream.
  // Cancels the word-count timer (no longer needed) and advances immediately.
  _triggerPauseAdvance() {
    if (this.state.mode !== 'LOCKED') return;
    this._lastPauseAdvanceMs = Date.now();
    const from = `${this.state.surah}:${this.state.ayah}`;
    this._cancelReadAdvance();   // kill word-count timer — pause beat us to it
    const prevSurah = this.state.surah;
    this.state = transition(this.state, { type: 'MANUAL_ADVANCE' });
    this._ayahStartTime = Date.now();
    if (this.state.mode === 'SEARCHING') {
      this._completedSurah = prevSurah;
      this._restorePreRukuIfNeeded(prevSurah);
      this._resetSearchBuf();
      console.log(`[Pipeline] Pause-advance: end of surah ${prevSurah}`);
    } else {
      console.log(`[Pipeline] Pause-advance: ${from} → ${this.state.surah}:${this.state.ayah}`);
      // After a pause-advance the next pause can fire after PAUSE_COOLDOWN_MS.
      // Set the read-advance minimum to the same duration so the read timer never
      // fires in the gap between two consecutive pause-advances — this prevents the
      // double-advance runaway (pause→read→pause→read every 3s).
      const cooldown = PAUSE_COOLDOWN_MS;
      this._scheduleReadAdvance(this.state.confidence, cooldown); // fallback timer for next ayah
    }
    this._emitState(null, null);
  }

  // ── Reading-timer advance (continuous fallback) ───────────────────────────
  // Fires if no pause is detected within the estimated ayah reading time.
  // Self-reschedules so display keeps moving if audio is unclear/quiet.
  _scheduleReadAdvance(confidence, afterPauseMinMs = 0) {
    this._cancelReadAdvance();
    if (this.state.mode !== 'LOCKED') return;
    if (confidence < READ_ADVANCE_CONFIDENCE) {
      const lingeredMs = this._ayahStartTime ? Date.now() - this._ayahStartTime : 0;
      // If the ayah has been sitting for 30s+ with low confidence, release the lock —
      // the match was probably wrong and we're wasting time.
      if (lingeredMs > 30000) {
        console.log(`[Pipeline] Low-conf stall ${confidence}% on ${this.state.surah}:${this.state.ayah} for ${Math.round(lingeredMs/1000)}s — releasing lock`);
        this.state = { ...createState(), mode: 'SEARCHING',
          lastLockedSurah: this.state.surah, lastLockedAyah: this.state.ayah };
        this._resetSearchBuf();
        this._emitState(null, null);
        return;
      }
      // Schedule a slow fallback timer (15s) so the display doesn't freeze forever.
      // Whisper will likely correct us before it fires.
      const fallbackMs = 15000;
      console.log(`[Pipeline] Read-advance low-conf fallback in ${fallbackMs}ms — conf ${confidence}% < ${READ_ADVANCE_CONFIDENCE}% (on ${this.state.surah}:${this.state.ayah} for ${Math.round(lingeredMs/1000)}s)`);
      this._displayAdvanceTimer = setTimeout(() => {
        this._displayAdvanceTimer = null;
        if (this.state.mode !== 'LOCKED') return;
        this._scheduleReadAdvance(this.state.confidence);
      }, fallbackMs);
      return;
    }

    const verse     = getVerseData(this.state.surah, this.state.ayah);
    const wordCount = verse?.transliteration
      ? verse.transliteration.split(/\s+/).length
      : (verse?.arabic ? verse.arabic.split(/\s+/).length : 8);
    const baseWps = this._measuredWps || READ_WORDS_PER_SEC;
    // Fast mode: 10% faster than measured pace (subtle, not aggressive).
    // The display should track the reciter, not outrun them.
    const wps     = this.fastMode ? baseWps * 1.1 : baseWps;

    const floorMs = this.fastMode
      ? Math.max(3500, READ_ADVANCE_MIN_MS)
      : Math.max(4500, READ_ADVANCE_MIN_MS);
    const minMs   = Math.max(floorMs, afterPauseMinMs);
    let durationMs = Math.min(
      Math.max(Math.round((wordCount / wps) * 1000), minMs),
      READ_ADVANCE_MAX_MS
    );
    // Single penalty multiplier — no stacking. Caps at ×1.5.
    const penalty = Math.min(this._timerPenalty, 1.5);
    if (penalty > 1.0) durationMs = Math.min(Math.round(durationMs * penalty), READ_ADVANCE_MAX_MS);
    const wpsTag = baseWps !== READ_WORDS_PER_SEC ? ` wps=${baseWps.toFixed(2)}` : '';
    const penTag = penalty > 1.0 ? ` ×${penalty.toFixed(1)}` : '';
    const modeTag = this.fastMode ? ' [FAST]' : wpsTag + penTag;
    console.log(`[Pipeline] Read-advance in ${durationMs}ms (${wordCount} words, conf=${confidence}%${modeTag})`);

    this._nextAdvanceMs = durationMs;
    this._timerStartedAt = Date.now();
    this._displayAdvanceTimer = setTimeout(() => {
      this._displayAdvanceTimer = null;
      this._nextAdvanceMs = 0;
      this._timerStartedAt = 0;
      if (this.state.mode !== 'LOCKED') return;
      const prevSurah = this.state.surah;
      this.state = transition(this.state, { type: 'MANUAL_ADVANCE' });
      if (this.state.mode === 'SEARCHING') {
        this._completedSurah = prevSurah;
        this._restorePreRukuIfNeeded(prevSurah);
        this._resetSearchBuf();
        console.log(`[Pipeline] Read-advance: end of surah ${prevSurah}`);
      } else {
        this._ayahStartTime = Date.now();
        console.log(`[Pipeline] Read-advance → ${this.state.surah}:${this.state.ayah}`);
        this._scheduleReadAdvance(this.state.confidence); // keep advancing
      }
      this._emitState(null, null);
    }, durationMs);
  }

  // Smooth catch-up: step display forward one ayah at a time toward target.
  // stepMs controls the delay between steps — set by the caller based on initial gap.
  // Uses _smoothAdvanceTimer so _cancelReadAdvance() aborts if Whisper fires again.
  _smoothAdvanceTo(targetSurah, targetAyah, stepMs) {
    const interval = stepMs || SMOOTH_ADVANCE_STEP_MS;
    this._smoothAdvanceTimer = null;
    if (this.state.mode !== 'LOCKED') return;
    if (this.state.surah === targetSurah && this.state.ayah === targetAyah) {
      this._scheduleReadAdvance(this.state.confidence); // reached — hand off to normal timer
      return;
    }
    // Overshot safety
    if (this.state.surah > targetSurah ||
        (this.state.surah === targetSurah && this.state.ayah > targetAyah)) {
      this._scheduleReadAdvance(this.state.confidence);
      return;
    }
    const prevSurah = this.state.surah;
    this.state = transition(this.state, { type: 'MANUAL_ADVANCE' });
    this._ayahStartTime = Date.now();
    this._emitState(null, null);
    if (this.state.mode !== 'LOCKED') {
      this._completedSurah = prevSurah;
      this._restorePreRukuIfNeeded(prevSurah);
      this._resetSearchBuf();
      return;
    }
    this._smoothAdvanceTimer = setTimeout(
      () => this._smoothAdvanceTo(targetSurah, targetAyah, interval),
      interval
    );
  }

  _cancelReadAdvance() {
    if (this._displayAdvanceTimer) { clearTimeout(this._displayAdvanceTimer); this._displayAdvanceTimer = null; }
    if (this._smoothAdvanceTimer)  { clearTimeout(this._smoothAdvanceTimer);  this._smoothAdvanceTimer  = null; }
    this._nextAdvanceMs = 0;
    this._timerStartedAt = 0;
    this._pauseAccumMs = 0;
  }

  // ── Public controls ───────────────────────────────────────────────────────
  setPreferredSurah(s) { this.preferredSurah = s; }
  manualAdvance() {
    this._cancelReadAdvance();
    this._timerPenalty = 1.0;
    this._backCorrectionStreak = 0;
    this._sameAyahStreak = 0;
    this._whisperConfirmCount = Math.max(this._whisperConfirmCount, 2);
    const prevSurah = this.state.surah;
    this.state = transition(this.state, { type: 'MANUAL_ADVANCE' });
    this._ayahStartTime = Date.now();
    if (this.state.mode === 'SEARCHING') {
      this._completedSurah = prevSurah;
      this._restorePreRukuIfNeeded(prevSurah);
      this._resetSearchBuf();
    } else {
      // User chose this position — use at least 65% confidence so timer isn't sluggish
      this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
    }
    this._emitState(null, null);
  }
  manualPrev()  {
    this._cancelReadAdvance();
    this._timerPenalty = 1.0;
    this._backCorrectionStreak = 0;
    this._sameAyahStreak = 0;
    this._whisperConfirmCount = Math.max(this._whisperConfirmCount, 2);
    this.state = transition(this.state, { type: 'MANUAL_PREV' });
    this._ayahStartTime = Date.now();
    this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
    this._emitState(null, null);
  }
  audioReturn() { this.state = transition(this.state, { type: 'AUDIO_RETURN' }); this._emitState(null, null); }
  reset()   { this._cancelReadAdvance(); this._resetSearchBuf(); this.state = createState(); this._emitState(null, null); }
  destroy() { this._cancelReadAdvance(); this._resetSearchBuf(); }
}
