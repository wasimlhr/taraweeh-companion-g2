/**
 * AudioPipeline V3 — extends V2 with:
 * - 3s chunks: search starts at 3s, locked uses 3–6s chunks (same logic throughout)
 * - Manual prev: half-timer when going back (reciter already halfway through)
 * - Bump cap: max 2 bumps per ayah, stop bumping when reciter repeating (streak≥2)
 * - Bump threshold: only bump when remaining ≥12s (was 8s)
 * - Re-lock: pass display position into RESUMING for better resync when display ahead
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { transcribe } from './transcriptionRouter.js';
import { processWhisperResult, transition, createState, getPrevAyah, getNextAyah } from './anchorStateMachine.js';
import { getVerseData } from './verseData.js';
import { probeWhisperEndpoint } from './whisperProvider.js';
import { findAnchor, isRefrain } from './keywordMatcher.js';

// ── Position persistence across restarts ────────────────────────────────────
const POS_FILE = '/tmp/taraweeh_position.json';
function _savePosition(surah, ayah, pace) {
  try { writeFileSync(POS_FILE, JSON.stringify({ surah, ayah, pace, ts: Date.now() })); } catch (_) {}
}
function _loadPosition() {
  try {
    if (!existsSync(POS_FILE)) return null;
    const d = JSON.parse(readFileSync(POS_FILE, 'utf8'));
    if (Date.now() - d.ts > 30 * 60 * 1000) return null; // stale after 30 min
    if (d.surah > 0 && d.ayah > 0) return d;
  } catch (_) {}
  return null;
}

const SAMPLE_RATE      = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS     = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

// Start at 3s for fast first lock; same logic continues in locked (3s chunks).
const SEARCH_WINDOWS_MS = [3000, 5000, 8000, 12000, 20000];
const MAX_SEARCH_BUF_MS = 35000;

// Use 3s chunks continuously (same as search start) — faster feedback, consistent logic
const LOCKED_MIN_MS    = parseInt(process.env.LOCKED_MIN_MS    || '4000', 10);
const LOCKED_MAX_MS    = parseInt(process.env.LOCKED_MAX_MS    || '10000', 10);
// 3s chunks → 4 misses = 12s (too fast). 12 misses ≈ 36s, similar to 10s chunks × 4.
// 2s chunks → 16 misses ≈ 32s before resuming (same effective time as 12 × 3s)
const MISSED_BEFORE_RESUMING_V3 = parseInt(process.env.MISSED_BEFORE_RESUMING_V3 || '16', 10);
const MISSED_BEFORE_LOST_V3     = parseInt(process.env.MISSED_BEFORE_LOST_V3 || '16', 10);
const LOCKED_MIN_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MIN_MS);
const LOCKED_MAX_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MAX_MS);

const SILENCE_THRESHOLD        = parseFloat(process.env.SILENCE_THRESHOLD        || '0.005');
const READ_ADVANCE_CONFIDENCE  = parseInt(process.env.READ_ADVANCE_CONFIDENCE    || '40',    10);
const READ_WORDS_PER_SEC       = parseFloat(process.env.READ_WORDS_PER_SEC       || '1.15');
const READ_ADVANCE_MIN_MS      = parseInt(process.env.READ_ADVANCE_MIN_MS        || '4000',  10);
// No hard cap — transliteration + pace mode determine duration. 90s safety only for bugs.
const READ_ADVANCE_MAX_MS      = parseInt(process.env.READ_ADVANCE_MAX_MS        || '55000', 10);
const READ_ADVANCE_CONFIRM_BUMP_MS = parseInt(process.env.READ_ADVANCE_CONFIRM_BUMP_MS || '2500', 10);
const SMOOTH_ADVANCE_STEP_MS   = parseInt(process.env.SMOOTH_ADVANCE_STEP_MS     || '1200',  10);
// By first lock we've matched 3–6s of audio — reciter is near end of ayah; advance quickly
const FIRST_LOCK_DURATION_FACTOR = parseFloat(process.env.FIRST_LOCK_DURATION_FACTOR || '0.25', 10);
// After catch-up or back-correct: reciter is partway through ayah — use shorter timer
const CORRECTED_DURATION_FACTOR = parseFloat(process.env.CORRECTED_DURATION_FACTOR || '0.5', 10);
// Cooldown after back-correction: suppress further back-corrections for this many ms
const BACK_CORRECT_COOLDOWN_MS = parseInt(process.env.BACK_CORRECT_COOLDOWN_MS || '5000', 10);
// User manual: press Prev when display 1 ayah ahead → logic advances too fast. Add lag to align.
// Mode-aware: Slow needs more lag (measured reciters), Fast less (keep up).
const DISPLAY_LAG_BASE_MS = parseInt(process.env.DISPLAY_LAG_MS || '1200', 10);

const PAUSE_ANALYSIS_MS    = parseInt(process.env.PAUSE_ANALYSIS_MS   || '250',  10);
const PAUSE_ANALYSIS_BYTES = Math.floor(BYTES_PER_MS * PAUSE_ANALYSIS_MS);
const PAUSE_THRESHOLD      = parseFloat(process.env.PAUSE_THRESHOLD   || '0.005');
const PAUSE_ADVANCE_MS     = parseInt(process.env.PAUSE_ADVANCE_MS    || '2500', 10);
const PAUSE_COOLDOWN_MS    = parseInt(process.env.PAUSE_COOLDOWN_MS   || '6000', 10);
const MANUAL_ADJUST_COOLDOWN_MS = parseInt(process.env.MANUAL_ADJUST_COOLDOWN_MS || '2000', 10);

const BASE_DISPLAY_LEAD = 2;
const BLOCKED_FORCE_UNBLOCK_MS = 8000;  // Force-unblock after 8s even without real Whisper match

// ── Noise filtering ──────────────────────────────────────────────────────────

const NOISE_WORDS = new Set([
  'موسيقى', 'تبا', 'تباً', 'هممم', 'همم', 'مممم', 'ممم',
  'music', 'applause', 'laughter', 'silence',
  'اشترك', 'للاشتراك',
  'مرحبا', 'مرحباً', 'اهلا', 'أهلاً', 'اهلاً',
  'صباح', 'مساء',
  'شكرا', 'شكراً',
  'نانسي', 'قنقر',  // channel/translator names (e.g. ترجمة نانسي قنقر)
]);
const NOISE_PHRASES = [
  'مرحبا بك', 'مرحباً بك', 'أهلا بك', 'اهلا بك',
  'صباح الخير', 'مساء الخير', 'كيف حالك',
  'شكرا لكم', 'ترجمه لكي', 'توقف عن الاشتراك', 'ماذا يفعلون',
  'اشتركوا في القناة', 'اشتركوا في', 'اشترك في القناة',
  'شكرا للمشاهدة', 'شكرا لمشاهدتكم',
  'يا عمار',  // non-Quran: someone addressing "Ammar"
];

const ISTI_ADHA_PATTERNS = [
  /اعوذ\s+بالله/,
  /أعوذ\s+بالله/,
  /اعوذ\s+ب/,
  /الشيطان\s+الرجيم/,
  // Bismillah handled separately by isBismillahOnly — always skip, never lock on Fatiha
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
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n * 2; i += 2) s += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(s / n);
}

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
  t = t.replace(/^(شكرا|شكراً|ترجمة[^\s]*)\s*/g, '').trim();
  return t;
}

