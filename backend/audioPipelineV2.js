import { transcribe } from './transcriptionRouter.js';
import { processWhisperResult, transition, createState } from './anchorStateMachine.js';
import { getVerseData } from './verseData.js';
import { probeWhisperEndpoint } from './whisperProvider.js';
import { isRefrain } from './keywordMatcher.js';

const SAMPLE_RATE      = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS     = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

const SEARCH_WINDOWS_MS = [10000, 15000, 20000, 30000];
const MAX_SEARCH_BUF_MS = 35000;

const LOCKED_MIN_MS    = parseInt(process.env.LOCKED_MIN_MS    || '10000', 10);
const LOCKED_MAX_MS    = parseInt(process.env.LOCKED_MAX_MS    || '15000', 10);
const LOCKED_MIN_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MIN_MS);
const LOCKED_MAX_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MAX_MS);

const SILENCE_THRESHOLD        = parseFloat(process.env.SILENCE_THRESHOLD        || '0.005');
const READ_ADVANCE_CONFIDENCE  = parseInt(process.env.READ_ADVANCE_CONFIDENCE    || '40',    10);
const READ_WORDS_PER_SEC       = parseFloat(process.env.READ_WORDS_PER_SEC       || '1.5');
const READ_ADVANCE_MIN_MS      = parseInt(process.env.READ_ADVANCE_MIN_MS        || '4000',  10);
const READ_ADVANCE_MAX_MS      = parseInt(process.env.READ_ADVANCE_MAX_MS        || '15000', 10);
const SMOOTH_ADVANCE_STEP_MS   = parseInt(process.env.SMOOTH_ADVANCE_STEP_MS     || '1200',  10);

const PAUSE_ANALYSIS_MS    = parseInt(process.env.PAUSE_ANALYSIS_MS   || '250',  10);
const PAUSE_ANALYSIS_BYTES = Math.floor(BYTES_PER_MS * PAUSE_ANALYSIS_MS);
const PAUSE_THRESHOLD      = parseFloat(process.env.PAUSE_THRESHOLD   || '0.005');
const PAUSE_ADVANCE_MS     = parseInt(process.env.PAUSE_ADVANCE_MS    || '2500', 10);
const PAUSE_COOLDOWN_MS    = parseInt(process.env.PAUSE_COOLDOWN_MS   || '6000', 10);

const BASE_DISPLAY_LEAD = 2;

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
  'اشتركوا في القناة', 'اشتركوا في', 'اشترك في القناة',
  'شكرا للمشاهدة', 'شكرا لمشاهدتكم',
];

const ISTI_ADHA_PATTERNS = [
  /اعوذ\s+بالله/,
  /أعوذ\s+بالله/,
  /اعوذ\s+ب/,
  /الشيطان\s+الرجيم/,
  /^بسم\s+الله\s+الرحمن\s+الرحيم/,
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
function applyClipGuard(pcm, rms) {
  if (rms <= CLIP_THRESHOLD) return pcm;
  const gain = CLIP_TARGET / rms;
  const out  = Buffer.alloc(pcm.length);
  const n    = Math.floor(pcm.length / 2);
  for (let i = 0; i < n * 2; i += 2) {
    const s = pcm.readInt16LE(i);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * gain))), i);
  }
  console.log(`[Pipeline] Audio normalize: rms=${rms.toFixed(3)} → ${CLIP_TARGET} (gain=${gain.toFixed(3)})`);
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

const TAKBEER_RE = /^الله\s+(ال)?[اأآ]كبا?ر/u;
function isTakbeer(text) {
  if (!text) return false;
  const n = text.replace(/[\u064b-\u065f\u0670\u0640]/g, '').trim();
  return TAKBEER_RE.test(n);
}

// ── AudioPipeline class ───────────────────────────────────────────────────────

export class AudioPipeline {
  constructor({ onStateUpdate, onStatus, onError, preferredSurah = 0, hfToken }) {
    this.onStateUpdate  = onStateUpdate;
    this.onStatus       = onStatus || (() => {});
    this.onError        = onError  || (() => {});
    this.preferredSurah = preferredSurah;
    this.hfToken        = hfToken;

    this.state     = createState();
    this.active    = false;
    this.processing = false;

    this._completedSurah = 0;

    // Dual position model: Whisper = ground truth, display = animation
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;

    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;
    this._searchGen    = 0;

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

    this.fastMode = false;

    this._measuredWps            = READ_WORDS_PER_SEC;
    this._whisperLastConfirmMs   = 0;
    this._whisperLastConfirmAyah = 0;
    this._whisperLastConfirmSurah = 0;

    this._behindRepeatAyah  = 0;    // tracks consecutive behind-reports on same ayah
    this._behindRepeatCount = 0;    // how many times in a row
    this._driftMult         = 1.0;  // >1.0 = display running ahead, slows timer gradually

    // Pace tracking: rolling window of recent WPS samples for trend detection
    this._paceHistory    = [];   // [{wps, ts}] — last 8 measurements
    this._paceCategory   = '';   // 'slow' | 'normal' | 'fast' | 'very-fast'
    this._paceTrend      = 0;   // -1 decelerating, 0 steady, +1 accelerating
    this._lastPaceEmitMs = 0;

    this.taraweehMode    = false;
    this._taraweehPos    = 'QIYAM';
    this._rakatCount     = 0;
    this._preRukuSurah   = 0;
    this._preRukuAyah    = 0;

    probeWhisperEndpoint(this.hfToken, this.onStatus).catch(() => {});
  }

  get _maxDisplayLead() {
    if (this.fastMode) return BASE_DISPLAY_LEAD + 1;
    if (this._paceCategory === 'fast' || this._paceCategory === 'very-fast') return BASE_DISPLAY_LEAD + 1;
    return BASE_DISPLAY_LEAD;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setFastMode(enabled) {
    this.fastMode = !!enabled;
    console.log(`[Pipeline] Fast mode ${this.fastMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'fast_mode', enabled: this.fastMode });
  }

  setTaraweehMode(enabled) {
    this.taraweehMode = !!enabled;
    if (!this.taraweehMode) { this._taraweehPos = 'QIYAM'; this._rakatCount = 0; }
    console.log(`[Pipeline] Taraweeh mode ${this.taraweehMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'taraweeh_mode', enabled: this.taraweehMode,
      position: this._taraweehPos, rakat: this._rakatCount });
  }

  resetRakat() {
    this._rakatCount = 0;
    this._taraweehPos = 'QIYAM';
    this._emitTaraweeh();
  }

  setPreferredSurah(s) { this.preferredSurah = s; }

  start() {
    if (this.active) {
      console.log('[Pipeline] Already active — ignoring duplicate start');
      return;
    }
    this._cancelReadAdvance();
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
    const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1);
    if (!nextAyahData) {
      const prevSurah = this._displaySurah;
      this._completedSurah = prevSurah;
      this._restorePreRukuIfNeeded(prevSurah);
      this.state = { ...createState(), mode: 'SEARCHING', lastLockedSurah: 0, lastLockedAyah: 0 };
      this._resetSearchBuf();
    } else {
      this._displayAyah++;
      this._whisperAyah = Math.max(this._whisperAyah, this._displayAyah);
      this._ayahStartTime = Date.now();
      this._lastManualAdjustMs = Date.now();
      this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
        lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
      this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
    }
    this._emitState(null, null);
  }