const QURAN_MARKS_RE    = /[\u064B-\u065F\u0610-\u061A\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0615\u0652\u06D9\uFE70-\uFEFF]/g;
const BISMILLAH_NORM_RE = /^بسم\s+الله\s+الرحمن\s+الرحيم[\s\u06D9\u060C]*/;
function stripBismillahPrefix(text) {
  const norm = text.replace(QURAN_MARKS_RE, '').replace(/\s+/g, ' ').trim();
  const match = norm.match(BISMILLAH_NORM_RE);
  if (!match) return norm;
  const remainder = norm.slice(match[0].length).trim();
  if (remainder.length < 5) return norm;
  console.log(`[Pipeline] Stripped bismillah prefix → "${remainder.substring(0, 60)}"`);
  return remainder;
}
// Bismillah alone appears before every surah (except 9) — never lock on Fatiha from it.
// Treat as generic: skip, advance window, wait for distinguishing content (الحمد, الم, etc).
function isBismillahOnly(text) {
  if (!text || !text.trim()) return false;
  const norm = text.replace(QURAN_MARKS_RE, '').replace(/\s+/g, ' ').trim();
  const match = norm.match(BISMILLAH_NORM_RE);
  if (!match) return false;
  const remainder = norm.slice(match[0].length).trim();
  return remainder.length < 5;
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

// Whisper often garbles takbeer: أكبى/اكبي/اكبا/أكبر — match all variants.
// Don't require ^ — noise words may precede it in 2s chunks.
const TAKBEER_RE = /الله\s*(ال)?[اأآ]كب[رىياً]/u;
function isTakbeer(text) {
  if (!text) return false;
  const n = text.replace(/[\u064b-\u065f\u0670\u0640]/g, '').trim();
  return TAKBEER_RE.test(n);
}

// ── AudioPipeline class ───────────────────────────────────────────────────────

export class AudioPipeline {
  constructor({ onStateUpdate, onStatus, onError, preferredSurah = 0, translationLang = '', hfToken, whisperOpts }) {
    this.onStateUpdate   = onStateUpdate;
    this.onStatus        = onStatus || (() => {});
    this.onError         = onError  || (() => {});
    this.preferredSurah  = preferredSurah;
    this.translationLang = (translationLang && String(translationLang).trim()) || '';
    this.whisperOpts     = whisperOpts || (hfToken ? { apiKey: hfToken } : null);

    this.state     = createState();
    this.active    = false;
    this.processing = false;

    this._completedSurah = 0;

    // Restore last known position from disk (survives restarts)
    const restored = _loadPosition();
    if (restored) {
      console.log(`[Pipeline] Restored position: ${restored.surah}:${restored.ayah} (pace=${restored.pace || 0}ms/w)`);
    }
    this._restoredSurah = restored?.surah || 0;
    this._restoredAyah  = restored?.ayah || 0;
    if (restored?.pace > 0) this._measuredMsPerWord = restored.pace;

    // Dual position model: Whisper = ground truth, display = animation
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;

    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;
    this._searchGen    = 0;
    this._arRahmanRefrainSeen = false;  // once refrain detected, ignore content verses until lock
    this._lastSearchTexts = [];  // last 2–3 chunk texts for combined matching
    this._timerHeartbeatRef = null;  // periodic emit so frontend countdown never disappears

    this._lockedBuf      = Buffer.alloc(0);
    this._lastTexts      = [];
    this._lastLockedCall = 0;

    this._displayAdvanceTimer = null;
    this._nextAdvanceMs       = 0;
    this._timerStartedAt      = 0;
    this._smoothAdvanceTimer  = null;

    this._lastAudioStatusMs = 0;
    this._ayahStartTime     = 0;

    this._pauseAnalysisBuf   = Buffer.alloc(0);
    this._pauseAccumMs       = 0;
    this._lastPauseAdvanceMs = 0;
    this._lastManualAdjustMs = 0;
    this._lastBackCorrectMs = 0;  // cooldown after back-correction to prevent ping-pong

    this.fastMode = false;
    this.slowMode = false;  // paceMode: normal | fast | slow (fast and slow mutually exclusive)

    this._measuredWps            = READ_WORDS_PER_SEC;
    this._whisperLastConfirmMs   = 0;
    this._whisperLastConfirmAyah = 0;
    this._whisperLastConfirmSurah = 0;

    this._behindRepeatAyah  = 0;    // tracks consecutive behind-reports on same ayah
    this._behindRepeatCount = 0;    // how many times in a row
    this._driftMult         = 1.0;  // >1.0 = display running ahead, slows timer gradually
    this._sameAyahStreak    = 0;    // consecutive confirms of same ayah at display (reciter repeating)
    this._bumpCountForAyah  = 0;    // bumps applied this ayah — capped to avoid indefinite extension
    this._blockedSince      = 0;    // timestamp when display first got BLOCKED (0 = not blocked)

    // Learned pace: measured from manual advance clicks (ms per word)
    this._measuredMsPerWord = 0;   // 0 = no data yet, use default
    this._msPerWordSamples  = [];  // last 6 samples for rolling average

    // Pace tracking: rolling window of recent WPS samples for trend detection
    this._paceHistory    = [];   // [{wps, ts}] — last 8 measurements
    this._paceCategory   = '';   // 'slow' | 'normal' | 'fast' | 'very-fast'
    this._paceTrend      = 0;   // -1 decelerating, 0 steady, +1 accelerating
    this._lastPaceEmitMs = 0;

    this.taraweehMode    = false;
    this._taraweehPos    = 'QIYAM';
    this._taraweehLastFrom = 'reciting';  // 'reciting' | 'ruku' | 'sajda1' | 'sajda2'
    this._sajdaCount     = 0;              // 1 or 2 when in SAJDA
    this._rakatCount     = 0;
    this._preRukuSurah   = 0;
    this._preRukuAyah    = 0;

    probeWhisperEndpoint(this.whisperOpts, this.onStatus).catch(() => {});
  }

  get _maxDisplayLead() {
    if (this.fastMode) return 4;
    if (this._paceCategory === 'fast' || this._paceCategory === 'very-fast') return 4;
    return 3;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setFastMode(enabled) {
    this.fastMode = !!enabled;
    if (enabled) this.slowMode = false;
    console.log(`[Pipeline] Pace: ${this.fastMode ? 'FAST' : this.slowMode ? 'SLOW' : 'normal'}`);
    this.onStatus({ type: 'fast_mode', enabled: this.fastMode });
    this.onStatus({ type: 'slow_mode', enabled: this.slowMode });
  }

  setSlowMode(enabled) {
    this.slowMode = !!enabled;
    if (enabled) this.fastMode = false;
    console.log(`[Pipeline] Pace: ${this.slowMode ? 'SLOW' : this.fastMode ? 'FAST' : 'normal'}`);
    this.onStatus({ type: 'slow_mode', enabled: this.slowMode });
    this.onStatus({ type: 'fast_mode', enabled: this.fastMode });
  }

  setTaraweehMode(enabled) {
    this.taraweehMode = !!enabled;
    if (!this.taraweehMode) {
      this._taraweehPos = 'QIYAM';
      this._taraweehLastFrom = 'reciting';
      this._sajdaCount = 0;
      this._rakatCount = 0;
    }
    console.log(`[Pipeline] Taraweeh mode ${this.taraweehMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'taraweeh_mode', enabled: this.taraweehMode,
      position: this._taraweehPos, rakat: this._rakatCount });
  }

  resetRakat() {
    this._rakatCount = 0;
    this._taraweehPos = 'QIYAM';
    this._taraweehLastFrom = 'reciting';
    this._sajdaCount = 0;
    this._emitTaraweeh();
  }

  setPreferredSurah(s) { this.preferredSurah = s; }

  _startTimerHeartbeat() {
    this._stopTimerHeartbeat();
    // 500ms with 3s chunks = smoother countdown; Whisper results also emit on confirm/bump
    this._timerHeartbeatRef = setInterval(() => {
      if (!this.active || this.state.mode !== 'LOCKED') return;
      if (this._displayAdvanceTimer && this._timerStartedAt) {
        this._emitState(null, null);
      }
    }, 500);
  }

  _stopTimerHeartbeat() {
    if (this._timerHeartbeatRef) {
      clearInterval(this._timerHeartbeatRef);
      this._timerHeartbeatRef = null;
    }
  }

  start() {
    if (this.active) {
      console.log('[Pipeline] Already active — ignoring duplicate start');
      return;
    }
    this._cancelReadAdvance();
    this._startTimerHeartbeat();
    this.active = true;
    this.state  = createState();
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;
    this._preRecitSkips = 0;
    this._resetSearchBuf();
    console.log('[Pipeline] Started');
  }

  stop() {
    this.active = false;
    this._stopTimerHeartbeat();
    this._resetSearchBuf();
    this._lockedBuf          = Buffer.alloc(0);
    this._lastLockedCall     = 0;
    this._pauseAnalysisBuf   = Buffer.alloc(0);
    this._pauseAccumMs       = 0;
    this._cancelReadAdvance();
    this.state = createState();
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;
    this._emitState(null, null);
    console.log('[Pipeline] Stopped');
  }

  manualAdvance() {
    this._cancelReadAdvance();
    // When in SEARCHING: user browsing to find ayah — update display, show "Auto locking…", don't lock
    if (this.state.mode === 'SEARCHING') {
      const s = this._displaySurah || this.state.lastLockedSurah || this._restoredSurah || 2;
      const a = this._displayAyah || this.state.lastLockedAyah || this._restoredAyah || 1;
      const next = getNextAyah(s, a);
      if (!next) return;
      this._displaySurah = next.surah;
      this._displayAyah = next.ayah;
      this._userSearchingDisplay = true;
      this._whisperAyah = this._displayAyah;
      this._emitState(null, null);
      return;
    }
    const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1, this.translationLang);
    if (!nextAyahData) {
      const prevSurah = this._displaySurah;
      this._completedSurah = prevSurah;
      this._restorePreRukuIfNeeded(prevSurah);
      this.state = { ...createState(), mode: 'SEARCHING', lastLockedSurah: 0, lastLockedAyah: 0 };
      this._resetSearchBuf();
    } else {
      const from = `${this._displaySurah}:${this._displayAyah}`;
      // Learn pace from how long user stayed on previous ayah
      this._learnPaceFromManual();
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;
      this._displayAyah++;
      const to = `${this._displaySurah}:${this._displayAyah}`;
      this._ayahStartTime = Date.now();
      this._lastManualAdjustMs = Date.now();
      this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
        surah: this._displaySurah, ayah: this._displayAyah,
        lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
      console.log(`[Pipeline] Manual advance: ${from} → ${to} (pacer, cooldown ${MANUAL_ADJUST_COOLDOWN_MS / 1000}s)`);
      this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
    }
    this._emitState(null, null);
  }

  // Learn reciter pace from manual advance: how long did user stay on previous ayah?
  _learnPaceFromManual() {
    if (!this._ayahStartTime) return;
    const elapsedMs = Date.now() - this._ayahStartTime;
    if (elapsedMs > 120000) return; // stale, ignore
    // Prevent death spiral: if previous ayah was also a manual advance (rapid clicking),
    // skip learning to avoid recording 500ms/word from user impatience.
    if (this._lastManualAdjustMs && (elapsedMs < 1500)) {
      console.log(`[Pipeline] Pace learning skipped: ayah too short (${elapsedMs}ms, likely rapid clicking)`);
      return;
    }
    const verse = getVerseData(this._displaySurah, this._displayAyah, this.translationLang);
    if (!verse) return;
    const translit = verse.transliteration || '';
    const wc = Math.max(1, translit ? translit.split(/\s+/).length : (verse.arabic ? verse.arabic.split(/\s+/).length : 0));
    if (wc < 3) return; // too short to learn from
    const sample = Math.round(elapsedMs / wc);
    // Only learn from realistic pace: 700-4000 ms/word.
    if (sample < 700 || sample > 4000) {
      console.log(`[Pipeline] Pace ignored: ${wc}w in ${(elapsedMs/1000).toFixed(1)}s = ${sample}ms/w (outside 700-4000 range)`);
      return;
    }
    this._msPerWordSamples.push(sample);
    if (this._msPerWordSamples.length > 10) this._msPerWordSamples.shift();
    // Weighted median: sort samples, take middle value. More robust than mean
    // against outliers (one slow ayah = reciter paused, shouldn't drag avg up).
    const sorted = [...this._msPerWordSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
    const prev = this._measuredMsPerWord;
    this._measuredMsPerWord = median;
    console.log(`[Pipeline] Pace learned: ${wc}w in ${(elapsedMs/1000).toFixed(1)}s = ${sample}ms/w → median ${median}ms/w (${this._msPerWordSamples.length} samples)`);
    // If pace changed significantly, adjust the CURRENT running timer too
    if (prev > 0 && this._displayAdvanceTimer && this._timerStartedAt && this._nextAdvanceMs > 0) {
      const ratio = median / prev;
      if (Math.abs(ratio - 1.0) > 0.15) { // >15% change
        const elapsed = Date.now() - this._timerStartedAt;
        const remaining = Math.max(0, this._nextAdvanceMs - elapsed);
        const adjusted = Math.max(2000, Math.round(remaining * ratio));
        this._cancelReadAdvance();
        this._nextAdvanceMs = adjusted;
        this._timerStartedAt = Date.now();
        this._displayAdvanceTimer = setTimeout(() => {
          this._displayAdvanceTimer = null;
          this._nextAdvanceMs = 0;
          this._timerStartedAt = 0;
          if (!this._canDisplayAdvance()) return;
          const nextData = getVerseData(this._displaySurah, this._displayAyah + 1, this.translationLang);
          if (!nextData) {
            // end of surah handled by _scheduleReadAdvance path
            this._scheduleReadAdvance(this.state.confidence);
          } else {
            this._sameAyahStreak = 0;
            this._bumpCountForAyah = 0;
            this._displayAyah++;
            this._ayahStartTime = Date.now();
            this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
              lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
            console.log(`[Pipeline] Read-advance → ${this._displaySurah}:${this._displayAyah}`);
            this._scheduleReadAdvance(this.state.confidence);
          }
          this._emitState(null, null);
        }, adjusted);
        console.log(`[Pipeline] Timer adjusted: ${Math.round(remaining/1000)}s → ${Math.round(adjusted/1000)}s (pace ${prev}→${median}ms/w)`);
      }
    }
  }

  manualPrev() {
    this._cancelReadAdvance();
    this._sameAyahStreak = 0;
    this._bumpCountForAyah = 0;
    // When in SEARCHING: user browsing to find ayah — stay in same surah
    if (this.state.mode === 'SEARCHING') {
      const s = this._displaySurah || this.state.lastLockedSurah || this._restoredSurah || 2;
      const a = this._displayAyah || this.state.lastLockedAyah || this._restoredAyah || 1;
      if (a > 1) {
        this._displaySurah = s;
        this._displayAyah = a - 1;
        this._userSearchingDisplay = true;
        this._whisperAyah = this._displayAyah;
        this._emitState(null, null);
      }
      return;
    }
    if (this._displayAyah > 1) {
      this._displayAyah--;
    }
    this._whisperAyah = this._displayAyah;
    this._ayahStartTime = Date.now();
    this._lastManualAdjustMs = Date.now();
    this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
      surah: this._displaySurah, ayah: this._displayAyah,
      lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
    // Reciter is already halfway through — use half the timer, not full
    this._scheduleReadAdvance(Math.max(this.state.confidence, 65), 0, 0.5);
    this._emitState(null, null);
  }

  audioReturn() {
    this.state = transition(this.state, { type: 'AUDIO_RETURN' });
    this._emitState(null, null);
  }

  reset() {
    this._cancelReadAdvance();
    this._resetSearchBuf();
    this.state = createState();
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;
    this._emitState(null, null);
  }

  destroy() {
    this.active = false;           // stop all processing & stale-check in-flight Whisper
    this._stopTimerHeartbeat();     // kill 500ms emit interval
    this._cancelReadAdvance();      // clear display-advance & smooth-advance timers
    this._resetSearchBuf();         // free search buffers
    this._lockedBuf = Buffer.alloc(0);
    this.processing = false;
    this.onStateUpdate = () => {};  // swallow any late callbacks
    this.onStatus = () => {};
    this.onError = () => {};
    console.log('[Pipeline] Destroyed');
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────

  ingest(pcmData) {
    if (!this.active) return;

    const now = Date.now();
    if (now - this._lastAudioStatusMs >= 3000) {
      this._lastAudioStatusMs = now;
      const rms = computeRms(pcmData);
      console.log(`[Pipeline] Audio: rms=${rms.toFixed(4)} mode=${this.state.mode}`);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });
    }

    // Pause detection disabled — the transliteration-based timer with WPS
    // adaptation and elongation bonus handles ayah timing better than raw
    // silence detection, which was triggering on breaths and causing the
    // display to race ahead of the reciter.

    if (this.state.mode === 'LOCKED') {
      this._lockedBuf = Buffer.concat([this._lockedBuf, pcmData]);

      // Keep a rolling buffer of the last 10s of audio
      if (this._lockedBuf.length > LOCKED_MAX_BYTES) {
        this._lockedBuf = this._lockedBuf.subarray(this._lockedBuf.length - LOCKED_MAX_BYTES);
      }

      // Overlapping windows: Send 8-10s chunks every 4s for better Whisper accuracy
      // with faster feedback. More context = better transcription, but frequent sends
      // = quicker corrections.
      const now = Date.now();
      const timeSinceLastSend = this._lastLockedCall ? (now - this._lastLockedCall) : Infinity;
      
      // Send when we have at least 4s accumulated AND 4s has passed since last send
      if (this._lockedBuf.length >= LOCKED_MIN_BYTES && 
          timeSinceLastSend >= LOCKED_MIN_MS && 
          !this.processing) {
        // Send the entire rolling buffer (8-10s of audio with overlap)
        const chunk = Buffer.from(this._lockedBuf);
        const bufMs = Math.round(chunk.length / BYTES_PER_MS);
        this._lastLockedCall = now;
        console.log(`[Pipeline] Locked chunk ${bufMs}ms (${Math.round(chunk.length/1024)}KB) gap=${Math.round(timeSinceLastSend)}ms overlap=true`);
        this._processLockedChunk(chunk);
        // Do NOT clear _lockedBuf — keep the rolling window for overlap
      }
    } else {
      this._searchBuf = Buffer.concat([this._searchBuf, pcmData]);
      const bufMs = this._searchBuf.length / BYTES_PER_MS;

      if (bufMs >= MAX_SEARCH_BUF_MS) {
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

  // ── Search mode ────────────────────────────────────────────────────────────

  _resetSearchBuf() {
    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;
    this._arRahmanRefrainSeen = false;
    this._lastSearchTexts = [];
    this.processing    = false;
    this._searchGen    = (this._searchGen || 0) + 1;
  }

  async _processSearchChunk() {
    this.processing = true;
    const myGen = this._searchGen;
    const bufMs = Math.round(this._searchBuf.length / BYTES_PER_MS);

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

      if (this.taraweehMode) {
        if (isTakbeer(cleaned)) {
          console.log(`[Pipeline] Taraweeh takbeer detected (pos=${this._taraweehPos})`);
        } else if (/الله|اكبر|أكبر|اكبر/i.test(cleaned) && cleaned.length < 80) {
          console.log(`[Pipeline] Taraweeh: Whisper has Allah/Akbar but no takbeer match: "${cleaned.slice(0, 60)}"`);
        }
      }
      if (this.taraweehMode && isTakbeer(cleaned)) {
        if (!stale()) {
          this._handleTaraweehTakbeer(true);
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

      // In RUKU we expect Fatiha — allow bismillah to reach matcher so we can lock on 1:2+.
      // Otherwise bismillah-only is generic (could be any surah) — skip.
      if (isBismillahOnly(cleaned) && this._taraweehPos !== 'RUKU') {
        console.log(`[Pipeline] Bismillah only — treating as generic, skipping (not locking on Fatiha)`);
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

      // Combine with previous chunks for richer matching — G2 garbled chunks often
      // split the refrain; combined "فبأي آلاء" + "ربكما تكذبان" scores better.
      this._lastSearchTexts.push(cleaned);
      if (this._lastSearchTexts.length > 3) this._lastSearchTexts.shift();
      const combined = this._lastSearchTexts.length >= 2
        ? this._lastSearchTexts.slice(-2).join(' ')
        : cleaned;

      // Ar-Rahman (55): once we detect the refrain "فأي الأء ربكما تكذبان", we know surah 55.
      // Ignore WEAK content matches (they cause false locks); but allow STRONG content matches
      // (e.g. 55:7 "والسماء رفعها") so we can lock faster than waiting for another refrain.
      if (this.state.mode === 'SEARCHING') {
        const { matches } = findAnchor(combined, this._arRahmanRefrainSeen ? 55 : 0);
        const top = matches[0];
        if (top && top.surah === 55) {
          if (isRefrain(55, top.ayah)) {
            this._arRahmanRefrainSeen = true;
          } else if (this._arRahmanRefrainSeen) {
            const score = top.score ?? 0;
            if (score < 0.50) {
              console.log(`[Pipeline] Ar-Rahman: ignoring weak content 55:${top.ayah} (score=${score.toFixed(2)}) — waiting for refrain or strong match`);
              if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
              return;
            }
            // Strong content match (≥0.50) — let it through, can lock
          }
        }
      }

      const preferredSurah = (this.taraweehMode && this._taraweehPos === 'RUKU') ? 1
        : (this._arRahmanRefrainSeen ? 55 : this.preferredSurah);
      const opts = { preferredSurah, fastMode: this.fastMode, missBeforeResuming: MISSED_BEFORE_RESUMING_V3, missBeforeLost: MISSED_BEFORE_LOST_V3 };
      if (this.state.mode === 'RESUMING' && this._displaySurah > 0 && this._displayAyah > 0) {
        opts.displaySurah = this._displaySurah;
        opts.displayAyah = this._displayAyah;
      }
      if (this._userSearchingDisplay && this._displaySurah > 0 && this._displayAyah > 0) {
        opts.preferredDisplaySurah = this._displaySurah;
        opts.preferredDisplayAyah = this._displayAyah;
      }
      this.state = processWhisperResult(combined, this.state, opts);

      this._emitMatchProgress(text, rms, bufMs);

      if (this.state.mode === 'LOCKED') {
        this._arRahmanRefrainSeen = false;  // ayah lock achieved
        this._resetSearchBuf();
        this._lastLockedCall = 0;
        this._lockedBuf = Buffer.alloc(0);

        this._whisperSurah = this.state.surah;
        this._whisperAyah  = this.state.ayah;

        // If re-locking on the same surah and display is only slightly ahead,
        // don't move display backward — it was already ahead on its timer.
        // But if the gap is large (10+ ayahs), the reciter likely restarted
        // the surah or jumped — follow them.
        const sameSurahRelock = this.state.surah === this._displaySurah
          && this._displayAyah > 0;
        const relockGap = this._displayAyah - this.state.ayah;
        if (sameSurahRelock && this.state.ayah < this._displayAyah && relockGap < 10) {
          console.log(`[Pipeline] LOCKED on ${this.state.surah}:${this.state.ayah} after ${bufMs}ms — display stays at :${this._displayAyah} (not going back, gap=${relockGap})`);
          this._userSearchingDisplay = false;
          this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
            lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        } else {
          console.log(`[Pipeline] LOCKED on ${this.state.surah}:${this.state.ayah} after ${bufMs}ms`);
          this._displaySurah = this.state.surah;
          this._displayAyah  = this.state.ayah;
          this._userSearchingDisplay = false;
          this._sameAyahStreak = 0;
          this._bumpCountForAyah = 0;
        }

        this._ayahStartTime = Date.now();
        this._measuredWps            = READ_WORDS_PER_SEC;
        this._whisperLastConfirmMs   = Date.now();
        this._whisperLastConfirmAyah = this.state.ayah;
        this._whisperLastConfirmSurah = this.state.surah;

        // Locked on verse during RUKU/SAJDA → show verse, hide overlay
        if (this.taraweehMode && (this._taraweehPos === 'RUKU' || this._taraweehPos === 'SAJDA')) {
          this._taraweehPos = 'QIYAM';
          this._emitTaraweeh();
        }
        // Locked on verse = reciting (next takbeer goes to RUKU)
        if (this.taraweehMode) this._taraweehLastFrom = 'reciting';

        this._scheduleReadAdvance(this.state.confidence, 0, FIRST_LOCK_DURATION_FACTOR);
        this._emitState(text, rms);
        return;
      } else {
        // Wait for anchor to lock — don't start display on weak candidates.
        // Show candidate + "Auto locking" on glasses; only advance when properly locked.
        if (!stale()) this._emitState(text, rms);
        if (!stale()) this._advanceSearchWindow();
      }
    } catch (err) {
      console.error('[Pipeline] Search error:', err.message);
      this.onError(err.message);
      if (!stale()) this._advanceSearchWindow();
    }

    if (!stale()) {
      this.processing = false;
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

  // ── Locked mode ────────────────────────────────────────────────────────────

  async _processLockedChunk(chunk) {
    this.processing = true;
    try {
      const rms = computeRms(chunk);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });

      // When display is capped waiting for Whisper, force transcription even on quiet audio
      // so Whisper can catch up. Otherwise the display freezes indefinitely during soft passages.
      const displayCapped = this._whisperAyah > 0
        && (this._displayAyah - this._whisperAyah) >= this._maxDisplayLead;

      if (rms < SILENCE_THRESHOLD && !displayCapped) {
        const newState = transition(this.state, { type: 'SILENCE' });
        if (newState.mode !== this.state.mode) {
          this.state = newState;
          this._emitState(null, rms);
        }
        this.processing = false;
        return;
      }

      const chunkMs = Math.round(chunk.length / BYTES_PER_MS);
      console.log(`[Pipeline] Locked check ${chunkMs}ms rms=${rms.toFixed(3)}, display=${this._displaySurah}:${this._displayAyah}, whisper=${this._whisperSurah}:${this._whisperAyah}${displayCapped ? ' [force — capped]' : ''}`);

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

      if (this.taraweehMode) {
        if (isTakbeer(cleaned)) {
          if (this.state.surah > 1) {
            this._preRukuSurah = this.state.surah;
            this._preRukuAyah  = this.state.ayah;
          }
          console.log(`[Pipeline] Taraweeh takbeer (LOCKED) pos=${this._taraweehPos} saved=${this._preRukuSurah}:${this._preRukuAyah}`);
        } else if (/الله|اكبر|أكبر|اكبر/i.test(cleaned) && cleaned.length < 80) {
          console.log(`[Pipeline] Taraweeh LOCKED: Whisper has Allah/Akbar but no takbeer: "${cleaned.slice(0, 60)}"`);
        }
      }
      if (this.taraweehMode && isTakbeer(cleaned)) {
        this._handleTaraweehTakbeer(true);
        this.processing = false;
        return;
      }

      if (!cleaned || isNoise(cleaned)) {
        this.processing = false;
        return;
      }

      if (isAmeen(cleaned)) {
        if (this.taraweehMode) {
          console.log(`[Pipeline] Ameen detected (LOCKED)`);
          this.onStateUpdate({ type: 'ameen' });
        }
        this.processing = false;
        return;
      }

      if (isBismillahOnly(cleaned)) {
        this.processing = false;
        return;  // generic — don't use to re-anchor or jump
      }

      // Hallucination guard: same text 3x in a row → skip
      this._lastTexts.push(cleaned);
      if (this._lastTexts.length > 3) this._lastTexts.shift();
      if (this._lastTexts.length >= 3 && this._lastTexts.every(t => t === cleaned)) {
        console.log(`[Pipeline] Repeated hallucination — skipping`);
        this.processing = false;
        return;
      }

      const prevSurah = this.state.surah;
      const anchorResult = processWhisperResult(cleaned, this.state, {
        preferredSurah: this.preferredSurah,
        fastMode: this.fastMode,
        missBeforeResuming: MISSED_BEFORE_RESUMING_V3,
        missBeforeLost: MISSED_BEFORE_LOST_V3,
      });

      if (anchorResult.mode !== 'LOCKED') {
        // Don't cancel the timer — keep the display flowing at the measured
        // pace while we try to re-lock. The display keeps advancing so the
        // user sees continuous verses, not "Synchronizing".
        console.log(`[Pipeline] Anchor lost lock — searching in background (display continues at ${this._displaySurah}:${this._displayAyah})`);
        this.state = anchorResult;
        this._whisperLastConfirmMs = 0;
        this._resetSearchBuf();
        this._emitState(text, rms);
      } else if (anchorResult.surah !== prevSurah && anchorResult.surah !== 0) {
        console.log(`[Pipeline] Surah mismatch: display=${this._displaySurah} whisper=${anchorResult.surah} — releasing lock to re-search`);
        this._cancelReadAdvance();
        this._measuredWps = READ_WORDS_PER_SEC;
        this._resetSearchBuf();
        this.state = createState();
        this._emitState(text, rms);
        this.processing = false;
        return;
      } else {
        // Let anchor track the reciter independently, but don't let it drift
        // too far behind the display. Stale Whisper audio can back-correct the
        // anchor to a position the display already passed — clamp it so the
        // next spotCheck scans near the display, not way behind.
        let finalResult = anchorResult;
        const minAnchorAyah = Math.max(1, this._displayAyah - 2);
        if (anchorResult.surah === this._displaySurah && anchorResult.ayah < minAnchorAyah) {
          finalResult = { ...anchorResult, ayah: minAnchorAyah };
        }
        this.state = finalResult;
        // _locked = spotCheck found a real word match; false = noise/miss.
        // Pass this through so the timer hold only fires on real confirms.
        const realMatch = !!finalResult._locked;
        this._onWhisperConfirm(finalResult.surah, finalResult.ayah, finalResult.confidence, text, rms, realMatch);
      }
    } catch (err) {
      console.error('[Pipeline] Locked chunk error:', err.message);
    }
    this.processing = false;
  }

  // ── Core V2: single handler for Whisper confirmations in LOCKED mode ───────

  _onWhisperConfirm(confirmedSurah, confirmedAyah, score, text, rms, realMatch = true) {
    const sameSurah = confirmedSurah === this._displaySurah;

    // ── Ratchet _whisperAyah forward only on REAL matches ──────────────────
    // Noise results carry the anchor's stale position — not actual Whisper confirmation.
    // Ratcheting on noise would let display race ahead unchecked.
    if (realMatch && (!sameSurah || confirmedAyah > this._whisperAyah)) {
      this._updateWpsClock(confirmedSurah, confirmedAyah);
      this._whisperSurah = confirmedSurah;
      this._whisperAyah  = confirmedAyah;
    }

    // ── Rule 1: Whisper behind display ─────────────────────────────────
    // Prefer wait/catch-up: slow the timer (drift) so reciter catches up.
    // Only back-correct on strong repeat evidence (4× same ayah, conf≥55%).
    // Skip entirely if user recently manual-advanced to catch up — don't snap back.
    if (sameSurah && confirmedAyah < this._displayAyah) {
      if (this._lastManualAdjustMs && (Date.now() - this._lastManualAdjustMs) < MANUAL_ADJUST_COOLDOWN_MS) {
        console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} — ignoring (manual adjust cooldown)`);
        this._behindRepeatCount = 0;
        this._behindRepeatAyah = 0;
        this._emitState(text, rms);
        return;
      }
      // Post-back-correction cooldown: don't snap back again right away
      if (this._lastBackCorrectMs && (Date.now() - this._lastBackCorrectMs) < BACK_CORRECT_COOLDOWN_MS) {
        console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} — ignoring (back-correct cooldown)`);
        this._emitState(text, rms);
        return;
      }
      const refrainVerse = isRefrain(confirmedSurah, confirmedAyah);
      const lag = this._displayAyah - confirmedAyah;
      // lag=1: require 2 consecutive reports (was 1 for score>=48) — reduces false snap-backs
      const REPEAT_BACK_CORRECT_WINS = lag === 1 ? 2 : 3;
      const REPEAT_BACK_CORRECT_MIN_CONF = 65;

      // ── Repeat tracking (genuine reciter repeats, not mishear) ───────
      if (!refrainVerse && confirmedAyah === this._behindRepeatAyah && score >= REPEAT_BACK_CORRECT_MIN_CONF) {
        this._behindRepeatCount++;
      } else {
        this._behindRepeatAyah  = confirmedAyah;
        this._behindRepeatCount = refrainVerse ? 0 : 1;
      }

      if (this._behindRepeatCount >= REPEAT_BACK_CORRECT_WINS) {
        const backDist = this._displayAyah - confirmedAyah;
        if (backDist > 3) {
          console.log(`[Pipeline] Back-correct blocked: dist=${backDist} > 3 — anchor confused`);
          this._behindRepeatCount = 0;
          this._behindRepeatAyah = 0;
          this._emitState(text, rms);
          return;
        }
        this._sameAyahStreak = 0;
        this._bumpCountForAyah = 0;
        this._cancelReadAdvance();
        this._displayAyah  = confirmedAyah;
        this._driftMult    = 1.0;
        this._ayahStartTime = Date.now();
        this._lastBackCorrectMs = Date.now();  // start cooldown to prevent ping-pong
        this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
          lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        console.log(`[Pipeline] Reciter repeat detected: display → :${confirmedAyah} (${this._behindRepeatCount}x, conf=${score}%)`);
        this._behindRepeatCount = 0;
        this._behindRepeatAyah  = 0;
        this._emitState(text, rms);
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE), 0, CORRECTED_DURATION_FACTOR);
        return;
      }

      // ── Gradual slow-down: increase drift multiplier when confident ────
      // Slower timer lets reciter catch up. More aggressive (+0.25) to reduce drift.
      if (score >= REPEAT_BACK_CORRECT_MIN_CONF) {
        this._driftMult = Math.min(2.5, this._driftMult + 0.25);
      }

      console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} (lag=${lag}, conf=${score}%, drift=${this._driftMult.toFixed(2)}x, repeat=${this._behindRepeatCount}/${REPEAT_BACK_CORRECT_WINS}${refrainVerse ? ', refrain' : ''})`);
      return;
    }

    // Not behind — decay drift multiplier back toward 1.0 (faster recovery)
    this._driftMult = Math.max(1.0, this._driftMult - 0.15);
    this._behindRepeatCount = 0;
    this._behindRepeatAyah  = 0;

    // ── Rule 2: Different surah → Whisper detected a surah change ──────────
    if (!sameSurah) {
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;
      this._cancelReadAdvance();
      this._displaySurah = confirmedSurah;
      this._displayAyah  = confirmedAyah;
      this._ayahStartTime = Date.now();
      this._emitState(text, rms);
      this._scheduleReadAdvance(score);
      return;
    }

    // ── Rule 3: Whisper at display position → on track ──
    // Just log. Don't touch the timer — it's set from learned pace.
    // Whisper detecting NEXT ayah (Rule 4) drives the advance.
    if (confirmedAyah === this._displayAyah) {
      this._driftMult = 1.0;
      if (realMatch) this._sameAyahStreak++;
      if (this._displayAdvanceTimer && this._timerStartedAt) {
        const elapsed = Date.now() - this._timerStartedAt;
        const remaining = Math.max(0, this._nextAdvanceMs - elapsed);
        console.log(`[Pipeline] Whisper ${realMatch ? 'confirms' : 'noise→'} :${confirmedAyah} (${Math.round(remaining/1000)}s left, streak=${this._sameAyahStreak})`);
      } else {
        console.log(`[Pipeline] Whisper ${realMatch ? 'confirms' : 'noise→'} :${confirmedAyah} (streak=${this._sameAyahStreak})`);
        if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
          // No timer running (e.g. after BLOCKED released). Use full timer —
          // corrected is only for Whisper-driven gap=1 advances.
          this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
        }
      }
      this._emitState(text, rms);
      return;
    }

    // ── Rule 4: Whisper ahead of display ─────────────────────────────────
    // Gap 1–6: catch up smoothly. Consistently 1–2 behind = timer too slow; catch up at gap=1.
    // Large gap (7+): anchor likely confused — ignore.
    // IMPORTANT: Don't override user's manual pacer — if they recently clicked
    // Next to catch up at their own pace, let them control it.
    const gap = confirmedAyah - this._displayAyah;
    if (gap >= 1 && gap <= 6) {
      const inManualCooldown = this._lastManualAdjustMs && (Date.now() - this._lastManualAdjustMs) < MANUAL_ADJUST_COOLDOWN_MS;
      if (inManualCooldown) {
        console.log(`[Pipeline] Whisper :${confirmedAyah} ahead of display :${this._displayAyah} — skipping catch-up (manual pacer active)`);
        if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
          this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
        }
        this._emitState(text, rms);
        return;
      }
      // Gap 1: Whisper detected next ayah. But this data is ~6s old (4s capture
      // + 2s RTT), so the reciter is already partway through. Subtract pipeline
      // lag from the timer instead of using full duration.
      if (gap === 1) {
        this._cancelReadAdvance();
        this._displaySurah = confirmedSurah;
        this._displayAyah  = confirmedAyah;
        this._ayahStartTime = Date.now();
        this.state = { ...this.state, surah: confirmedSurah, ayah: confirmedAyah,
          lastLockedSurah: confirmedSurah, lastLockedAyah: confirmedAyah };
        this._emitState(text, rms);
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE), 0, CORRECTED_DURATION_FACTOR);
        return;
      }
      // Already in smooth catch-up — don't restart; rapid Whisper results would
      // otherwise cancel the timer and advance immediately, causing a 3-ayah jump.
      if (this._smoothAdvanceTimer) {
        this._emitState(text, rms);
        return;
      }
      this._cancelReadAdvance();
      // Larger gaps: slower step to avoid "skipping" through ayahs (e.g. 105+ in long surahs)
      const stepMs = gap >= 4 ? 2000 : gap >= 3 ? 1600 : SMOOTH_ADVANCE_STEP_MS;
      console.log(`[Pipeline] Whisper :${confirmedAyah} ahead of display :${this._displayAyah} — catch-up (${gap} steps, ${stepMs}ms/step)`);
      this._smoothAdvanceTo(confirmedSurah, confirmedAyah, stepMs);
    } else if (gap > 6) {
      console.log(`[Pipeline] Whisper :${confirmedAyah} jumped ${gap} ahead of display :${this._displayAyah} — anchor confused, ignoring`);
      if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
      }
      this._emitState(text, rms);
    }
  }

  _updateWpsClock(confirmedSurah, confirmedAyah) {
    const now = Date.now();
    const sameSurah = confirmedSurah === this._whisperLastConfirmSurah;

    if (sameSurah && confirmedAyah !== this._whisperLastConfirmAyah
        && this._whisperLastConfirmMs > 0) {
      const elapsedMs = now - this._whisperLastConfirmMs;
      if (elapsedMs > 2000) {
        const fromAyah = Math.min(this._whisperLastConfirmAyah, confirmedAyah);
        const toAyah   = Math.max(this._whisperLastConfirmAyah, confirmedAyah);
        let totalWords = 0;
        for (let a = fromAyah; a <= toAyah; a++) {
          const v = getVerseData(confirmedSurah, a, this.translationLang);
          totalWords += v?.transliteration
            ? v.transliteration.split(/\s+/).length
            : (v?.arabic ? v.arabic.split(/\s+/).length : 4);
        }
        const rawWps = totalWords / (elapsedMs / 1000);
        const clampedWps = Math.max(0.5, Math.min(5.0, rawWps));
        this._measuredWps = this._measuredWps * 0.3 + clampedWps * 0.7;
        console.log(`[Pipeline] Whisper clock: ${totalWords}w in ${(elapsedMs/1000).toFixed(1)}s = ${rawWps.toFixed(2)} wps → measured=${this._measuredWps.toFixed(2)} wps`);

        this._updatePace(clampedWps, now);
      }
    }

    if (sameSurah && confirmedAyah !== this._whisperLastConfirmAyah) {
      this._whisperLastConfirmMs    = now;
      this._whisperLastConfirmAyah  = confirmedAyah;
      this._whisperLastConfirmSurah = confirmedSurah;
    } else if (!sameSurah) {
      this._whisperLastConfirmMs    = now;
      this._whisperLastConfirmAyah  = confirmedAyah;
      this._whisperLastConfirmSurah = confirmedSurah;
      // Surah changed — reset pace history (different recitation section)
      this._paceHistory = [];
    }
  }

  _updatePace(rawWps, now) {
    this._paceHistory.push({ wps: rawWps, ts: now });
    if (this._paceHistory.length > 8) this._paceHistory.shift();

    // Classify current pace
    const wps = this._measuredWps;
    const cat = wps < 1.0 ? 'slow' : wps < 2.0 ? 'normal' : wps < 3.0 ? 'fast' : 'very-fast';

    // Detect trend: compare first half vs second half of history
    let trend = 0;
    if (this._paceHistory.length >= 4) {
      const mid = Math.floor(this._paceHistory.length / 2);
      const firstHalf  = this._paceHistory.slice(0, mid);
      const secondHalf = this._paceHistory.slice(mid);
      const avgFirst  = firstHalf.reduce((s, p) => s + p.wps, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((s, p) => s + p.wps, 0) / secondHalf.length;
      const delta = avgSecond - avgFirst;
      if (delta > 0.3)       trend = 1;   // accelerating
      else if (delta < -0.3) trend = -1;  // decelerating
    }

    const changed = cat !== this._paceCategory || trend !== this._paceTrend;
    this._paceCategory = cat;
    this._paceTrend    = trend;

    // Emit pace update (throttled to once per 3s to avoid flooding)
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

  // ── Timer: reading-pace advance (uncapped — Whisper corrects, never blocks) ─

  _canDisplayAdvance() {
    return this._displaySurah > 0 && this._displayAyah > 0
      && (this.state.mode === 'LOCKED' || this.state.mode === 'RESUMING' || this.state.mode === 'SEARCHING');
  }

  _scheduleReadAdvance(confidence, afterPauseMinMs = 0, durationFactor = 1.0) {
    this._cancelReadAdvance();
    if (!this._canDisplayAdvance()) return;

    // BLOCK display from racing ahead of Whisper. If display is already
    // too far ahead, wait for Whisper to catch up before scheduling more.
    // Force-unblock after BLOCKED_FORCE_UNBLOCK_MS to prevent freezing when
    // Whisper only returns noise (e.g. Ar-Rahman refrains).
    const nextAyah = this._displayAyah + 1;
    if (this._whisperAyah > 0 && (nextAyah - this._whisperAyah) > this._maxDisplayLead) {
      const now = Date.now();
      if (!this._blockedSince) this._blockedSince = now;
      const blockedFor = now - this._blockedSince;
      if (blockedFor < BLOCKED_FORCE_UNBLOCK_MS) {
        console.log(`[Pipeline] Display BLOCKED: :${this._displayAyah} (whisper :${this._whisperAyah}, lead=${this._displayAyah - this._whisperAyah}, ${Math.round(blockedFor/1000)}s) — waiting for Whisper`);
        return;
      }
      // Force-unblock: assume timer-based position is correct, catch up whisperAyah
      console.log(`[Pipeline] FORCE-UNBLOCK: :${this._displayAyah} blocked for ${Math.round(blockedFor/1000)}s — advancing whisper :${this._whisperAyah} → :${this._displayAyah}`);
      this._whisperSurah = this._displaySurah;
      this._whisperAyah  = this._displayAyah;
      this._blockedSince = 0;
    } else {
      this._blockedSince = 0;  // not blocked anymore
    }

    if (confidence < READ_ADVANCE_CONFIDENCE) {
      const lingeredMs = this._ayahStartTime ? Date.now() - this._ayahStartTime : 0;
      if (lingeredMs > 30000) {
        console.log(`[Pipeline] Low-conf stall ${confidence}% on ${this._displaySurah}:${this._displayAyah} for ${Math.round(lingeredMs/1000)}s — releasing lock`);
        this.state = { ...createState(), mode: 'SEARCHING',
          lastLockedSurah: this.state.surah, lastLockedAyah: this.state.ayah };
        this._resetSearchBuf();
        this._emitState(null, null);
        return;
      }
      // Low confidence — use READ_ADVANCE_CONFIDENCE as the confidence floor
      // so we still get the dynamic character-based timer, just slightly padded.
      confidence = READ_ADVANCE_CONFIDENCE;
    }

    const verse = getVerseData(this._displaySurah, this._displayAyah, this.translationLang);
    const translit = verse?.transliteration || '';
    const charCount = translit.length || (verse?.arabic ? verse.arabic.length : 30);
    const wordCount = Math.max(1, translit ? translit.split(/\s+/).length : (verse?.arabic ? verse.arabic.split(/\s+/).length : 4));

    // Elongation bonus: stretched syllables add recitation time.
    const strongElong = (translit.match(/AA|ee|oo|aa|ii|uu/gi) || []).length;
    const noonEndings = (translit.match(/oon|een|aan/gi) || []).length;
    const elongBonusMs = strongElong * 200 + noonEndings * 150;

    // Simple word-based timer derived from measured reciter pace.
    // Live data shows ~1.9s/word for slow reciters, ~0.9s for normal, ~0.5s for fast.
    // Whisper confirms hold/extend if reciter is still on the ayah.
    // Use learned pace if available, otherwise fallback defaults
    // Base default 1400ms/w. Fast/slow nudge it ±30%. Learned pace overrides.
    const defaultMsPerWord = this.fastMode ? 1000 : this.slowMode ? 1800 : 1400;
    // Need at least 3 samples before trusting learned pace — 1 sample is noise
    const msPerWord = (this._measuredMsPerWord > 0 && this._msPerWordSamples.length >= 3)
      ? this._measuredMsPerWord : defaultMsPerWord;
    const rawMs = wordCount * msPerWord + elongBonusMs;
    const floorMs = Math.max(afterPauseMinMs, this.slowMode ? 6000 : 2500);
    const baseDurationMs = Math.max(rawMs, floorMs);
    let durationMs = Math.min(Math.round(baseDurationMs), READ_ADVANCE_MAX_MS);
    if (durationFactor < 1.0) {
      // Whisper data is ~6s old. Subtract pipeline lag — but never more than half
      // the timer. Short ayahs (3-6 words) shouldn't get crushed to 2s.
      const PIPELINE_LAG_MS = 6000;
      const maxSubtract = Math.floor(durationMs * 0.5);
      durationMs = Math.max(3000, durationMs - Math.min(PIPELINE_LAG_MS, maxSubtract));
    }

    const modeTag = this.fastMode ? ' [FAST]' : this.slowMode ? ' [SLOW]' : '';
    const halfTag = durationFactor < 1.0 ? (durationFactor <= FIRST_LOCK_DURATION_FACTOR + 0.05 ? ' [first-lock]' : ' [corrected]') : '';
    console.log(`[Pipeline] Read-advance in ${durationMs}ms (${wordCount}w × ${msPerWord}ms/w, conf=${confidence}%${modeTag}${halfTag})`);

    this._nextAdvanceMs  = durationMs;
    this._timerStartedAt = Date.now();
    this._displayAdvanceTimer = setTimeout(() => {
      this._displayAdvanceTimer = null;
      this._nextAdvanceMs  = 0;
      this._timerStartedAt = 0;
      if (!this._canDisplayAdvance()) return;

      const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1, this.translationLang);
      if (!nextAyahData) {
        const prevSurah = this._displaySurah;
        const prevAyah  = this._displayAyah;
        this._completedSurah = prevSurah;
        this._driftMult    = 1.0;
        this._measuredWps  = READ_WORDS_PER_SEC;
        this._behindRepeatCount = 0;
        this._behindRepeatAyah  = 0;
        this._sameAyahStreak = 0;
        this._bumpCountForAyah = 0;
        // Jump to next surah ayah 1 and keep advancing while searching
        const nextSurah = prevSurah < 114 ? prevSurah + 1 : 0;
        const nextSurahData = nextSurah > 0 ? getVerseData(nextSurah, 1, this.translationLang) : null;
        if (nextSurahData && prevSurah !== 1) {
          // Pre-display next surah:1, stay LOCKED, let Whisper correct if wrong
          this._displaySurah = nextSurah;
          this._displayAyah  = 1;
          this._whisperSurah = nextSurah;
          this._whisperAyah  = 1;
          this._ayahStartTime = Date.now();
          this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
            surah: nextSurah, ayah: 1,
            lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
          console.log(`[Pipeline] End of surah ${prevSurah} → pre-display ${nextSurah}:1`);
          this._scheduleReadAdvance(Math.max(this.state.confidence, 50));
        } else {
          this._displaySurah = 0;
          this._displayAyah  = 0;
          this._whisperSurah = 0;
          this._whisperAyah  = 0;
          this.state = { ...createState(), mode: 'SEARCHING',
            lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
          this._resetSearchBuf();
          console.log(`[Pipeline] End of surah ${prevSurah} — searching for next`);
        }
        this._restorePreRukuIfNeeded(prevSurah);
      } else {
        // Don't learn pace from auto-advance — only manual clicks are ground truth
        this._sameAyahStreak = 0;
        this._bumpCountForAyah = 0;
        this._displayAyah++;
        this._ayahStartTime = Date.now();
        this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
          lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        console.log(`[Pipeline] Read-advance → ${this._displaySurah}:${this._displayAyah}`);
      }
      // Emit immediately so display updates snappily; schedule next timer after.
      this._emitState(null, null);
      if (nextAyahData) {
        this._scheduleReadAdvance(this.state.confidence);
      }
    }, durationMs);
  }

  // ── Pause-triggered advance ────────────────────────────────────────────────

  _triggerPauseAdvance() {
    if (!this._canDisplayAdvance()) return;

    // Don't advance on pauses when confidence is low — we may not even be
    // on the right ayah, so detecting silence as "inter-ayah pause" is unreliable.
    if (this.state.confidence < READ_ADVANCE_CONFIDENCE) return;

    this._lastPauseAdvanceMs = Date.now();
    const from = `${this._displaySurah}:${this._displayAyah}`;
    this._cancelReadAdvance();
    this._ayahStartTime = Date.now();

    const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1, this.translationLang);
    if (!nextAyahData) {
      const prevSurah = this._displaySurah;
      const prevAyah  = this._displayAyah;
      this._completedSurah = prevSurah;
      this._displaySurah = 0;
      this._displayAyah  = 0;
      this._whisperSurah = 0;
      this._whisperAyah  = 0;
      this._driftMult    = 1.0;
      this._measuredWps  = READ_WORDS_PER_SEC;
      this._behindRepeatCount = 0;
      this._behindRepeatAyah  = 0;
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;
      this.state = { ...createState(), mode: 'SEARCHING',
        lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
      this._restorePreRukuIfNeeded(prevSurah);
      this._resetSearchBuf();
      console.log(`[Pipeline] Pause-advance: end of surah ${prevSurah} — soft reset, searching for next`);
    } else {
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;
      this._displayAyah++;
      this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
        lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
      console.log(`[Pipeline] Pause-advance: ${from} → ${this._displaySurah}:${this._displayAyah}`);
      this._scheduleReadAdvance(this.state.confidence, PAUSE_COOLDOWN_MS);
    }
    this._emitState(null, null);
  }

  // ── Smooth catch-up: step display forward one ayah at a time ───────────────

  _smoothAdvanceTo(targetSurah, targetAyah, stepMs) {
    const interval = stepMs || SMOOTH_ADVANCE_STEP_MS;
    this._smoothAdvanceTimer = null;
    if (!this._canDisplayAdvance()) return;

    if (this._displaySurah === targetSurah && this._displayAyah === targetAyah) {
      this._scheduleReadAdvance(this.state.confidence, 0, CORRECTED_DURATION_FACTOR);
      return;
    }
    if (this._displaySurah > targetSurah ||
        (this._displaySurah === targetSurah && this._displayAyah > targetAyah)) {
      this._scheduleReadAdvance(this.state.confidence, 0, CORRECTED_DURATION_FACTOR);
      return;
    }

    // Advance display only — don't use transition() which would push the anchor
    // state past the Whisper-confirmed position. The anchor state already points
    // to the target; we're just animating the display to catch up.
    this._sameAyahStreak = 0;
    this._bumpCountForAyah = 0;
    this._displayAyah++;
    this._ayahStartTime = Date.now();
    // Keep anchor state in sync with display for surah-end detection
    this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
      lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
    this._emitState(null, null);

    this._smoothAdvanceTimer = setTimeout(
      () => this._smoothAdvanceTo(targetSurah, targetAyah, interval),
      interval
    );
  }

  _cancelReadAdvance() {
    if (this._displayAdvanceTimer) { clearTimeout(this._displayAdvanceTimer); this._displayAdvanceTimer = null; }
    if (this._smoothAdvanceTimer)  { clearTimeout(this._smoothAdvanceTimer);  this._smoothAdvanceTimer  = null; }
    this._nextAdvanceMs  = 0;
    this._timerStartedAt = 0;
    this._pauseAccumMs   = 0;
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  _emitTaraweeh() {
    this.onStateUpdate({
      type: 'taraweeh',
      position: this._taraweehPos,
      rakat: this._rakatCount,
    });
  }

  // Taraweeh takbeer state machine: QIYAM → RUKU → up → SAJDA → up → SAJDA → up → resume
  // Sound/distortion may cause missed takbeers — recitation (lock/candidate) always wins and
  // transitions to QIYAM. Takbeer advances best-effort; we never block verse display.
  _handleTaraweehTakbeer(fromLocked = false) {
    const savePreRuku = (surah, ayah) => {
      if (surah > 1) {
        this._preRukuSurah = surah;
        this._preRukuAyah  = ayah;
        console.log(`[Pipeline] Saved pre-ruku position: ${this._preRukuSurah}:${this._preRukuAyah}`);
      }
    };

    if (this._taraweehPos === 'RUKU') {
      this._taraweehPos = 'QIYAM';
      this._taraweehLastFrom = 'ruku';
      console.log(`[Pipeline] Taraweeh takbeer: RUKU → up (QIYAM)`);
      this._resetSearchBuf();
    } else if (this._taraweehPos === 'SAJDA') {
      this._taraweehPos = 'QIYAM';
      if (this._sajdaCount === 1) {
        this._taraweehLastFrom = 'sajda1';
        console.log(`[Pipeline] Taraweeh takbeer: SAJDA (1st) → up (QIYAM)`);
      } else {
        this._taraweehLastFrom = 'sajda2';
        this._sajdaCount = 0;
        // Restore pre-ruku so anchor searches for continuation (resume same surah)
        if (this._preRukuSurah > 1) {
          this.state = { ...this.state, lastLockedSurah: this._preRukuSurah, lastLockedAyah: this._preRukuAyah };
          console.log(`[Pipeline] Taraweeh takbeer: SAJDA (2nd) → up, ready for resume from ${this._preRukuSurah}:${this._preRukuAyah}`);
        } else {
          console.log(`[Pipeline] Taraweeh takbeer: SAJDA (2nd) → up (QIYAM), ready for new surah`);
        }
      }
      this._resetSearchBuf();
    } else if (this._taraweehPos === 'QIYAM') {
      // ruku/sajda1 → next is SAJDA; reciting/sajda2/unknown → next is RUKU
      // (unknown = missed takbeers; assume we were reciting)
      const nextIsSajda = this._taraweehLastFrom === 'ruku' || this._taraweehLastFrom === 'sajda1';
      if (nextIsSajda) {
        this._taraweehPos = 'SAJDA';
        this._sajdaCount = this._taraweehLastFrom === 'ruku' ? 1 : 2;
        this._taraweehLastFrom = null;
        console.log(`[Pipeline] Taraweeh takbeer: QIYAM → SAJDA (${this._sajdaCount}/2)`);
        this._cancelReadAdvance();
        this._displaySurah = 0;
        this._displayAyah  = 0;
        this._whisperSurah = 0;
        this._whisperAyah  = 0;
        this._driftMult    = 1.0;
        this.state = { ...createState(), lastLockedSurah: 0, lastLockedAyah: 0 };
        this._resetSearchBuf();
      } else {
        // reciting or sajda2 or unknown → RUKU
        const surah = fromLocked ? this.state.surah : this.state.lastLockedSurah;
        const ayah  = fromLocked ? this.state.ayah  : this.state.lastLockedAyah;
        savePreRuku(surah, ayah);
        this._taraweehPos = 'RUKU';
        this._rakatCount++;
        this._taraweehLastFrom = null;
        console.log(`[Pipeline] Taraweeh takbeer: QIYAM → RUKU (rakat ${this._rakatCount})`);
        this._cancelReadAdvance();
        this._displaySurah = 0;
        this._displayAyah  = 0;
        this._whisperSurah = 0;
        this._whisperAyah  = 0;
        this._driftMult    = 1.0;
        this.state = { ...createState(), lastLockedSurah: 0, lastLockedAyah: 0 };
        this._resetSearchBuf();
      }
    }
    this._emitTaraweeh();
  }

  _restorePreRukuIfNeeded(completedSurah) {
    if (this.taraweehMode && completedSurah === 1
        && this._preRukuSurah > 1) {
      this.state.lastLockedSurah = this._preRukuSurah;
      this.state.lastLockedAyah  = this._preRukuAyah;
      console.log(`[Pipeline] Taraweeh: Fatiha done → resuming from ${this._preRukuSurah}:${this._preRukuAyah}`);
    } else if (this.taraweehMode && completedSurah === 1) {
      console.log(`[Pipeline] Taraweeh: Fatiha done but preRuku not set (${this._preRukuSurah}:${this._preRukuAyah}) — anchor will search`);
    }
  }

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

    const topMatch    = this.state._matches?.[0];
    const secondMatch = this.state._matches?.[1];
    const topScore    = topMatch?.score ?? 0;
    const topMargin   = secondMatch ? Math.round((topScore - secondMatch.score) * 100) : 100;
    const SHOW_THRESHOLD = 0.35;
    const SHOW_MARGIN    = 5;
    const isCandidate = !isDisplayable && this.state.mode === 'SEARCHING'
      && topScore >= SHOW_THRESHOLD
      && topMargin >= SHOW_MARGIN;

    // Use display position for LOCKED/PAUSED/RESUMING, candidate for SEARCHING, or user browsing
    const displaySurah = isDisplayable ? this._displaySurah
      : (this._userSearchingDisplay && this._displaySurah) ? this._displaySurah
      : (isCandidate ? topMatch.surah : 0);
    const displayAyah  = isDisplayable ? this._displayAyah
      : (this._userSearchingDisplay && this._displayAyah) ? this._displayAyah
      : (isCandidate ? topMatch.ayah : 0);
    const lockedVerse   = (displaySurah && displayAyah)
      ? getVerseData(displaySurah, displayAyah, this.translationLang)
      : null;

    if (this.state.mode === 'LOCKED') {
      console.log(`[Emit] LOCKED ${displaySurah}:${displayAyah} "${(lockedVerse?.translation || '').substring(0, 50)}"`);
      this._completedSurah = 0;
      // Persist position for restart recovery
      _savePosition(displaySurah, displayAyah, this._measuredMsPerWord);
    } else if (isCandidate) {
      console.log(`[Emit] CANDIDATE ${topMatch.surah}:${topMatch.ayah} score=${topScore.toFixed(2)} "${(lockedVerse?.translation || '').substring(0, 50)}"`);
    }

    const candidates = (this.state._matches || []).map(m => ({
      surah: m.surah, ayah: m.ayah, score: +(m.score || 0).toFixed(3),
      arabic: m.arabic?.substring(0, 60),
      matchedWords: m.matchedWords || [],
    }));

    const timerMs = (this._displayAdvanceTimer && this._timerStartedAt)
      ? Math.max(0, (this._nextAdvanceMs || 0) - (Date.now() - this._timerStartedAt))
      : 0;

    this.onStateUpdate({
      type: 'state',
      state: {
        mode: this.state.mode,
        surah: lockedVerse?.surah ?? (displaySurah || this.state.surah),
        ayah:  lockedVerse?.ayah  ?? (displayAyah  || this.state.ayah),
        surahName:       lockedVerse?.surahName,
        ayahTotal:       lockedVerse?.ayahTotal,
        arabic:          lockedVerse?.arabic,
        transliteration: lockedVerse?.transliteration,
        translation:     lockedVerse?.translation,
        translationGlasses: lockedVerse?.translationGlasses ?? lockedVerse?.translation,
        confidence: this.state.confidence <= 1
          ? this.state.confidence
          : (this.state.confidence || 0) / 100,
        timerMs: timerMs || undefined,
        isCandidate:     isCandidate || false,
        candidateScore:  isCandidate ? Math.round(topScore * 100) : undefined,
        candidateMargin: isCandidate ? topMargin : undefined,
        completedSurah:     this._completedSurah || undefined,
        completedSurahName: this._completedSurah
          ? (getVerseData(this._completedSurah, 1, this.translationLang)?.surahName ?? `Surah ${this._completedSurah}`)
          : undefined,
        userSearching:   !!this._userSearchingDisplay,
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
}