  manualPrev() {
    this._cancelReadAdvance();
    if (this._displayAyah > 1) {
      this._displayAyah--;
    }
    this._whisperAyah = this._displayAyah;
    this._ayahStartTime = Date.now();
    this._lastManualAdjustMs = Date.now();
    this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
      lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
    this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
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
    this._cancelReadAdvance();
    this._resetSearchBuf();
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

      if (this._lockedBuf.length > LOCKED_MAX_BYTES) {
        this._lockedBuf = this._lockedBuf.subarray(this._lockedBuf.length - LOCKED_MAX_BYTES);
      }

      if (this._lockedBuf.length >= LOCKED_MIN_BYTES && !this.processing) {
        const chunk = Buffer.from(this._lockedBuf);
        this._lockedBuf = Buffer.alloc(0);
        this._lastLockedCall = Date.now();
        this._processLockedChunk(chunk);
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
        const result = await transcribe(audioToSend, this.hfToken, this.onStatus);
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

      if (this.taraweehMode && isTakbeer(cleaned)) {
        console.log(`[Pipeline] Taraweeh takbeer detected (pos=${this._taraweehPos})`);
        if (!stale()) {
          if (this._taraweehPos === 'QIYAM') {
            if (this.state.lastLockedSurah > 1) {
              this._preRukuSurah = this.state.lastLockedSurah;
              this._preRukuAyah  = this.state.lastLockedAyah;
              console.log(`[Pipeline] Saved pre-ruku position: ${this._preRukuSurah}:${this._preRukuAyah}`);
            }
            this._taraweehPos = 'RUKU';
            this._rakatCount++;
            this._cancelReadAdvance();
            this._displaySurah = 0;
            this._displayAyah  = 0;
            this._whisperSurah = 0;
            this._whisperAyah  = 0;
            this._driftMult    = 1.0;
            this.state = { ...createState(), lastLockedSurah: 0, lastLockedAyah: 0 };
            this._resetSearchBuf();
          } else {
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

      this.state = processWhisperResult(cleaned, this.state, { preferredSurah: this.preferredSurah, fastMode: this.fastMode });

      this._emitMatchProgress(text, rms, bufMs);

      if (this.state.mode === 'LOCKED') {
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
          this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
            lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        } else {
          console.log(`[Pipeline] LOCKED on ${this.state.surah}:${this.state.ayah} after ${bufMs}ms`);
          this._displaySurah = this.state.surah;
          this._displayAyah  = this.state.ayah;
        }

        this._ayahStartTime = Date.now();
        this._measuredWps            = READ_WORDS_PER_SEC;
        this._whisperLastConfirmMs   = Date.now();
        this._whisperLastConfirmAyah = this.state.ayah;
        this._whisperLastConfirmSurah = this.state.surah;

        this._scheduleReadAdvance(this.state.confidence);
        this._emitState(text, rms);
        return;
      } else {
        // If we have a strong pending candidate and the display isn't running yet,
        // start the timer immediately — don't wait for a perfect lock. The reciter
        // keeps going and we need to keep up. If the anchor corrects later, we adjust.
        const pending = this.state._pendingMatch;
        const topMatch = this.state._matches?.[0];
        const pendingScore = topMatch?.score ?? 0;
        const uniqueWords = new Set(topMatch?.matchedWords || []).size;
        const secondScore = this.state._matches?.[1]?.score ?? 0;
        const margin = Math.round((pendingScore - secondScore) * 100);
        if (pending && pendingScore >= 0.40 && uniqueWords >= 3 && margin >= 10 && this._displayAyah === 0) {
          console.log(`[Pipeline] Strong candidate ${pending.surah}:${pending.ayah} (score=${(pendingScore*100).toFixed(0)}%, ${uniqueWords}uw, margin=${margin}) — starting display`);
          this._displaySurah = pending.surah;
          this._displayAyah  = pending.ayah;
          this._whisperSurah = pending.surah;
          this._whisperAyah  = pending.ayah;
          this._ayahStartTime = Date.now();
          this._measuredWps = READ_WORDS_PER_SEC;
          this._whisperLastConfirmMs = Date.now();
          this._whisperLastConfirmAyah = pending.ayah;
          this._whisperLastConfirmSurah = pending.surah;
          this._scheduleReadAdvance(Math.round(pendingScore * 100));
        }
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
        const result = await transcribe(audioToSend, this.hfToken, this.onStatus);
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

      if (this.taraweehMode && isTakbeer(cleaned)) {
        if (this.state.surah > 1) {
          this._preRukuSurah = this.state.surah;
          this._preRukuAyah  = this.state.ayah;
        }
        console.log(`[Pipeline] Taraweeh takbeer (LOCKED→RUKU) saved=${this._preRukuSurah}:${this._preRukuAyah}`);
        this._taraweehPos = 'RUKU';
        this._rakatCount++;
        this._cancelReadAdvance();
        this._displaySurah = 0;
        this._displayAyah  = 0;
        this._whisperSurah = 0;
        this._whisperAyah  = 0;
        this._driftMult    = 1.0;
        this.state = { ...createState(), lastLockedSurah: 0, lastLockedAyah: 0 };
        this._resetSearchBuf();
        this._emitTaraweeh();
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

      // Hallucination guard: same text 3x in a row → skip
      this._lastTexts.push(cleaned);
      if (this._lastTexts.length > 3) this._lastTexts.shift();
      if (this._lastTexts.length >= 3 && this._lastTexts.every(t => t === cleaned)) {
        console.log(`[Pipeline] Repeated hallucination — skipping`);
        this.processing = false;
        return;
      }

      const prevSurah = this.state.surah;
      const anchorResult = processWhisperResult(cleaned, this.state, { preferredSurah: this.preferredSurah, fastMode: this.fastMode });

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
        const minAnchorAyah = Math.max(1, this._displayAyah - 2);
        if (anchorResult.surah === this._displaySurah && anchorResult.ayah < minAnchorAyah) {
          anchorResult = { ...anchorResult, ayah: minAnchorAyah };
        }
        this.state = anchorResult;
        this._onWhisperConfirm(anchorResult.surah, anchorResult.ayah, anchorResult.confidence, text, rms);
      }
    } catch (err) {
      console.error('[Pipeline] Locked chunk error:', err.message);
    }
    this.processing = false;
  }

  // ── Core V2: single handler for Whisper confirmations in LOCKED mode ───────

  _onWhisperConfirm(confirmedSurah, confirmedAyah, score, text, rms) {
    const sameSurah = confirmedSurah === this._displaySurah;

    // ── Always ratchet _whisperAyah forward (never backward) ───────────────
    if (!sameSurah || confirmedAyah > this._whisperAyah) {
      this._updateWpsClock(confirmedSurah, confirmedAyah);
      this._whisperSurah = confirmedSurah;
      this._whisperAyah  = confirmedAyah;
    }

    // ── Rule 1: Whisper behind display ─────────────────────────────────
    // Gradually slow the timer so the reciter catches up — no snapping.
    // Repeat detection (3x same ayah, non-refrain) for genuine repeats.
    if (sameSurah && confirmedAyah < this._displayAyah) {
      const refrainVerse = isRefrain(confirmedSurah, confirmedAyah);
      const lag = this._displayAyah - confirmedAyah;

      // ── Repeat tracking (genuine reciter repeats, not stale audio) ───
      if (!refrainVerse && confirmedAyah === this._behindRepeatAyah && score >= READ_ADVANCE_CONFIDENCE) {
        this._behindRepeatCount++;
      } else {
        this._behindRepeatAyah  = confirmedAyah;
        this._behindRepeatCount = refrainVerse ? 0 : 1;
      }

      if (this._behindRepeatCount >= 3) {
        this._cancelReadAdvance();
        this._displayAyah  = confirmedAyah;
        this._driftMult    = 1.0;
        this._ayahStartTime = Date.now();
        this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
          lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        console.log(`[Pipeline] Reciter repeat detected: display → :${confirmedAyah} (${this._behindRepeatCount}x, conf=${score}%)`);
        this._behindRepeatCount = 0;
        this._behindRepeatAyah  = 0;
        this._emitState(text, rms);
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
        return;
      }

      // ── Gradual slow-down: increase drift multiplier each time ───────
      // Each behind-report bumps the multiplier by 15%, making subsequent
      // timers progressively longer. This lets the reciter catch up without
      // any jarring snap. Caps at 2.0× (double the normal timer).
      if (score >= READ_ADVANCE_CONFIDENCE) {
        this._driftMult = Math.min(2.5, this._driftMult + 0.15);
      }

      console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} (lag=${lag}, conf=${score}%, drift=${this._driftMult.toFixed(2)}x, repeat=${this._behindRepeatCount}/3${refrainVerse ? ', refrain' : ''})`);
      return;
    }

    // Not behind — decay drift multiplier back toward 1.0
    this._driftMult = Math.max(1.0, this._driftMult - 0.10);
    this._behindRepeatCount = 0;
    this._behindRepeatAyah  = 0;

    // ── Rule 2: Different surah → Whisper detected a surah change ──────────
    if (!sameSurah) {
      this._cancelReadAdvance();
      this._displaySurah = confirmedSurah;
      this._displayAyah  = confirmedAyah;
      this._ayahStartTime = Date.now();
      this._emitState(text, rms);
      this._scheduleReadAdvance(score);
      return;
    }

    // ── Rule 3: Whisper at display position → confirm, keep timer running ──
    // Display is already advancing on its timer. Whisper catching up just
    // confirms we're on track. Reset drift — we're synced.
    if (confirmedAyah === this._displayAyah) {
      this._driftMult = 1.0;
      console.log(`[Pipeline] Whisper confirms :${confirmedAyah} = display (conf=${score}%) — on track`);
      if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
      }
      return;
    }

    // ── Rule 4: Whisper ahead of display ─────────────────────────────────
    // Small-medium gap (1-6 ayahs): catch up smoothly. Short ayahs in surahs
    // like Al-Waqi'ah can cover 5-6 verses in a single Whisper window.
    // Large gap (7+): anchor likely confused — ignore.
    const gap = confirmedAyah - this._displayAyah;
    if (gap <= 6) {
      this._cancelReadAdvance();
      this._lastManualAdjustMs = 0;
      console.log(`[Pipeline] Whisper :${confirmedAyah} ahead of display :${this._displayAyah} — catch-up (${gap} steps)`);
      this._smoothAdvanceTo(confirmedSurah, confirmedAyah, SMOOTH_ADVANCE_STEP_MS);
    } else {
      console.log(`[Pipeline] Whisper :${confirmedAyah} jumped ${gap} ahead of display :${this._displayAyah} — anchor confused, ignoring`);
      if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
      }
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
          const v = getVerseData(confirmedSurah, a);
          totalWords += v?.transliteration
            ? v.transliteration.split(/\s+/).length
            : (v?.arabic ? v.arabic.split(/\s+/).length : 4);
        }
        const rawWps = totalWords / (elapsedMs / 1000);
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

  _scheduleReadAdvance(confidence, afterPauseMinMs = 0) {
    this._cancelReadAdvance();
    if (!this._canDisplayAdvance()) return;

    // Informational: log when display is running ahead of Whisper (no blocking)
    const nextAyah = this._displayAyah + 1;
    if (this._whisperAyah > 0 && (nextAyah - this._whisperAyah) > this._maxDisplayLead) {
      console.log(`[Pipeline] Display ahead: :${this._displayAyah} (whisper :${this._whisperAyah}, lead=${this._displayAyah - this._whisperAyah}) — continuing`);
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

    const verse = getVerseData(this._displaySurah, this._displayAyah);
    const translit = verse?.transliteration || '';
    const charCount = translit.length || (verse?.arabic ? verse.arabic.length : 30);
    const wordCount = translit ? translit.split(/\s+/).length : (verse?.arabic ? verse.arabic.split(/\s+/).length : 4);

    // Elongation bonus: stretched syllables add recitation time.
    // Doubled vowels (AA, oo, ee) = strong madd (~200ms each).
    // Terminal nasalized endings (oon, een, aan) = held vowel + noon (~150ms each).
    const strongElong = (translit.match(/AA|ee|oo|aa|ii|uu/gi) || []).length;
    const noonEndings = (translit.match(/oon|een|aan/gi) || []).length;
    const elongBonusMs = strongElong * 200 + noonEndings * 150;

    // Base: ~10 chars/sec normal, ~12 chars/sec fast. Whisper-measured pace
    // scales this: if reciter is at 2× default wps, we halve the time.
    const baseWps = this._measuredWps || READ_WORDS_PER_SEC;
    const paceRatio = baseWps / READ_WORDS_PER_SEC;
    const trendMult = this._paceTrend > 0 ? 1.10 : this._paceTrend < 0 ? 0.90 : 1.0;
    const baseCps = (this.fastMode ? 14 : 11) * paceRatio * trendMult;
    const rawMs = Math.round(((charCount / baseCps) * 1000) + elongBonusMs) * 1.2;

    // Dynamic floor: scales with character count so short ayahs (15ch) get ~3.5s
    // and long ayahs (60ch) get ~5.5s. Prevents both racing on short verses
    // and unnecessary padding on long ones.
    const dynamicFloor = this.fastMode
      ? Math.round(2500 + charCount * 50)   // 15ch→3250, 30ch→4000, 50ch→5000
      : Math.round(3500 + charCount * 50);   // 15ch→4250, 30ch→5000, 50ch→6000
    const floorMs = Math.max(dynamicFloor, READ_ADVANCE_MIN_MS);
    const minMs   = Math.max(floorMs, afterPauseMinMs);
    const baseDurationMs = Math.min(Math.max(rawMs, minMs), READ_ADVANCE_MAX_MS);
    const durationMs = Math.round(baseDurationMs * this._driftMult);

    const trendTag = this._paceTrend !== 0 ? ` trend=${this._paceTrend > 0 ? '+' : '-'}` : '';
    const driftTag = this._driftMult > 1.01 ? ` drift=${this._driftMult.toFixed(2)}x` : '';
    const modeTag = this.fastMode ? ' [FAST]' + trendTag + driftTag : trendTag + driftTag;
    console.log(`[Pipeline] Read-advance in ${durationMs}ms (${charCount}ch ${wordCount}w +${elongBonusMs}ms elong, conf=${confidence}%${modeTag})`);

    this._nextAdvanceMs  = durationMs;
    this._timerStartedAt = Date.now();
    this._displayAdvanceTimer = setTimeout(() => {
      this._displayAdvanceTimer = null;
      this._nextAdvanceMs  = 0;
      this._timerStartedAt = 0;
      if (!this._canDisplayAdvance()) return;

      const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1);
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
        this.state = { ...createState(), mode: 'SEARCHING',
          lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
        // Taraweeh: if Fatiha just ended, restore pre-ruku position so the
        // anchor looks for the continuation surah, not surah 2.
        this._restorePreRukuIfNeeded(prevSurah);
        this._resetSearchBuf();
        console.log(`[Pipeline] Read-advance: end of surah ${prevSurah} — soft reset, searching for next`);
      } else {
        this._displayAyah++;
        this._ayahStartTime = Date.now();
        this.state = { ...this.state, surah: this._displaySurah, ayah: this._displayAyah,
          lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
        console.log(`[Pipeline] Read-advance → ${this._displaySurah}:${this._displayAyah}`);
        this._scheduleReadAdvance(this.state.confidence);
      }
      this._emitState(null, null);
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

    const nextAyahData = getVerseData(this._displaySurah, this._displayAyah + 1);
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
      this.state = { ...createState(), mode: 'SEARCHING',
        lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
      this._restorePreRukuIfNeeded(prevSurah);
      this._resetSearchBuf();
      console.log(`[Pipeline] Pause-advance: end of surah ${prevSurah} — soft reset, searching for next`);
    } else {
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
      this._scheduleReadAdvance(this.state.confidence);
      return;
    }
    if (this._displaySurah > targetSurah ||
        (this._displaySurah === targetSurah && this._displayAyah > targetAyah)) {
      this._scheduleReadAdvance(this.state.confidence);
      return;
    }

    // Advance display only — don't use transition() which would push the anchor
    // state past the Whisper-confirmed position. The anchor state already points
    // to the target; we're just animating the display to catch up.
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

  _restorePreRukuIfNeeded(completedSurah) {
    if (this.taraweehMode && completedSurah === 1
        && this._preRukuSurah > 1) {
      this.state.lastLockedSurah = this._preRukuSurah;
      this.state.lastLockedAyah  = this._preRukuAyah;
      console.log(`[Pipeline] Taraweeh: Fatiha done → resuming from ${this._preRukuSurah}:${this._preRukuAyah}`);
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

    // Use display position for LOCKED/PAUSED/RESUMING, candidate for SEARCHING
    const displaySurah = isDisplayable ? this._displaySurah : (isCandidate ? topMatch.surah : 0);
    const displayAyah  = isDisplayable ? this._displayAyah  : (isCandidate ? topMatch.ayah  : 0);
    const lockedVerse   = (displaySurah && displayAyah)
      ? getVerseData(displaySurah, displayAyah)
      : null;

    if (this.state.mode === 'LOCKED') {
      console.log(`[Emit] LOCKED ${displaySurah}:${displayAyah} "${(lockedVerse?.translation || '').substring(0, 50)}"`);
      this._completedSurah = 0;
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
}
