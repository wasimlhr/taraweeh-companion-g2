/**
 * AudioPipeline V3 — extends V2 with:
 * - 3s chunks: search starts at 3s, locked uses 3–6s chunks (same logic throughout)
 * - Manual prev: half-timer when going back (reciter already halfway through)
 * - Bump cap: max 2 bumps per ayah, stop bumping when reciter repeating (streak≥2)
 * - Bump threshold: only bump when remaining ≥12s (was 8s)
 * - Re-lock: pass display position into RESUMING for better resync when display ahead
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transcribe, collectKeys, resolveProvider } from './transcriptionRouter.js';
import { processWhisperResult, transition, createState, getPrevAyah, getNextAyah } from './anchorStateMachine.js';
import { getVerseData } from './verseData.js';
import { probeWhisperEndpoint } from './whisperProvider.js';
import { findAnchor, isRefrain, getAyah, spotCheck } from './keywordMatcher.js';
import {
  prepareMatcherText,
  isBismillahOnly,
  isPreRecitationPhrase,
  isAmeen,
  isNoise,
} from './whisperClean.js';

// ── Word-level corpus data (morphology + tajweed weights) ───────────────────
const __dirname_v4 = dirname(fileURLToPath(import.meta.url));
let _quranWords = null;
function getWordData(surah, ayah) {
  if (!_quranWords) {
    const wordFile = join(__dirname_v4, 'data', 'corpus', 'quran-words.json');
    try {
      _quranWords = JSON.parse(readFileSync(wordFile, 'utf8'));
      console.log(`[Pipeline] Loaded quran-words.json (${Object.keys(_quranWords).length} ayahs)`);
    } catch (e) {
      console.log(`[Pipeline] quran-words.json not found — using uniform word weights`);
      _quranWords = {};
    }
  }
  return _quranWords[`${surah}:${ayah}`] || null;
}

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

// 2.6.7 matching: first search at 3s so Groq gets a full verse-opening, not a
// 2s clipped fragment that hallucinates ترجمة نانسي قنقر.
const SEARCH_WINDOWS_MS = [3000, 5000, 8000, 12000, 20000];
const MAX_SEARCH_BUF_MS = 35000;
const SEARCH_SEND_MS = parseInt(process.env.SEARCH_SEND_MS || '12000', 10);
const SEARCH_PREROLL_MS = parseInt(process.env.SEARCH_PREROLL_MS || '1000', 10);

const VOICE_MIN_ACTIVE_MS = parseInt(process.env.VOICE_MIN_ACTIVE_MS || '500', 10);
// Must comfortably exceed a between-ayah breath, or the search buffer and window
// ladder get thrown away mid-recitation and the first lock never converges.
const VOICE_HANGOVER_MS = parseInt(process.env.VOICE_HANGOVER_MS || '5000', 10);
// Paces search retries once the buffer already exceeds the next window target.
// 4s starved the retry ladder; 2s keeps a cold search responsive while holding
// the worst-case burst near Groq's 20 RPM free tier.
const GROQ_SEARCH_MIN_INTERVAL_MS = parseInt(process.env.GROQ_SEARCH_MIN_INTERVAL_MS || '2000', 10);
// Safety valve: the voice gate is an optimisation, never the sole reason we stop
// transcribing. If audio keeps arriving while SEARCHING but the gate has not
// opened, search anyway and let the transcriber judge whether it is speech.
const SEARCH_VOICE_GATE_BYPASS_MS = parseInt(process.env.SEARCH_VOICE_GATE_BYPASS_MS || '6000', 10);
// "Is the mic producing anything at all", far below any speech level. Deliberately
// independent of the per-profile voice gate: buffering must keep working even if
// that gate is mis-tuned, otherwise the safety valve above never gets any audio.
const SIGNAL_PRESENT_RMS = parseFloat(process.env.SIGNAL_PRESENT_RMS || '0.0003');
const SEARCH_SEND_BYTES = Math.floor(BYTES_PER_MS * SEARCH_SEND_MS);
const SEARCH_PREROLL_BYTES = Math.floor(BYTES_PER_MS * SEARCH_PREROLL_MS);
// Practice: pause after a shown verse → next recitation is a fresh global search (surah jumps).
const PRACTICE_FRESH_SILENCE_MS = parseInt(process.env.PRACTICE_FRESH_SILENCE_MS || '2500', 10);
const PRACTICE_FRESH_MIN_HOLD_MS = parseInt(process.env.PRACTICE_FRESH_MIN_HOLD_MS || '1200', 10);
const PRACTICE_FRESH_SEARCH_MS = parseInt(process.env.PRACTICE_FRESH_SEARCH_MS || '2000', 10);

// voiceMinActivityRms is a per-85ms-chunk floor, so it sits well under the
// 0.002–0.015 whole-chunk range a phone or G2 mic produces during recitation:
// consonants and word gaps dip far below the level of the surrounding ayah.
// voiceMaxActivityRms caps how far room noise may push the gate up, and stays
// below the quiet end of that range on purpose. A single RMS threshold cannot
// both reject loud rooms and still hear the quietest reciter, so the ceiling is
// tuned to never climb into speech: in a noisy room the gate simply stops
// filtering (the pre-2.6.7 behaviour) instead of silencing the reciter.
const AUDIO_SOURCE_PROFILES = Object.freeze({
  browser: Object.freeze({
    source: 'browser',
    removeDcOffset: true,
    voiceMinActivityRms: parseFloat(process.env.BROWSER_VOICE_MIN_ACTIVITY_RMS || '0.0012'),
    voiceMaxActivityRms: parseFloat(process.env.BROWSER_VOICE_MAX_ACTIVITY_RMS || '0.0022'),
    voiceNoiseMultiplier: parseFloat(process.env.BROWSER_VOICE_NOISE_MULTIPLIER || '1.8'),
    lockedVoiceGateFactor: parseFloat(process.env.BROWSER_LOCKED_VOICE_GATE_FACTOR || '0.75'),
    quietBoostThreshold: parseFloat(process.env.BROWSER_QUIET_BOOST_THRESHOLD || '0.025'),
    quietBoostTarget: parseFloat(process.env.BROWSER_QUIET_BOOST_TARGET || '0.08'),
    maxBoostGain: parseFloat(process.env.BROWSER_MAX_BOOST_GAIN || '8'),
  }),
  simulator: Object.freeze({
    source: 'simulator',
    removeDcOffset: true,
    voiceMinActivityRms: parseFloat(process.env.SIMULATOR_VOICE_MIN_ACTIVITY_RMS || '0.0008'),
    voiceMaxActivityRms: parseFloat(process.env.SIMULATOR_VOICE_MAX_ACTIVITY_RMS || '0.0015'),
    voiceNoiseMultiplier: parseFloat(process.env.SIMULATOR_VOICE_NOISE_MULTIPLIER || '1.5'),
    lockedVoiceGateFactor: parseFloat(process.env.SIMULATOR_LOCKED_VOICE_GATE_FACTOR || '0.8'),
    quietBoostThreshold: parseFloat(process.env.SIMULATOR_QUIET_BOOST_THRESHOLD || '0.015'),
    quietBoostTarget: parseFloat(process.env.SIMULATOR_QUIET_BOOST_TARGET || '0.08'),
    maxBoostGain: parseFloat(process.env.SIMULATOR_MAX_BOOST_GAIN || '20'),
  }),
  g2: Object.freeze({
    source: 'g2',
    removeDcOffset: true,
    voiceMinActivityRms: parseFloat(process.env.G2_VOICE_MIN_ACTIVITY_RMS || '0.0004'),
    voiceMaxActivityRms: parseFloat(process.env.G2_VOICE_MAX_ACTIVITY_RMS || '0.0009'),
    voiceNoiseMultiplier: parseFloat(process.env.G2_VOICE_NOISE_MULTIPLIER || '1.35'),
    lockedVoiceGateFactor: parseFloat(process.env.G2_LOCKED_VOICE_GATE_FACTOR || '0.75'),
    quietBoostThreshold: parseFloat(process.env.G2_QUIET_BOOST_THRESHOLD || '0.010'),
    quietBoostTarget: parseFloat(process.env.G2_QUIET_BOOST_TARGET || '0.06'),
    maxBoostGain: parseFloat(process.env.G2_MAX_BOOST_GAIN || '24'),
  }),
});

function normalizeAudioSource(source) {
  const normalized = String(source || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(AUDIO_SOURCE_PROFILES, normalized) ? normalized : 'g2';
}

// Use 3s chunks continuously (same as search start) — faster feedback, consistent logic
const LOCKED_MIN_MS    = parseInt(process.env.LOCKED_MIN_MS    || '4000', 10);
const LOCKED_MAX_MS    = parseInt(process.env.LOCKED_MAX_MS    || '10000', 10);
const LOCKED_SEND_MS   = parseInt(process.env.LOCKED_SEND_MS   || '6000', 10);
// 3s chunks → 4 misses = 12s (too fast). 12 misses ≈ 36s, similar to 10s chunks × 4.
// 2s chunks → 16 misses ≈ 32s before resuming (same effective time as 12 × 3s)
const MISSED_BEFORE_RESUMING_V3 = parseInt(process.env.MISSED_BEFORE_RESUMING_V3 || '16', 10);
const MISSED_BEFORE_LOST_V3     = parseInt(process.env.MISSED_BEFORE_LOST_V3 || '16', 10);
const LOCKED_MIN_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MIN_MS);
const LOCKED_MAX_BYTES = Math.floor(BYTES_PER_MS * LOCKED_MAX_MS);
const LOCKED_SEND_BYTES = Math.floor(BYTES_PER_MS * LOCKED_SEND_MS);
const LOCKED_MAX_INFLIGHT = parseInt(process.env.LOCKED_MAX_INFLIGHT || '2', 10);
const GROQ_LOCKED_MIN_INTERVAL_MS = parseInt(process.env.GROQ_LOCKED_MIN_INTERVAL_MS || '5000', 10);
// Leading-edge tracking. The matcher scores a whole 6s window, so whichever ayah
// contributed the most words wins — normally the earlier one. That makes every
// confirmation report where the reciter *was* near the middle of the window, and
// the display trails by roughly half a window forever. These bound a second,
// narrower match over just the newest words, which is where the reciter is now.
const LEADING_EDGE_TAIL_MS = parseInt(process.env.LEADING_EDGE_TAIL_MS || '2600', 10);
const LEADING_EDGE_MIN_WORDS = parseInt(process.env.LEADING_EDGE_MIN_WORDS || '3', 10);
const LEADING_EDGE_MIN_SCORE = parseFloat(process.env.LEADING_EDGE_MIN_SCORE || '0.45');
const LEADING_EDGE_MAX_ADVANCE = parseInt(process.env.LEADING_EDGE_MAX_ADVANCE || '3', 10);
// Padding on every locked-mode timer. Deliberately biased slow: a display that
// runs ahead shows an ayah the imam has not reached yet, which is worse than
// trailing by one. 1 = no padding. Measured across the sync bench, dropping this
// below ~1.15 buys accuracy on steady recitation but overshoots on slow, long-
// breath recitation, so it stays conservative until tuned on real recordings.
const GROQ_TIMER_CUSHION = parseFloat(process.env.GROQ_TIMER_CUSHION || '1.2');
// Whisper says the reciter is exactly one ayah past the display. Rather than
// snapping (jittery) or ignoring it (the display then stays behind for the rest
// of the ayah), compress the remaining timer to this so it closes the gap
// smoothly. 0 restores the old ignore-gap-of-one behaviour.
const GAP1_NUDGE_MS = parseInt(process.env.GAP1_NUDGE_MS || '500', 10);
const FORWARD_JUMP_CONFIRMS = parseInt(process.env.FORWARD_JUMP_CONFIRMS || '2', 10);
const FORWARD_JUMP_DRIFT = parseInt(process.env.FORWARD_JUMP_DRIFT || '4', 10);
// An ayah's on-screen life is speech time PLUS the breath the reciter takes at
// the end of it. That pause is additive, so a timer multiplier cannot represent
// it: the same cushion that fits 1.2s breaths races ahead on 4s ones. Learn it
// separately and add it.
const PAUSE_EST_START_MS = parseInt(process.env.PAUSE_EST_START_MS || '900', 10);
const PAUSE_EST_MAX_MS = parseInt(process.env.PAUSE_EST_MAX_MS || '6000', 10);
// Hold the display while the mic hears nothing. Above a normal inter-word gap so
// it does not trip mid-ayah, and bounded so it can never freeze the display.
const DISPLAY_HOLD_SILENCE_MS = parseInt(process.env.DISPLAY_HOLD_SILENCE_MS || '1200', 10);
const DISPLAY_HOLD_MAX_MS = parseInt(process.env.DISPLAY_HOLD_MAX_MS || '20000', 10);
const LOCKED_RESULT_STALE_MS = parseInt(process.env.LOCKED_RESULT_STALE_MS || '3000', 10);
const CAPPED_RECOVERY_MAX_CHECKS = parseInt(process.env.CAPPED_RECOVERY_MAX_CHECKS || '2', 10);
const CAPPED_RECOVERY_RECENT_VOICE_MS = parseInt(process.env.CAPPED_RECOVERY_RECENT_VOICE_MS || '15000', 10);

const SILENCE_THRESHOLD        = parseFloat(process.env.SILENCE_THRESHOLD        || '0.005');
const READ_ADVANCE_CONFIDENCE  = parseInt(process.env.READ_ADVANCE_CONFIDENCE    || '40',    10);
const READ_WORDS_PER_SEC       = parseFloat(process.env.READ_WORDS_PER_SEC       || '1.15');
const READ_ADVANCE_MIN_MS      = parseInt(process.env.READ_ADVANCE_MIN_MS        || '4000',  10);
// No hard cap — transliteration + pace mode determine duration. 90s safety only for bugs.
const READ_ADVANCE_MAX_MS      = parseInt(process.env.READ_ADVANCE_MAX_MS        || '30000', 10);
const READ_ADVANCE_CONFIRM_BUMP_MS = parseInt(process.env.READ_ADVANCE_CONFIRM_BUMP_MS || '2500', 10);
const SMOOTH_ADVANCE_STEP_MS   = parseInt(process.env.SMOOTH_ADVANCE_STEP_MS     || '1200',  10);
// By first lock we've matched 3–6s of audio — reciter is near end of ayah; advance quickly
const FIRST_LOCK_DURATION_FACTOR = parseFloat(process.env.FIRST_LOCK_DURATION_FACTOR || '0.25', 10);
// After catch-up or back-correct: reciter is partway through ayah — use shorter timer
const CORRECTED_DURATION_FACTOR = parseFloat(process.env.CORRECTED_DURATION_FACTOR || '0.5', 10);
// Groq-specific: after a snap, the confirmed ayah was captured ~3s ago.
// Reciter has moved forward in that window. Shorter factor so display
// auto-advances sooner if Groq doesn't confirm the next ayah first.
const GROQ_CORRECTED_DURATION_FACTOR = parseFloat(process.env.GROQ_CORRECTED_DURATION_FACTOR || '0.3', 10);
// Cooldown after back-correction: suppress further back-corrections for this many ms
const BACK_CORRECT_COOLDOWN_MS = parseInt(process.env.BACK_CORRECT_COOLDOWN_MS || '2500', 10);
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
const BLOCKED_FORCE_UNBLOCK_MS = parseInt(process.env.BLOCKED_FORCE_UNBLOCK_MS || '8000', 10);

function computeRms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n * 2; i += 2) s += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(s / n);
}

function removeDcOffset(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return pcm;
  let sum = 0;
  for (let offset = 0; offset < samples * 2; offset += 2) sum += pcm.readInt16LE(offset);
  const mean = Math.round(sum / samples);
  if (Math.abs(mean) < 8) return pcm;
  const centered = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < samples * 2; offset += 2) {
    const sample = pcm.readInt16LE(offset) - mean;
    centered.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), offset);
  }
  return centered;
}

const CLIP_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.10');
const CLIP_TARGET    = parseFloat(process.env.CLIP_TARGET    || '0.04');
function applyClipGuard(pcm, rms, profile) {
  // 2.6.7: boost only when this source is below its quiet threshold; never a
  // flat client-side 8×. Loud recitation is left alone; only clip > 0.10.
  let gain = 1;
  const maxBoost = profile?.maxBoostGain ?? 1;
  const thresh = profile?.quietBoostThreshold ?? 0;
  const target = profile?.quietBoostTarget ?? 0.08;
  if (rms > 0 && rms < thresh && maxBoost > 1) {
    gain = Math.min(maxBoost, target / rms);
    console.log(`[Pipeline] ${profile.source} quiet boost: rms=${rms.toFixed(4)} -> ${target} (gain=${gain.toFixed(1)})`);
  } else if (rms > CLIP_THRESHOLD) {
    gain = CLIP_TARGET / rms;
    console.log(`[Pipeline] Audio normalize: rms=${rms.toFixed(3)} -> ${CLIP_TARGET} (gain=${gain.toFixed(3)})`);
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

// Whisper often garbles takbeer: أكبى/اكبي/اكبا/أكبر — match all variants.
// Don't require ^ — noise words may precede it in 2s chunks.
const TAKBEER_RE = /الله\s*(ال)?[اأآ]كب[رىياً]/u;
function isTakbeer(text) {
  if (!text) return false;
  const n = text.replace(/[\u064b-\u065f\u0670\u0640]/g, '').trim();
  return TAKBEER_RE.test(n);
}

// Tasmee': "سمع الله لمن حمده" — imam says this standing up from ruku.
// Whisper garbles: سميع/سمي/سمعا + الله + لمن + حمده/حمد/حمدا etc.
const TASMEE_RE = /سم[عيى]\s*(الله|لله)\s*(لمن|من)\s*(حمد|حمده|حمدا)/u;
function isTasmee(text) {
  if (!text) return false;
  const n = text.replace(/[\u064b-\u065f\u0670\u0640]/g, '').trim();
  return TASMEE_RE.test(n);
}

// Combined: any prayer transition phrase (takbeer or tasmee')
function isPrayerTransition(text) {
  return isTakbeer(text) || isTasmee(text);
}

// Timeout for stuck states: if in RUKU/SAJDA for too long, auto-advance.
// During prayer, each position lasts ~3-8s. 15s is generous enough.
const TARAWEEH_STUCK_TIMEOUT_MS = 15000;

// ── AudioPipeline class ───────────────────────────────────────────────────────

export class AudioPipeline {
  constructor({ onStateUpdate, onStatus, onError, preferredSurah = 0, translationLang = '', hfToken, whisperOpts, audioSource = 'g2' }) {
    this.onStateUpdate   = onStateUpdate;
    this.onStatus        = onStatus || (() => {});
    this.onError         = onError  || (() => {});
    this.preferredSurah  = preferredSurah;
    this.translationLang = (translationLang && String(translationLang).trim()) || '';
    this.whisperOpts     = whisperOpts || (hfToken ? { apiKey: hfToken } : null);
    // Each engine is independent. Groq uses a slightly wider send gap so free-tier
    // 20 RPM is not exceeded *after* lock; search is not starved.
    const _keys = collectKeys(this.whisperOpts || {});
    const _provider = resolveProvider(this.whisperOpts?.provider, _keys);
    const _fastSet = new Set(['groq', 'openai', 'deepgram', 'elevenlabs']);
    this.resolvedProvider = _provider;
    this.hasFailover      = false;
    this.isGroqMode       = _provider === 'groq';
    this.isOpenAIMode     = _provider === 'openai';
    this.isFastProvider   = _fastSet.has(_provider);
    this.isHFMode         = !this.isFastProvider;
    this._lastPromptText  = '';
    console.log(`[Pipeline] Constructed — provider=${_provider}, fast=${this.isFastProvider}, groqThrottle=${this.isGroqMode}`);

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
    this._searchVoicedMs = 0;
    this._searchLastVoiceAt = 0;
    this._searchHasSignal = false;
    this._forceNextSearch = false;
    this._lastSearchCall = 0;
    this._timerHeartbeatRef = null;  // periodic emit so frontend countdown never disappears

    this._lockedBuf      = Buffer.alloc(0);
    this._lastTexts      = [];
    this._lastLockedCall = 0;
    this._lockedInFlight = 0;
    this._lockedSeq = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;

    this._displayAdvanceTimer = null;
    this._nextAdvanceMs       = 0;
    this._timerStartedAt      = 0;
    this._smoothAdvanceTimer  = null;

    this._lastAudioStatusMs = 0;
    this.audioSource = null;
    this._audioProfile = null;
    this._noiseFloorRms = 0;
    this._ayahStartTime     = 0;

    this._pauseAnalysisBuf   = Buffer.alloc(0);
    this._pauseAccumMs       = 0;
    this._lastPauseAdvanceMs = 0;
    this._lastManualAdjustMs = 0;
    this._lastBackCorrectMs = 0;  // cooldown after back-correction to prevent ping-pong

    // Groq word-level tracking: absolute ms of last heard word's end time.
    // Used by _canDisplayAdvance() to block timer during silences/pauses.
    this._lastHeardWordMs    = 0;
    // Groq rate-limit cooldown: pipeline stops calling transcribe() until
    // this timestamp (set by 429 Retry-After hints).
    this._rateLimitedUntilMs = 0;
    this._lastHeardWordCount = 0;

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
    this._syncingDisplay    = false;

    // Learned pace: measured from manual advance clicks (ms per word)
    this._measuredMsPerWord = 0;   // 0 = no data yet, use default
    this._msPerWordSamples  = [];  // last 6 samples for rolling average
    this._whisperClockSamples = 0; // count of Whisper clock measurements (no manual data)
    this._wordPaceSamples = 0;     // count of pace measurements from word timestamps
    this._measuredPauseMs = PAUSE_EST_START_MS;  // learned end-of-ayah breath
    this._forwardJumpAyah = 0;     // far-ahead candidate awaiting a second sighting
    this._forwardJumpCount = 0;

    // Pace tracking: rolling window of recent WPS samples for trend detection
    this._paceHistory    = [];   // [{wps, ts}] — last 8 measurements
    this._paceCategory   = '';   // 'slow' | 'normal' | 'fast' | 'very-fast'
    this._paceTrend      = 0;   // -1 decelerating, 0 steady, +1 accelerating
    this._lastPaceEmitMs = 0;

    this.taraweehMode    = false;
    this.practiceMode    = false;  // Taraweeh lock, no timer; STT only when a verse is heard
    this._practiceLastMatchMs = 0; // when a verse was last shown in Practice
    this._practiceFreshRun    = false; // true → global search, no sequential bias
    this._taraweehPos    = 'QIYAM';
    this._expectFatiha   = false;    // set after ruku/sajda cycle — next recitation is Fatiha
    this._taraweehPosEnteredAt = 0;  // timestamp when current taraweeh position was entered

    // V4: Word-level tracking fields
    this._currentWordIndex = 0;           // Current word position within ayah (0-indexed)
    this._currentAyahWords = [];          // Word array for current ayah
    this._wordTimestamps = [];            // Word timestamps from Whisper: [{text, start, end}]
    this._wordProgressInterval = null;    // Timer for progress updates (200ms)
    this._lockTime = 0;                   // When ayah was locked (for word position estimation)
    this._taraweehLastFrom = 'reciting';  // 'reciting' | 'ruku' | 'sajda1' | 'sajda2'
    this._sajdaCount     = 0;              // 1 or 2 when in SAJDA
    this._rakatCount     = 0;
    this._preRukuSurah   = 0;
    this._preRukuAyah    = 0;

    // Per-session usage cap. Only enforced in shared-key mode (the host's
    // budget needs protecting). BYOK users are uncapped — they pay for it.
    this._sessionAudioMs = 0;
    this._sessionWarned80 = false;
    this._sessionCapReached = false;
    const sharedMode = !!(this.whisperOpts && this.whisperOpts.sharedMode);
    const envCapMin = parseInt(process.env.MAX_MIN_PER_SESSION || '90', 10);
    this._sessionCapMs = sharedMode && envCapMin > 0 ? envCapMin * 60 * 1000 : 0;  // 0 = uncapped

    // Skip the HF warmup probe for any BYOK fast provider — the probe's
    // 'dedicated' status events overwrite the provider's 'ready' signal and
    // flash "Server warming up…" on the UI during transient 401/503s.
    if (!this.isFastProvider) {
      probeWhisperEndpoint(this.whisperOpts, this.onStatus).catch(() => {});
    }
    this.setAudioSource(audioSource);
  }

  get _maxDisplayLead() {
    if (this.fastMode) return 4;
    if (this._paceCategory === 'fast' || this._paceCategory === 'very-fast') return 4;
    return 3;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setAudioSource(source) {
    const normalized = normalizeAudioSource(source);
    if (normalized === this.audioSource && this._audioProfile) return;
    this.audioSource = normalized;
    this._audioProfile = AUDIO_SOURCE_PROFILES[normalized];
    this._noiseFloorRms = 0;
    this._resetSearchBuf();
    this._lockedBuf = Buffer.alloc(0);
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;
    const profile = this._audioProfile;
    console.log(`[Pipeline] Audio profile=${normalized} gate=${profile.voiceMinActivityRms}-${profile.voiceMaxActivityRms} noise*${profile.voiceNoiseMultiplier} boost<${profile.quietBoostThreshold} max×${profile.maxBoostGain}`);
    this.onStatus({ type: 'audio_profile', component: 'audio', status: 'ready', source: normalized });
  }

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
    if (this.taraweehMode) {
      this.practiceMode = false;
      this.onStatus({ type: 'verse_hold_mode', enabled: false });
      this.onStatus({ type: 'practice_mode', enabled: false });
    }
    if (!this.taraweehMode) {
      this._taraweehPos = 'QIYAM';
      this._taraweehLastFrom = 'reciting';
      this._sajdaCount = 0;
      this._rakatCount = 0;
      this._expectFatiha = false;
    } else if (this.state.mode === 'SEARCHING') {
      // Imam always opens with Fatiha, so prime the express lock from the first
      // rakat. A session that starts mid-recitation is still safe: the express
      // path needs a strong Fatiha score, and anchorStateMachine falls back to a
      // global search whenever the preferred surah finds nothing.
      this._expectFatiha = true;
    }
    console.log(`[Pipeline] Taraweeh mode ${this.taraweehMode ? 'ON' : 'OFF'}${this._expectFatiha ? ' (expectFatiha=true)' : ''}`);
    this.onStatus({ type: 'taraweeh_mode', enabled: this.taraweehMode,
      position: this._taraweehPos, rakat: this._rakatCount });
  }

  setPracticeMode(enabled) {
    this.practiceMode = !!enabled;
    if (this.practiceMode) {
      this.taraweehMode = false;
      this._taraweehPos = 'QIYAM';
      this.onStatus({ type: 'taraweeh_mode', enabled: false,
        position: this._taraweehPos, rakat: this._rakatCount });
    }
    if (this.practiceMode) {
      this._cancelReadAdvance();
      // Snap display to heard position — no timer drift in Practice.
      if (this._whisperSurah > 0 && this._whisperAyah > 0) {
        this._displaySurah = this._whisperSurah;
        this._displayAyah  = this._whisperAyah;
        if (this.state.mode === 'LOCKED') {
          this.state = {
            ...this.state,
            surah: this._whisperSurah,
            ayah: this._whisperAyah,
          };
        }
        this._emitState(null, null);
      }
    }
    console.log(`[Pipeline] Practice mode ${this.practiceMode ? 'ON' : 'OFF'}`);
    this.onStatus({ type: 'practice_mode', enabled: this.practiceMode });
  }

  // Legacy alias
  setVerseHoldMode(enabled) { this.setPracticeMode(enabled); }

  _applyWhisperPrompt() {
    // 2.6.7 sent no Whisper prompt. Prompt-echo was locking Fatiha / تلاوة
    // and crowding out the actual recitation tokens.
    if (this.whisperOpts && typeof this.whisperOpts === 'object') {
      this.whisperOpts.prompt = '';
    }
  }

  _handleTranscriptionError(err) {
    if (!err) return;
    const is429 = err.status === 429 || /HTTP 429|rate.?limit/i.test(err.message || '');
    if (!is429) return;
    // Short pause only — long 15–60s freezes were a byproduct of failed lock
    // (search kept retrying). Faster lock is the real fix.
    const hintMs = err.retryAfterMs || 0;
    const waitMs = Math.max(3000, Math.min(hintMs || 8000, 12000));
    this._rateLimitedUntilMs = Date.now() + waitMs;
    console.warn(`[Pipeline] 429 — cooldown ${Math.round(waitMs / 1000)}s before next request`);
    this.onStatus({
      component: 'model',
      status: 'error',
      provider: this.resolvedProvider || this.whisperOpts?.provider || 'groq',
      message: `Rate limit — waiting ${Math.round(waitMs / 1000)}s`,
      retryAfterMs: waitMs,
      httpStatus: 429,
    });
  }

  _isRateLimited() {
    return this._rateLimitedUntilMs > 0 && Date.now() < this._rateLimitedUntilMs;
  }

  resetRakat() {
    this._rakatCount = 0;
    this._taraweehPos = 'QIYAM';
    this._taraweehLastFrom = 'reciting';
    this._sajdaCount = 0;
    // Fresh rakat starts with Fatiha — prime fast-lock if taraweeh mode is on.
    this._expectFatiha = !!this.taraweehMode;
    this._emitTaraweeh();
  }

  setPreferredSurah(s) { this.preferredSurah = s; }

  _startTimerHeartbeat() {
    this._stopTimerHeartbeat();
    // 500ms with 3s chunks = smoother countdown; Whisper results also emit on confirm/bump
    this._timerHeartbeatRef = setInterval(() => {
      if (!this.active || this.practiceMode || this.state.mode !== 'LOCKED') return;
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
    // Preserve last known position so tap-to-browse in SEARCHING starts there
    const prevSurah = this._displaySurah || this.state.lastLockedSurah;
    const prevAyah  = this._displayAyah  || this.state.lastLockedAyah;
    this._cancelReadAdvance();
    this._startTimerHeartbeat();
    this.active = true;
    this.state  = createState();
    if (prevSurah > 0) {
      this.state.lastLockedSurah = prevSurah;
      this.state.lastLockedAyah  = prevAyah || 1;
    }
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._displaySurah = 0;
    this._displayAyah  = 0;
    this._lockedInFlight = 0;
    this._lockedSeq = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;
    this._preRecitSkips = 0;
    this._lastSearchCall = 0;   // a restart must not inherit the previous run's throttle
    this._noiseFloorRms = 0;
    this._resetSearchBuf();
    console.log(`[Pipeline] Started (last known: ${prevSurah}:${prevAyah || 0})`);
  }

  stop() {
    this.active = false;
    this._stopTimerHeartbeat();
    this._resetSearchBuf();
    this._lockedBuf          = Buffer.alloc(0);
    this._lastLockedCall     = 0;
    this._lockedInFlight     = 0;
    this._lockedSeq          = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;
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

  // Practice: browse verses without breaking heard-match tracking.
  _practiceManualNav(delta) {
    this._cancelReadAdvance();
    this._sameAyahStreak = 0;
    this._bumpCountForAyah = 0;
    this._lastManualAdjustMs = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastTexts = [];

    let s = this._displaySurah || this.state.surah || this.state.lastLockedSurah || this.preferredSurah || 1;
    let a = this._displayAyah || this.state.ayah || this.state.lastLockedAyah || 1;

    if (delta > 0) {
      const next = getNextAyah(s, a);
      if (!next) {
        this.state = { ...createState(), mode: 'SEARCHING', lastLockedSurah: s, lastLockedAyah: a };
        this._resetSearchBuf();
        this._emitState(null, null);
        return;
      }
      s = next.surah;
      a = next.ayah;
    } else if (a > 1) {
      a--;
    } else {
      return;
    }

    this._displaySurah = s;
    this._displayAyah = a;
    this._userSearchingDisplay = true;
    // Keep _whisperSurah/_whisperAyah on what was actually heard — display catches up on match.
    this._ayahStartTime = Date.now();
    this._lockTime = this._ayahStartTime;
    this._currentWordIndex = 0;
    this.state = {
      ...this.state,
      mode: 'LOCKED',
      surah: s,
      ayah: a,
      missedChunks: 0,
      lastLockedSurah: s,
      lastLockedAyah: a,
    };
    console.log(`[Pipeline] Practice manual ${delta > 0 ? 'next' : 'prev'}: display → ${s}:${a} (heard ${this._whisperSurah || '?'}:${this._whisperAyah || '?'})`);
    this._emitState(null, null);
  }

  _practiceConfPct(score) {
    if (score == null || Number.isNaN(score)) return 0;
    return score <= 1 ? score * 100 : score;
  }

  // Instant snap — Practice follows Groq identifications, no timers.
  _snapPracticeVerse(surah, ayah, score, words = []) {
    const confPct = this._practiceConfPct(score);
    this._whisperSurah = surah;
    this._whisperAyah  = ayah;
    const changed = surah !== this._displaySurah || ayah !== this._displayAyah;
    if (changed) {
      this._displaySurah = surah;
      this._displayAyah  = ayah;
      this._ayahStartTime = Date.now();
      this._lockTime = this._ayahStartTime;
      this._currentWordIndex = 0;
      console.log(`[Pipeline] Practice snap → ${surah}:${ayah} (${Math.round(confPct)}%)`);
    }
    this.state = {
      ...this.state,
      mode: 'LOCKED',
      surah,
      ayah,
      confidence: confPct / 100,
      missedChunks: 0,
      lastLockedSurah: surah,
      lastLockedAyah: ayah,
    };
    if (words.length > 0) {
      this._wordTimestamps = words;
      const ayahData = getAyah(surah, ayah);
      const totalWords = ayahData?.words?.length ?? 0;
      if (totalWords > 0) {
        const whisperWordIndex = Math.min(words.length, totalWords) - 1;
        this._currentWordIndex = Math.max(this._currentWordIndex, Math.min(whisperWordIndex, totalWords - 1));
      }
    }
    this._practiceLastMatchMs = Date.now();
    this._practiceFreshRun = false;
    this._lastHeardWordMs = Date.now(); // silence clock starts at match — not pre-lock audio
    this._userSearchingDisplay = false;
  }

  // After a matched verse + pause, re-enter global search for surah-to-surah jumps.
  _enterPracticeFreshSearch() {
    if (!this.practiceMode || this.state.mode !== 'LOCKED') return;
    console.log(`[Pipeline] Practice fresh run — listening for next verse (was ${this._displaySurah}:${this._displayAyah})`);
    this._cancelReadAdvance();
    this._practiceFreshRun = true;
    this._practiceLastMatchMs = 0;
    this._userSearchingDisplay = true;
    this.state = { ...createState(), mode: 'SEARCHING', lastLockedSurah: 0, lastLockedAyah: 0 };
    this._whisperSurah = 0;
    this._whisperAyah  = 0;
    this._lastHeardWordMs = 0;
    this._lastTexts = [];
    this._lockedInFlight = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._searchWinIdx = 0;
    if (this._lockedBuf.length > 0) {
      this._searchBuf = Buffer.concat([this._searchBuf, this._lockedBuf]);
      this._lockedBuf = Buffer.alloc(0);
      this._searchHasSignal = true;   // carried locked audio is recitation, don't trim it
    }
    // This runs after a deliberate pause, so the voice gate is closed by
    // construction. Without the override the search below is always dropped and
    // the fresh-run snap never happens.
    this._forceNextSearch = true;
    this._emitState(null, null);
    const bufMs = this._searchBuf.length / BYTES_PER_MS;
    if (bufMs >= PRACTICE_FRESH_SEARCH_MS && !this.processing) {
      setTimeout(() => {
        if (this.active && this.state.mode === 'SEARCHING' && !this.processing) {
          this._processSearchChunk();
        }
      }, 0);
    }
  }

  _maybePracticeFreshRun() {
    // Practice is not Taraweeh: stay on the matched ayah through pauses and
    // repeats. A newly recited verse snaps while still LOCKED. Do not drop
    // back to SEARCHING ("Auto locking") after the ayah is already on glasses.
    return;
  }

  _tryPracticeSnapFromMatches(anchorResult, words = []) {
    if (anchorResult._locked) {
      this._snapPracticeVerse(anchorResult.surah, anchorResult.ayah, anchorResult.confidence, words);
      return true;
    }
    const top = anchorResult._matches?.[0];
    if (!top) return false;
    const mc = top.matchedWords?.length ?? 0;
    const near = top.surah === this._displaySurah && Math.abs(top.ayah - this._displayAyah) <= 2;
    const minScore = near ? 0.18 : 0.22;
    const minWords = (near && top.score >= 0.26) ? 1 : 2;
    if (top.score >= minScore && mc >= minWords) {
      this._snapPracticeVerse(top.surah, top.ayah, top.score, words);
      return true;
    }
    return false;
  }

  manualAdvance() {
    this._cancelReadAdvance();
    if (this.practiceMode) {
      this._practiceManualNav(1);
      return;
    }
    // When in SEARCHING: user browsing to find ayah — update display, show "Auto locking…", don't lock
    if (this.state.mode === 'SEARCHING') {
      const s = this._displaySurah || this.state.lastLockedSurah || this._restoredSurah || this.preferredSurah || 1;
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
      // Taraweeh khatam: after Fatiha manual-advance past 1:7, jump to continuation
      const taraweehResume = this.taraweehMode && prevSurah === 1 && this._preRukuSurah > 1;
      const rAyah = taraweehResume ? this._preRukuAyah + 1 : 0;
      const rData = taraweehResume ? getVerseData(this._preRukuSurah, rAyah, this.translationLang) : null;
      if (taraweehResume && rData) {
        this._displaySurah = this._preRukuSurah;
        this._displayAyah  = rAyah;
        this._whisperSurah = this._preRukuSurah;
        this._whisperAyah  = rAyah;
        this._ayahStartTime = Date.now();
        this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
          surah: this._preRukuSurah, ayah: rAyah,
          lastLockedSurah: this._preRukuSurah, lastLockedAyah: rAyah };
        console.log(`[Pipeline] Manual: Fatiha done → khatam continuation ${this._preRukuSurah}:${rAyah}`);
        this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
      } else {
        this.state = { ...createState(), mode: 'SEARCHING', lastLockedSurah: 0, lastLockedAyah: 0 };
        this._resetSearchBuf();
      }
    } else {
      const from = `${this._displaySurah}:${this._displayAyah}`;
      // Learn pace from how long user stayed on previous ayah
      this._learnPaceFromManual();
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;
      this._displayAyah++;
      const to = `${this._displaySurah}:${this._displayAyah}`;
      this._ayahStartTime = Date.now();
      this._lockTime = this._ayahStartTime;  // V4: Reset word progress timer
      this._currentWordIndex = 0;  // V4: Reset word index
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
    // If pace changed significantly, adjust the CURRENT running timer too.
    // Delegate to _scheduleReadAdvance via overrideDurationMs so the
    // word-progress interval gets re-armed alongside the timer (a previous
    // inline implementation cancelled but never restarted the interval,
    // freezing UI word-progress ticks until the next state change).
    if (prev > 0 && this._displayAdvanceTimer && this._timerStartedAt && this._nextAdvanceMs > 0) {
      const ratio = median / prev;
      if (Math.abs(ratio - 1.0) > 0.15) {
        const elapsed = Date.now() - this._timerStartedAt;
        const remaining = Math.max(0, this._nextAdvanceMs - elapsed);
        const adjusted = Math.max(2000, Math.round(remaining * ratio));
        this._cancelReadAdvance();
        this._scheduleReadAdvance(this.state.confidence, 0, 1.0, adjusted);
        console.log(`[Pipeline] Timer adjusted: ${Math.round(remaining/1000)}s → ${Math.round(adjusted/1000)}s (pace ${prev}→${median}ms/w)`);
      }
    }
  }

  manualPrev() {
    this._cancelReadAdvance();
    if (this.practiceMode) {
      this._practiceManualNav(-1);
      return;
    }
    this._sameAyahStreak = 0;
    this._bumpCountForAyah = 0;
    // When in SEARCHING: user browsing to find ayah — stay in same surah
    if (this.state.mode === 'SEARCHING') {
      const s = this._displaySurah || this.state.lastLockedSurah || this._restoredSurah || this.preferredSurah || 1;
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
    this._lockTime = this._ayahStartTime;  // V4: Reset word progress timer
    this._currentWordIndex = 0;  // V4: Reset word index
    this._lastManualAdjustMs = Date.now();
    this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
      surah: this._displaySurah, ayah: this._displayAyah,
      lastLockedSurah: this._displaySurah, lastLockedAyah: this._displayAyah };
    // Reciter is already partway through — use shorter timer for catching up
    this._scheduleReadAdvance(Math.max(this.state.confidence, 65), 0, 0.3);
    this._emitState(null, null);
  }

  pause() {
    if (this.state.mode !== 'LOCKED' && this.state.mode !== 'RESUMING') return;
    // Freeze display and timer — but keep listening to Whisper in the background
    // so we track where the reciter is. On resume, snap to the latest Whisper position.
    // Save remaining timer so we can resume it (not restart from scratch)
    if (this._displayAdvanceTimer && this._nextAdvanceMs > 0 && this._timerStartedAt > 0) {
      const elapsed = Date.now() - this._timerStartedAt + (this._pauseAccumMs || 0);
      this._pausedTimerRemainingMs = Math.max(0, this._nextAdvanceMs - elapsed);
    } else {
      this._pausedTimerRemainingMs = 0;
    }
    this._cancelReadAdvance();
    this._pausedWhisperSurah = this._whisperSurah;
    this._pausedWhisperAyah  = this._whisperAyah;
    this._pausedDisplaySurah = this._displaySurah;
    this._pausedDisplayAyah  = this._displayAyah;
    // Route through the state machine reducer — keeps mode transitions in
    // one place and lets the state machine evolve without pipeline edits.
    this.state = transition(this.state, { type: 'PAUSE' });
    console.log(`[Pipeline] Paused display at ${this._displaySurah}:${this._displayAyah} (timer remaining: ${this._pausedTimerRemainingMs}ms, Whisper still listening)`);
    this._emitState(null, null);
  }

  audioReturn() {
    if (this.state.mode !== 'PAUSED') return;
    // Only snap to Whisper if it moved AHEAD of where we paused.
    // Whisper is always ~6-12s behind the display, so snapping to it
    // on a quick pause/resume would jump backward. Keep display position
    // unless Whisper confirms the reciter moved forward during the pause.
    const whisperAhead = this._whisperSurah > 0 && (
      this._whisperSurah > this._pausedDisplaySurah ||
      (this._whisperSurah === this._pausedDisplaySurah && this._whisperAyah > this._pausedDisplayAyah)
    );
    const snapSurah = whisperAhead ? this._whisperSurah : this._pausedDisplaySurah || this._displaySurah;
    const snapAyah  = whisperAhead ? this._whisperAyah  : this._pausedDisplayAyah  || this._displayAyah;
    const moved = whisperAhead;
    this._displaySurah = snapSurah;
    this._displayAyah  = snapAyah;
    this._ayahStartTime = Date.now();
    this._lockTime = this._ayahStartTime;
    this._currentWordIndex = 0;
    // Reducer handles the PAUSED → LOCKED restore using the snap target.
    this.state = transition(this.state, {
      type: 'AUDIO_RETURN',
      snap: { surah: snapSurah, ayah: snapAyah },
    });

    if (!moved && this._pausedTimerRemainingMs > 0) {
      // Same ayah — resume timer with leftover time instead of restarting
      console.log(`[Pipeline] Resumed → ${snapSurah}:${snapAyah} (timer resuming: ${this._pausedTimerRemainingMs}ms left)`);
      this._scheduleReadAdvance(this.state.confidence, 0, 1.0, this._pausedTimerRemainingMs);
    } else {
      // Whisper moved — fresh timer for new position
      console.log(`[Pipeline] Resumed → ${snapSurah}:${snapAyah}${moved ? ' (snapped to Whisper)' : ''}`);
      this._scheduleReadAdvance(Math.max(this.state.confidence, 65));
    }
    this._pausedTimerRemainingMs = 0;
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
    this._practiceLastMatchMs = 0;
    this._practiceFreshRun = false;
    this._lockedInFlight = 0;
    this._lockedSeq = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;
    this._emitState(null, null);
  }

  destroy() {
    this.active = false;           // stop all processing & stale-check in-flight Whisper
    this._stopTimerHeartbeat();     // kill 500ms emit interval
    this._cancelReadAdvance();      // clear display-advance & smooth-advance timers
    this._resetSearchBuf();         // free search buffers
    this._lockedBuf = Buffer.alloc(0);
    this.processing = false;
    this._lockedInFlight = 0;
    this._lockedSeq = 0;
    this._lockedLastAppliedSeq = 0;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lastDetectedVoiceAt = 0;
    this._cappedRecoveryChecks = 0;
    this.onStateUpdate = () => {};  // swallow any late callbacks
    this.onStatus = () => {};
    this.onError = () => {};
    console.log('[Pipeline] Destroyed');
  }

  _voiceHangoverMs() {
    return VOICE_HANGOVER_MS;
  }

  _hasSearchVerse(now = Date.now()) {
    return this._searchVoicedMs >= VOICE_MIN_ACTIVE_MS
      && !!this._searchLastVoiceAt
      && now - this._searchLastVoiceAt <= this._voiceHangoverMs();
  }

  _hasLockedVerse(now = Date.now()) {
    return this._lockedVoicedMs >= VOICE_MIN_ACTIVE_MS
      && !!this._lockedLastVoiceAt
      && now - this._lockedLastVoiceAt <= this._voiceHangoverMs();
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────

  ingest(pcmData) {
    if (!this.active) return;

    this._maybePracticeFreshRun();

    const now = Date.now();
    const profile = this._audioProfile || AUDIO_SOURCE_PROFILES.g2;
    const processedPcm = profile.removeDcOffset ? removeDcOffset(pcmData) : pcmData;
    const rms = computeRms(processedPcm);
    const pcmMs = processedPcm.length / BYTES_PER_MS;
    // Seed the floor from what the mic actually reports. Seeding it from
    // voiceMinActivityRms instead pins the gate at that constant forever, since
    // the floor can then only ever decay away from it.
    if (this._noiseFloorRms <= 0) this._noiseFloorRms = Math.max(1e-6, rms);
    const activityGate = Math.max(profile.voiceMinActivityRms,
      Math.min(profile.voiceMaxActivityRms, this._noiseFloorRms * profile.voiceNoiseMultiplier));
    const lockedTracking = this.state.mode === 'LOCKED' || this.state.mode === 'PAUSED';
    const detectionGate = lockedTracking
      ? activityGate * profile.lockedVoiceGateFactor
      : activityGate;
    const hasVoice = rms > detectionGate;
    if (hasVoice) this._lastDetectedVoiceAt = now;
    // Chase the quietest recent level: drop fast so a loud opening does not keep
    // the gate high, creep up slowly so a noisy room can still raise it.
    if (rms < this._noiseFloorRms) {
      this._noiseFloorRms = this._noiseFloorRms * 0.8 + rms * 0.2;
    } else if (!hasVoice) {
      this._noiseFloorRms = this._noiseFloorRms * 0.995 + rms * 0.005;
    }

    if (now - this._lastAudioStatusMs >= 3000) {
      this._lastAudioStatusMs = now;
      console.log(`[Pipeline] Audio: source=${this.audioSource} rms=${rms.toFixed(4)} gate=${detectionGate.toFixed(4)} voice=${hasVoice} mode=${this.state.mode}`);
      this.onStatus({ component: 'audio', status: 'active', source: this.audioSource, rms: +rms.toFixed(4), voice: hasVoice });
    }

    if (this.state.mode === 'LOCKED' || this.state.mode === 'PAUSED') {
      if (hasVoice) {
        this._lockedVoicedMs += pcmMs;
        this._lockedLastVoiceAt = now;
      }
      this._lockedBuf = Buffer.concat([this._lockedBuf, processedPcm]);

      if (this._lockedBuf.length > LOCKED_MAX_BYTES) {
        this._lockedBuf = this._lockedBuf.subarray(this._lockedBuf.length - LOCKED_MAX_BYTES);
      }

      this._maybeProcessLockedBufferedChunk();
      return;
    }

    if (this._searchLastVoiceAt && now - this._searchLastVoiceAt > this._voiceHangoverMs() && !this.processing) {
      this._resetSearchBuf();
    }
    if (hasVoice) {
      this._searchVoicedMs += pcmMs;
      this._searchLastVoiceAt = now;
    }
    if (rms > SIGNAL_PRESENT_RMS) this._searchHasSignal = true;

    this._searchBuf = Buffer.concat([this._searchBuf, processedPcm]);
    // Trim to a short pre-roll only while the mic has been silent for this whole
    // run. Keying this off _searchVoicedMs discards the accumulated buffer after
    // every transcription, because sending resets that counter to zero.
    if (!this._searchHasSignal && this._searchBuf.length > SEARCH_PREROLL_BYTES) {
      this._searchBuf = this._searchBuf.subarray(this._searchBuf.length - SEARCH_PREROLL_BYTES);
    }

    const bufMs = this._searchBuf.length / BYTES_PER_MS;
    if (bufMs >= MAX_SEARCH_BUF_MS) {
      console.log('[Pipeline] Search buffer full — resetting');
      this._resetSearchBuf();
      this.onStatus({ component: 'search', status: 'reset', message: 'Buffer reset — resume reciting' });
      return;
    }

    const targetMs = SEARCH_WINDOWS_MS[this._searchWinIdx];
    if (bufMs >= targetMs && this._searchGateOpen(now) && !this.processing) {
      this._processSearchChunk();
    }
  }

  // Search is allowed when speech was recently detected, or — as a safety valve —
  // when audio has been buffering for a while without the gate ever opening.
  // A mis-tuned gate must never be able to stop transcription outright.
  _searchGateOpen(now = Date.now()) {
    if (this.isGroqMode && this._lastSearchCall
        && now - this._lastSearchCall < GROQ_SEARCH_MIN_INTERVAL_MS) return false;
    if (this._forceNextSearch) return true;
    const freshVoice = this._searchVoicedMs >= VOICE_MIN_ACTIVE_MS
      && now - this._searchLastVoiceAt <= VOICE_HANGOVER_MS;
    if (freshVoice) return true;
    const sinceLastSearch = this._lastSearchCall ? now - this._lastSearchCall : Infinity;
    return sinceLastSearch >= SEARCH_VOICE_GATE_BYPASS_MS;
  }

  _maybeProcessLockedBufferedChunk() {
    if (!this.active) return false;
    if (this.state.mode !== 'LOCKED' && this.state.mode !== 'PAUSED') return false;
    if (this._isRateLimited()) return false;
    // Groq free tier caps at 20 RPM → 5s spot checks / 1 in-flight. OpenAI has no
    // practical RPM cap → faster default. Both prefer newly detected speech.
    const maxInFlight = this.isGroqMode ? 1 : LOCKED_MAX_INFLIGHT;
    const minIntervalMs = this.isGroqMode ? GROQ_LOCKED_MIN_INTERVAL_MS : LOCKED_MIN_MS;
    if (this._lockedInFlight >= maxInFlight || this._lockedBuf.length < LOCKED_MIN_BYTES) return false;
    const now = Date.now();
    const freshVoice = this._hasLockedVerse(now);
    const displayCapped = this._isDisplayCapped();
    if (!displayCapped) this._cappedRecoveryChecks = 0;
    const canForceRecovery = !this.practiceMode
      && displayCapped
      && this._cappedRecoveryChecks < CAPPED_RECOVERY_MAX_CHECKS
      && this._lastDetectedVoiceAt > 0
      && now - this._lastDetectedVoiceAt <= CAPPED_RECOVERY_RECENT_VOICE_MS;
    if (!freshVoice && !canForceRecovery) return false;
    const timeSinceLastSend = this._lastLockedCall ? (now - this._lastLockedCall) : Infinity;
    if (timeSinceLastSend < minIntervalMs) return false;

    // Backpressure: send only the newest tail window so slow endpoint responses
    // do not force us to keep transcribing stale 8-10s buffers.
    const sendSlice = this._lockedBuf.length > LOCKED_SEND_BYTES
      ? this._lockedBuf.subarray(this._lockedBuf.length - LOCKED_SEND_BYTES)
      : this._lockedBuf;
    const chunk = Buffer.from(sendSlice);
    const bufMs = Math.round(chunk.length / BYTES_PER_MS);
    // Per-session budget cap (shared mode only). Hard-stop at 100% so a single
    // session can't drain the host's monthly transcription budget. Warn at 80%
    // so the user sees it coming and can stop / switch to BYOK.
    if (this._sessionCapMs > 0) {
      this._sessionAudioMs += bufMs;
      const pct = this._sessionAudioMs / this._sessionCapMs;
      if (pct >= 0.8 && !this._sessionWarned80) {
        this._sessionWarned80 = true;
        const minLeft = Math.max(0, Math.round((this._sessionCapMs - this._sessionAudioMs) / 60000));
        console.log(`[Pipeline] Session at ${Math.round(pct * 100)}% of shared-mode cap (~${minLeft}min left)`);
        this.onStatus({ type: 'session_quota', component: 'quota', status: 'warn',
          usedMs: this._sessionAudioMs, capMs: this._sessionCapMs, minLeft,
          message: `Approaching free-session limit (~${minLeft} min left). Add your own STT key in Settings for unlimited use.` });
      }
      if (pct >= 1.0 && !this._sessionCapReached) {
        this._sessionCapReached = true;
        console.log(`[Pipeline] Session shared-mode cap reached — refusing further chunks`);
        this.onStatus({ type: 'session_quota', component: 'quota', status: 'error',
          usedMs: this._sessionAudioMs, capMs: this._sessionCapMs,
          message: 'Free-session limit reached. Add your own STT key in Settings to continue.' });
      }
      if (this._sessionCapReached) return false;
    }
    const seq = ++this._lockedSeq;
    if (!freshVoice) {
      this._cappedRecoveryChecks++;
      console.log(`[Pipeline] Capped recovery check ${this._cappedRecoveryChecks}/${CAPPED_RECOVERY_MAX_CHECKS}`);
    }
    this._lastLockedCall = now;
    this._lockedVoicedMs = 0;
    this._lockedLastVoiceAt = 0;
    this._lockedInFlight++;
    console.log(`[Pipeline] Locked chunk #${seq} ${bufMs}ms (${Math.round(chunk.length/1024)}KB) gap=${Math.round(timeSinceLastSend)}ms tail=${Math.round(LOCKED_SEND_MS / 1000)}s inFlight=${this._lockedInFlight}/${LOCKED_MAX_INFLIGHT}`);
    this._processLockedChunk(chunk, seq);
    return true;
  }

  _shouldDropLockedResult(anchorResult, resultAgeMs, seq) {
    // Practice: never drop heard matches because display was browsed ahead/behind.
    if (!this.practiceMode) {
      const staleLockedResult = resultAgeMs > LOCKED_RESULT_STALE_MS;
      if (staleLockedResult) {
        // Slow/queued endpoint responses represent old audio; applying behind/same
        // confirmations causes visible snap-back. Keep only forward-moving updates.
        const isBehindOrSame =
          anchorResult.surah === this._displaySurah &&
          anchorResult.ayah <= this._displayAyah;
        if (anchorResult.mode !== 'LOCKED' || isBehindOrSame) {
          return { drop: true, reason: 'stale-behind-or-unlocked' };
        }
      }
    }

    const outOfOrderResult = seq > 0 && seq < this._lockedLastAppliedSeq;
    if (outOfOrderResult) {
      return { drop: true, reason: 'out-of-order' };
    }
    return { drop: false, reason: '' };
  }

  // ── Search mode ────────────────────────────────────────────────────────────

  _resetSearchBuf() {
    this._searchBuf    = Buffer.alloc(0);
    this._searchWinIdx = 0;
    this._arRahmanRefrainSeen = false;
    this._lastSearchTexts = [];
    this._searchVoicedMs = 0;
    this._searchLastVoiceAt = 0;
    this._searchHasSignal = false;
    this._forceNextSearch = false;
    this.processing    = false;
    this._searchGen    = (this._searchGen || 0) + 1;
  }

  async _processSearchChunk() {
    this.processing = true;
    const myGen = this._searchGen;
    const bufMs = Math.round(this._searchBuf.length / BYTES_PER_MS);

    const stale = () => this._searchGen !== myGen || !this.active;

    // Hold off entirely while rate-limited — don't waste windows or burn
    // calls into an already-hot 429 bucket.
    if (this._isRateLimited()) {
      this.processing = false;
      return;
    }

    const now = Date.now();
    if (!this._searchGateOpen(now)) {
      this.processing = false;
      return;
    }
    this._forceNextSearch = false;

    // Preserve cumulative context during initial locking. A short first result
    // may contain only a generic Quran prefix; the next call must still include
    // that prefix plus the identifying words that followed it.
    const sendSlice = this._searchBuf.length > SEARCH_SEND_BYTES
      ? this._searchBuf.subarray(this._searchBuf.length - SEARCH_SEND_BYTES)
      : this._searchBuf;
    const searchChunk = Buffer.from(sendSlice);
    const sendMs = Math.round(searchChunk.length / BYTES_PER_MS);
    const rms = computeRms(searchChunk);
    this._lastSearchCall = now;
    this._searchVoicedMs = 0;
    this._searchLastVoiceAt = 0;

    try {
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4), voice: true });
      console.log(`[Pipeline] Search ${bufMs}ms buffered, sending newest ${sendMs}ms rms=${rms.toFixed(3)}, window=${this._searchWinIdx + 1}/${SEARCH_WINDOWS_MS.length}`);
      this.onStatus({ component: 'search', status: 'transcribing', audioSec: sendMs / 1000, window: this._searchWinIdx + 1 });

      let text = '';
      let words = [];  // V4: Word timestamps from Whisper
      try {
        const audioToSend = applyClipGuard(searchChunk, rms, this._audioProfile || AUDIO_SOURCE_PROFILES.g2);
        this._applyWhisperPrompt();
        const result = await transcribe(audioToSend, this.whisperOpts, this.onStatus);
        text = result.text || '';
        words = result.words || [];  // V4: Extract word timestamps
        if (text) this._lastPromptText = text;
        if (stale()) { console.log('[Pipeline] Stale search result discarded'); return; }
        console.log(`[Pipeline] Whisper (${sendMs}ms): "${text.substring(0, 80)}"${words.length > 0 ? ` [${words.length} words]` : ''}`);
      } catch (err) {
        console.error('[Pipeline] Transcription error:', err.message?.substring(0, 100));
        this._handleTranscriptionError(err);
        this.onError(err.message);
        if (!stale()) { this._advanceSearchWindow(); this.processing = false; }
        return;
      }

      const cleaned = prepareMatcherText(text.trim());

      if (this.taraweehMode) {
        if (isPrayerTransition(cleaned)) {
          console.log(`[Pipeline] Taraweeh transition detected: ${isTakbeer(cleaned) ? 'takbeer' : 'tasmee'} (pos=${this._taraweehPos})`);
        } else if (/الله|اكبر|أكبر|سمع/i.test(cleaned) && cleaned.length < 80) {
          console.log(`[Pipeline] Taraweeh: Whisper has prayer words but no match: "${cleaned.slice(0, 60)}"`);
        }
        // Auto-advance stuck states: if in RUKU/SAJDA for too long, the transition
        // audio was missed. Force-advance so we don't get permanently stuck.
        if (this._taraweehPos !== 'QIYAM' && this._taraweehPosEnteredAt > 0
            && (Date.now() - this._taraweehPosEnteredAt) > TARAWEEH_STUCK_TIMEOUT_MS) {
          console.log(`[Pipeline] Taraweeh auto-advance: stuck in ${this._taraweehPos} for ${Math.round((Date.now() - this._taraweehPosEnteredAt)/1000)}s — forcing transition`);
          if (!stale()) {
            this._handleTaraweehTakbeer(false);
            this.processing = false;
          }
          return;
        }
      }
      if (this.taraweehMode && isPrayerTransition(cleaned)) {
        if (!stale()) {
          this._handleTaraweehTakbeer(false);
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
      // Otherwise bismillah-only is generic (could be any surah) — skip the matcher,
      // but still add to _lastSearchTexts so the NEXT chunk combines with it
      // (e.g. "بسم الله..." + "الحمد لله..." = strong Fatiha match).
      if (isBismillahOnly(cleaned) && this._taraweehPos !== 'RUKU') {
        console.log(`[Pipeline] Bismillah only — skipping matcher but keeping for combination`);
        this._lastSearchTexts.push(cleaned);
        if (this._lastSearchTexts.length > 3) this._lastSearchTexts.shift();
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
      const combined = this._lastSearchTexts.join(' ');

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

      // In taraweeh: during RUKU prefer Fatiha; after sajda2 expect Fatiha (fast-lock).
      // _expectFatiha also overrides preferredSurah to 1 so global search biases Fatiha.
      const expectFatiha = this.taraweehMode && this._expectFatiha && this.state.mode === 'SEARCHING';
      const preferredSurah = (this.taraweehMode && this._taraweehPos === 'RUKU') ? 1
        : expectFatiha ? 1
        : (this._arRahmanRefrainSeen ? 55 : this.preferredSurah);
      const opts = { preferredSurah, fastMode: this.fastMode, missBeforeResuming: MISSED_BEFORE_RESUMING_V3, missBeforeLost: MISSED_BEFORE_LOST_V3 };
      // Practice uses Taraweeh first-lock (do not pass practiceMode here).
      if (expectFatiha) opts.taraweehExpectFatiha = true;
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
        this._expectFatiha = false;          // Fatiha (or any verse) locked — clear flag
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
        if (sameSurahRelock && this.state.ayah < this._displayAyah && relockGap < 10 && !this.practiceMode) {
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
        this._currentWordIndex = 0;  // V4: default; snap from Whisper words if available
        const ayah = getAyah(this.state.surah, this.state.ayah);
        const totalWords = ayah?.words?.length ?? 0;
        if (totalWords > 0 && words.length > 0) {
          this._wordTimestamps = words;
          this._learnWordPaceFromTimestamps();
          this._currentWordIndex = Math.min(words.length, totalWords) - 1;
          const msPerWord = this._measuredMsPerWord || 700;
          this._lockTime = Date.now() - this._currentWordIndex * msPerWord;
        } else {
          this._lockTime = this._ayahStartTime;
        }
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

        if (this.practiceMode) {
          this._practiceFreshRun = false;
          this._practiceLastMatchMs = Date.now();
          this._lastHeardWordMs = Date.now();
        }

        // Only start first-lock timer if no timer is already running for this ayah
        // (timer may already be set from read-advance into this ayah)
        if (!this._displayAdvanceTimer && !this.practiceMode) {
          this._scheduleReadAdvance(this.state.confidence, 0, FIRST_LOCK_DURATION_FACTOR);
        }
        this._emitState(text, rms);
        return;
      } else {
        // Practice: the verse on glasses IS the lock. Do not wait for Taraweeh
        // 2-win / multi-ayah confirmation ("Auto locking").
        if (this.practiceMode && this._tryPracticeSnapFromMatches(this.state, words)) {
          this._resetSearchBuf();
          this._lastLockedCall = 0;
          this._lockedBuf = Buffer.alloc(0);
          if (!stale()) this._emitState(text, rms);
          if (!stale()) this.processing = false;
          return;
        }
        // Taraweeh: wait for anchor to lock — show candidate + "Auto locking".
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
      if (nextTarget && bufMs2 >= nextTarget && this._searchGateOpen()
          && this.state.mode !== 'LOCKED') {
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

  async _processLockedChunk(chunk, seq = 0) {
    this.processing = this._lockedInFlight > 0;
    const startedAt = Date.now();
    try {
      const rms = computeRms(chunk);
      this.onStatus({ component: 'audio', status: 'active', rms: +rms.toFixed(4) });

      // When display is capped waiting for Whisper, force transcription even on quiet audio
      // so Whisper can catch up. Otherwise the display freezes indefinitely during soft passages.
      const displayCapped = this._isDisplayCapped();

      const lockedSilenceGate = 0.002;
      if (rms < lockedSilenceGate && !displayCapped) {
        const newState = transition(this.state, { type: 'SILENCE' });
        if (newState.mode !== this.state.mode) {
          this.state = newState;
          this._emitState(null, rms);
        }
        return;
      }

      const chunkMs = Math.round(chunk.length / BYTES_PER_MS);
      console.log(`[Pipeline] Locked check ${chunkMs}ms rms=${rms.toFixed(3)}, display=${this._displaySurah}:${this._displayAyah}, whisper=${this._whisperSurah}:${this._whisperAyah}${displayCapped ? ' [force — capped]' : ''}`);

      let text = '';
      let words = [];  // V4: Word timestamps from Whisper
      let resultAgeMs = 0;
      try {
        const audioToSend = applyClipGuard(chunk, rms, this._audioProfile || AUDIO_SOURCE_PROFILES.g2);
        this._applyWhisperPrompt();
        const result = await transcribe(audioToSend, this.whisperOpts, this.onStatus);
        text = result.text || '';
        words = result.words || [];  // V4: Extract word timestamps
        if (text) this._lastPromptText = text;
        resultAgeMs = Date.now() - startedAt;
      } catch (err) {
        console.error('[Pipeline] Transcription error:', err.message?.substring(0, 100));
        this._handleTranscriptionError(err);
        return;
      }

      if (!this.active || this.state.mode !== 'LOCKED') {
        console.log('[Pipeline] Stale locked-check result discarded');
        return;
      }

      // Word-level activity tracking — both Groq and OpenAI return word timestamps.
      // Record the wall-clock time of the last spoken word in this chunk.
      // If > 3s elapsed since then, reciter is in a pause — don't auto-advance.
      if (this.isFastProvider && words.length > 0) {
        const lastWord = words[words.length - 1];
        if (lastWord && typeof lastWord.end === 'number') {
          // lastWord.end is seconds relative to chunk start; startedAt is chunk-start wall-clock.
          this._lastHeardWordMs = startedAt + Math.round(lastWord.end * 1000);
          this._lastHeardWordCount = words.length;
        }
      }

      const cleaned = prepareMatcherText(text.trim());

      if (this.taraweehMode) {
        if (isPrayerTransition(cleaned)) {
          if (this.state.surah > 1) {
            this._preRukuSurah = this.state.surah;
            this._preRukuAyah  = this.state.ayah;
          }
          console.log(`[Pipeline] Taraweeh ${isTakbeer(cleaned) ? 'takbeer' : 'tasmee'} (LOCKED) pos=${this._taraweehPos} saved=${this._preRukuSurah}:${this._preRukuAyah}`);
        } else if (/الله|اكبر|أكبر|سمع/i.test(cleaned) && cleaned.length < 80) {
          console.log(`[Pipeline] Taraweeh LOCKED: Whisper has prayer words but no match: "${cleaned.slice(0, 60)}"`);
        }
      }
      if (this.taraweehMode && isPrayerTransition(cleaned)) {
        this._handleTaraweehTakbeer(true);
        return;
      }

      if (!cleaned || isNoise(cleaned)) {
        return;
      }

      if (isAmeen(cleaned)) {
        if (this.taraweehMode) {
          console.log(`[Pipeline] Ameen detected (LOCKED)`);
          this.onStateUpdate({ type: 'ameen' });
        }
        return;
      }

      if (isBismillahOnly(cleaned)) {
        return;  // generic — don't use to re-anchor or jump
      }

      // Hallucination guard: same text 3x in a row → skip
      this._lastTexts.push(cleaned);
      if (this._lastTexts.length > 3) this._lastTexts.shift();
      if (this._lastTexts.length >= 3 && this._lastTexts.every(t => t === cleaned)) {
        console.log(`[Pipeline] Repeated hallucination — skipping`);
        return;
      }

      const prevSurah = this.state.surah;
      const anchorResult = processWhisperResult(cleaned, this.state, {
        preferredSurah: this.practiceMode ? 0 : this.preferredSurah,
        fastMode: this.fastMode,
        missBeforeResuming: MISSED_BEFORE_RESUMING_V3,
        missBeforeLost: MISSED_BEFORE_LOST_V3,
        isGroqMode: this.isFastProvider,
        practiceMode: this.practiceMode,
        freshRun: this._practiceFreshRun,
      });
      const dropDecision = this._shouldDropLockedResult(anchorResult, resultAgeMs, seq);
      if (dropDecision.drop) {
        if (dropDecision.reason === 'out-of-order') {
          console.log(`[Pipeline] Dropping out-of-order locked result seq=${seq} lastApplied=${this._lockedLastAppliedSeq}`);
        } else {
          console.log(`[Pipeline] Dropping stale locked result age=${resultAgeMs}ms display=${this._displaySurah}:${this._displayAyah} candidate=${anchorResult.surah}:${anchorResult.ayah}`);
        }
        return;
      }
      if (seq > 0) this._lockedLastAppliedSeq = Math.max(this._lockedLastAppliedSeq, seq);

      if (anchorResult.mode !== 'LOCKED') {
        if (this.practiceMode) {
          this._tryPracticeSnapFromMatches(anchorResult, words);
          this._emitState(text, rms);
          return;
        }
        // Don't cancel the timer — keep the display flowing at the measured
        // pace while we try to re-lock. The display keeps advancing so the
        // user sees continuous verses, not "Synchronizing".
        console.log(`[Pipeline] Anchor lost lock — searching in background (display continues at ${this._displaySurah}:${this._displayAyah})`);
        this.state = anchorResult;
        this._whisperLastConfirmMs = 0;
        this._resetSearchBuf();
        this._lockedSeq = Math.max(this._lockedSeq, seq);
        this._emitState(text, rms);
      } else if (anchorResult.surah !== prevSurah && anchorResult.surah !== 0 && !this.practiceMode) {
        console.log(`[Pipeline] Surah mismatch: display=${this._displaySurah} whisper=${anchorResult.surah} — releasing lock to re-search`);
        this._cancelReadAdvance();
        this._measuredWps = READ_WORDS_PER_SEC;
        this._resetSearchBuf();
        this.state = createState();
        this._emitState(text, rms);
        return;
      } else {
        if (this.practiceMode) {
          this._tryPracticeSnapFromMatches(anchorResult, words);
          this._emitState(text, rms);
          return;
        }
        // Let anchor track the reciter independently, but don't let it drift
        // too far behind the display. Stale Whisper audio can back-correct the
        // anchor to a position the display already passed — clamp it so the
        // next spotCheck scans near the display, not way behind.
        let finalResult = anchorResult;
        const edge = this._leadingEdgeAyah(anchorResult.surah, anchorResult.ayah, words);
        if (edge) {
          console.log(`[Pipeline] Leading edge: window matched :${anchorResult.ayah} but newest ${edge.tailWords} words are :${edge.ayah} (score=${edge.score.toFixed(2)}) — tracking :${edge.ayah}`);
          finalResult = { ...finalResult, ayah: edge.ayah, lastLockedAyah: edge.ayah };
        }
        if (!this.practiceMode) {
          const minAnchorAyah = Math.max(1, this._displayAyah - 2);
          if (finalResult.surah === this._displaySurah && finalResult.ayah < minAnchorAyah) {
            finalResult = { ...finalResult, ayah: minAnchorAyah };
          }
        }
        this.state = finalResult;
        const realMatch = !!finalResult._locked;
        this._onWhisperConfirm(finalResult.surah, finalResult.ayah, finalResult.confidence, text, rms, realMatch, words);  // V4: Pass words
      }
    } catch (err) {
      console.error('[Pipeline] Locked chunk error:', err.message);
    } finally {
      this._lockedInFlight = Math.max(0, this._lockedInFlight - 1);
      this.processing = this._lockedInFlight > 0;
      // If enough buffered audio is already waiting, run the next spot check
      // immediately instead of waiting for another ingest tick.
      setTimeout(() => this._maybeProcessLockedBufferedChunk(), 0);
    }
  }

  // ── Core V2: single handler for Whisper confirmations in LOCKED mode ───────

  _onWhisperConfirm(confirmedSurah, confirmedAyah, score, text, rms, realMatch = true, words = []) {  // V4: Added words parameter
    const sameSurah = confirmedSurah === this._displaySurah;

    // ── Ratchet _whisperAyah forward only on REAL matches ──────────────────
    // Noise results carry the anchor's stale position — not actual Whisper confirmation.
    // Ratcheting on noise would let display race ahead unchecked.
    if (realMatch && (!sameSurah || confirmedAyah > this._whisperAyah)) {
      this._updateWpsClock(confirmedSurah, confirmedAyah);
      this._whisperSurah = confirmedSurah;
      this._whisperAyah  = confirmedAyah;
    }

    // Practice mode: sync display to heard verse only — no timers or catch-up.
    if (this.practiceMode) {
      this._cancelReadAdvance();
      const confPct = this._practiceConfPct(score);
      if (realMatch && confPct >= 18) {
        this._snapPracticeVerse(confirmedSurah, confirmedAyah, score, words);
      }
      this._emitState(text, rms);
      return;
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
      const refrainVerse = isRefrain(confirmedSurah, confirmedAyah);
      const lag = this._displayAyah - confirmedAyah;
      // Post-back-correction cooldown: don't snap back again right away —
      // UNLESS the drift has grown worse since the last correction (e.g. we
      // snapped at lag=2, drift is now lag=3+). Escalating drift should break
      // the cooldown so the display catches the reciter faster.
      const inCooldown = this._lastBackCorrectMs && (Date.now() - this._lastBackCorrectMs) < BACK_CORRECT_COOLDOWN_MS;
      if (inCooldown && lag < 3) {
        console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} — ignoring (back-correct cooldown, lag=${lag})`);
        this._emitState(text, rms);
        return;
      }
      // Snap-back disabled for lag ≤ 2. Field feedback: display snapping back
      // ~1s after every ayah (aggressive Groq lag=2 trigger) hurt readability
      // more than it helped. Normal 1-2 ayah drift is within Whisper latency
      // and resolves itself as the reciter continues. Only genuine drift
      // (lag ≥ 3 with repeat-count confirmations) still snaps below.
      if (lag <= 2) {
        this._emitState(text, rms);
        return;
      }
      // lag≥3 still follows the repeat-count gate — real drift, not jitter.
      const REPEAT_BACK_CORRECT_WINS = score >= 80 ? 2 : 3;
      const REPEAT_BACK_CORRECT_MIN_CONF = this.isFastProvider ? 45 : 65;

      // ── Repeat tracking (genuine reciter repeats, not mishear) ───────
      if (!refrainVerse && confirmedAyah === this._behindRepeatAyah && score >= REPEAT_BACK_CORRECT_MIN_CONF) {
        this._behindRepeatCount++;
      } else {
        this._behindRepeatAyah  = confirmedAyah;
        this._behindRepeatCount = refrainVerse ? 0 : 1;
      }

      if (this._behindRepeatCount >= REPEAT_BACK_CORRECT_WINS) {
        const backDist = this._displayAyah - confirmedAyah;
        // Large back-corrections (4+) snap immediately if confirmed — don't block
        if (backDist > 3) {
          console.log(`[Pipeline] Large back-correct: dist=${backDist} — snapping (${this._behindRepeatCount}x confirmed, conf=${score}%)`);
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

      // ── Stop timer while behind: pause display advancement ────
      // When reciter is behind, don't keep advancing forward. Cancel timer and wait
      // for confirmation before resuming. This prevents runaway drift during repeats.
      if (score >= REPEAT_BACK_CORRECT_MIN_CONF) {
        this._cancelReadAdvance();
        this._driftMult = Math.min(2.5, this._driftMult + 0.25);
        console.log(`[Pipeline] Timer paused: Whisper :${confirmedAyah} behind display :${this._displayAyah} (lag=${lag}, conf=${score}%, repeat=${this._behindRepeatCount}/${REPEAT_BACK_CORRECT_WINS}${refrainVerse ? ', refrain' : ''})`);
      } else {
        // Low confidence — keep timer running with drift multiplier
        this._driftMult = Math.min(2.5, this._driftMult + 0.25);
        console.log(`[Pipeline] Whisper :${confirmedAyah} behind display :${this._displayAyah} (lag=${lag}, conf=${score}%, drift=${this._driftMult.toFixed(2)}x, repeat=${this._behindRepeatCount}/${REPEAT_BACK_CORRECT_WINS}${refrainVerse ? ', refrain' : ''})`);  
      }
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
    if (confirmedAyah === this._displayAyah) {
      this._driftMult = 1.0;
      if (realMatch) this._sameAyahStreak++;
      if (this._displayAdvanceTimer && this._timerStartedAt) {
        const elapsed = Date.now() - this._timerStartedAt;
        const remaining = Math.max(0, this._nextAdvanceMs - elapsed);
        // GROQ RECITER-HOLD: Groq keeps hearing the SAME ayah (streak≥2)
        // and the timer is about to fire. Reciter is lingering/repeating —
        // reset the timer so display doesn't race ahead. Groq's 300ms
        // latency makes this signal reliable; HF's 6s lag makes it risky,
        // so HF keeps old behaviour (let timer run).
        if (this.isFastProvider && realMatch && this._sameAyahStreak >= 2 && remaining < 2500) {
          const holdMs = Math.max(3000, this._measuredMsPerWord > 0 ? this._measuredMsPerWord * 3 : 3000);
          this._cancelReadAdvance();
          this._scheduleReadAdvance(score, 0, 1.0, holdMs);
          console.log(`[Pipeline] Groq hold: reciter lingering on :${confirmedAyah} (streak=${this._sameAyahStreak}) — extended timer to ${holdMs}ms`);
          this._emitState(text, rms);
          return;
        }
        console.log(`[Pipeline] Whisper ${realMatch ? 'confirms' : 'noise→'} :${confirmedAyah} (${Math.round(remaining/1000)}s left, streak=${this._sameAyahStreak})`);
      } else {
        console.log(`[Pipeline] Whisper ${realMatch ? 'confirms' : 'noise→'} :${confirmedAyah} (streak=${this._sameAyahStreak})`);
        if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
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
      // Gap 1: snapping here caused visible jitter, but ignoring it entirely left
      // the display a full ayah behind until its own timer happened to expire —
      // which is most of why tracking trailed the reciter. Compress the remaining
      // time instead: the display closes the gap within a second, and it still
      // arrives as a normal advance rather than a jump.
      if (gap === 1) {
        if (GAP1_NUDGE_MS > 0 && this.isFastProvider && realMatch && score >= 35
            && this._displayAdvanceTimer && this._timerStartedAt) {
          const remaining = Math.max(0, this._nextAdvanceMs - (Date.now() - this._timerStartedAt));
          if (remaining > GAP1_NUDGE_MS) {
            console.log(`[Pipeline] Gap-1 nudge: Whisper :${confirmedAyah} vs display :${this._displayAyah} — ${Math.round(remaining)}ms left, advancing in ${GAP1_NUDGE_MS}ms`);
            this._cancelReadAdvance();
            this._scheduleReadAdvance(score, 0, 1.0, GAP1_NUDGE_MS);
          }
        }
        this._emitState(text, rms);
        return;
      }
      // GROQ: snap immediately for gap ≥ 2 (user asked: only intervene when
      // we're "way off, like 2 or 3 ayahs"). Groq is authoritative.
      if (this.isFastProvider && score >= 35) {
        this._cancelReadAdvance();
        console.log(`[Pipeline] Groq catch-up snap: :${this._displayAyah} → :${confirmedAyah} (gap=${gap}, conf=${score}%)`);
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
      const stepMs = gap >= 4 ? 2000 : gap >= 3 ? 1600 : SMOOTH_ADVANCE_STEP_MS;
      console.log(`[Pipeline] Whisper :${confirmedAyah} ahead of display :${this._displayAyah} — catch-up (${gap} steps, ${stepMs}ms/step)`);
      this._smoothAdvanceTo(confirmedSurah, confirmedAyah, stepMs);
    } else if (gap > 6 && (score >= 70 || this._forwardJumpConfirmed(confirmedSurah, confirmedAyah))) {
      // Large forward gap. A single high-confidence match snaps immediately;
      // otherwise repeated agreement stands in for confidence. Requiring score
      // >= 70 alone stranded the display for minutes when the reciter picked up
      // further down the surah, because a correct wide-scan match on a partial
      // window scores well below that even when it repeats.
      this._forwardJumpAyah = 0;
      this._forwardJumpCount = 0;
      this._cancelReadAdvance();
      this._displaySurah = confirmedSurah;
      this._displayAyah  = confirmedAyah;
      this._ayahStartTime = Date.now();
      this._lockTime = this._ayahStartTime;
      this.state = { ...this.state, surah: confirmedSurah, ayah: confirmedAyah,
        lastLockedSurah: confirmedSurah, lastLockedAyah: confirmedAyah };
      console.log(`[Pipeline] Whisper :${confirmedAyah} jumped ${gap} ahead of display :${this._displayAyah} — snapping (conf=${score}%)`);
      this._emitState(text, rms);
      this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE), 0, CORRECTED_DURATION_FACTOR);
      return;
    } else if (gap > 6) {
      console.log(`[Pipeline] Whisper :${confirmedAyah} jumped ${gap} ahead of display :${this._displayAyah} — awaiting confirmation ${this._forwardJumpCount}/${FORWARD_JUMP_CONFIRMS} (conf=${score}%)`);
      if (!this._displayAdvanceTimer && !this._smoothAdvanceTimer) {
        this._scheduleReadAdvance(Math.max(score, READ_ADVANCE_CONFIDENCE));
      }
      this._emitState(text, rms);
    }

    // V4: Word-level tracking - learn pace and snap current word from Whisper timestamps
    if (words.length > 0 && realMatch) {
      this._wordTimestamps = words;
      this._learnWordPaceFromTimestamps();
      // Perfect reciter sync: snap current word from Whisper when we're on this ayah
      if (confirmedSurah === this._displaySurah && confirmedAyah === this._displayAyah) {
        const ayah = getAyah(this._displaySurah, this._displayAyah);
        const totalWords = ayah?.words?.length ?? 0;
        if (totalWords > 0) {
          // Use word count from Whisper (never go backward) for reciter sync
          const whisperWordIndex = Math.min(words.length, totalWords) - 1;
          this._currentWordIndex = Math.max(this._currentWordIndex, Math.min(whisperWordIndex, totalWords - 1));
          // Align lock time so timer-based progress continues from this word (smooth advance)
          const msPerWord = this._measuredMsPerWord || 700;
          this._lockTime = Date.now() - this._currentWordIndex * msPerWord;
        }
      }
    }
    // Update word progress display
    if (confirmedSurah === this._displaySurah && confirmedAyah === this._displayAyah) {
      this._updateWordProgress();
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
        // Count words BETWEEN confirmations — exclude the starting ayah (already timed)
        let totalWords = 0;
        for (let a = fromAyah + 1; a <= toAyah; a++) {
          const v = getVerseData(confirmedSurah, a, this.translationLang);
          totalWords += v?.transliteration
            ? v.transliteration.split(/\s+/).length
            : (v?.arabic ? v.arabic.split(/\s+/).length : 4);
        }
        if (totalWords === 0) totalWords = 4; // safety fallback for single-ayah jump
        const rawWps = totalWords / (elapsedMs / 1000);
        const clampedWps = Math.max(0.5, Math.min(5.0, rawWps));
        // Blend: HF uses 0.7 old / 0.3 new (conservative — HF clock is noisy).
        // Groq uses 0.4 old / 0.6 new — Groq confirms are accurate, so the pacer
        // should follow reciter speed changes quickly (taraweeh tempo shifts).
        const oldWeight = this.isFastProvider ? 0.4 : 0.7;
        const newWeight = 1 - oldWeight;
        this._measuredWps = this._measuredWps * oldWeight + clampedWps * newWeight;
        // Sync _measuredMsPerWord from Whisper clock.
        //  - No manual samples: always sync.
        //  - Manual samples exist + Groq mode: still sync, Groq is accurate enough
        //    to override stale manual pace from earlier in the session.
        //  - Manual samples exist + HF mode: keep manual (historical behaviour —
        //    HF clock is noisier and user's manual taps are more trustworthy).
        const whisperMsPerWord = Math.round(1000 / this._measuredWps);
        // This clock divides words by the gap between CONFIRMATIONS, which is
        // quantised to the spot-check interval and includes breaths, so it reads
        // far slower than the reciter actually speaks. Word timestamps measure
        // speaking rate directly, so once we have those, never let this override
        // them — doing so is what stretched every timer and made the display lag.
        const haveWordPace = (this._wordPaceSamples || 0) > 0;
        const shouldSync = !haveWordPace
          && (this._msPerWordSamples.length === 0 || this.isFastProvider);
        if (shouldSync) {
          this._measuredMsPerWord = whisperMsPerWord;
          this._whisperClockSamples++;
        }
        const syncTag = shouldSync
          ? (this._msPerWordSamples.length > 0 ? ' [Groq override: synced]' : '')
          : ` [${haveWordPace ? 'word-timestamp' : 'manual'} pace kept: ${this._measuredMsPerWord}ms/w]`;
        console.log(`[Pipeline] Whisper clock: ${totalWords}w in ${(elapsedMs/1000).toFixed(1)}s = ${rawWps.toFixed(2)} wps → measured=${this._measuredWps.toFixed(2)} wps (${whisperMsPerWord}ms/w)${syncTag}`);

        // Whatever this interval contained beyond the words themselves was the
        // reciter breathing. That is the one thing the confirmation clock does
        // measure well, and the timer needs it as an additive term.
        const ayahsAdvanced = toAyah - fromAyah;
        if (haveWordPace && ayahsAdvanced >= 1 && ayahsAdvanced <= 3) {
          const speechMs = totalWords * this._measuredMsPerWord;
          const perAyahPause = (elapsedMs - speechMs) / ayahsAdvanced;
          const clamped = Math.max(0, Math.min(PAUSE_EST_MAX_MS, perAyahPause));
          this._measuredPauseMs = Math.round(this._measuredPauseMs * 0.7 + clamped * 0.3);
          console.log(`[Pipeline] Ayah pause: ${Math.round(perAyahPause)}ms observed over ${ayahsAdvanced} ayah(s) → ${this._measuredPauseMs}ms`);
        }

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

  // V4: Learn pace from word-level timestamps
  _learnWordPaceFromTimestamps() {
    if (this._wordTimestamps.length < 2) return;

    // Pace is the onset-to-onset PERIOD, not how long a word is voiced for.
    // Measuring (end - start) omits the gap before the next word, so it always
    // reads faster than the reciter and the two errors have to be cancelled out
    // elsewhere. Take the interval between successive word onsets instead.
    const onsets = this._wordTimestamps
      .map(w => (typeof w.start === 'number' ? w.start
        : (Array.isArray(w.timestamp) ? w.timestamp[0] : NaN)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (onsets.length < 2) {
      console.log(`[Pipeline] Word pace skipped: no valid timestamps in ${this._wordTimestamps.length} words`);
      return;
    }

    // Drop malformed frames and end-of-ayah breaths: a breath is not part of the
    // speaking rate, and including it stretches every subsequent timer.
    const periods = [];
    for (let i = 1; i < onsets.length; i++) {
      const d = (onsets[i] - onsets[i - 1]) * 1000;
      if (d >= 120 && d <= 2500) periods.push(d);
    }
    if (periods.length === 0) return;

    // Median, not mean — one long madd or a missed word should not move the pace.
    periods.sort((a, b) => a - b);
    const medianMs = periods[Math.floor(periods.length / 2)];
    if (!Number.isFinite(medianMs) || medianMs <= 0) return;

    // Groq/OpenAI timestamps are reliable, so follow tempo shifts quickly.
    const oldWeight = this.isFastProvider ? 0.6 : 0.75;
    this._measuredMsPerWord = this._measuredMsPerWord > 0
      ? Math.round(this._measuredMsPerWord * oldWeight + medianMs * (1 - oldWeight))
      : Math.round(medianMs);
    this._measuredWps = 1000 / this._measuredMsPerWord;
    this._wordPaceSamples = (this._wordPaceSamples || 0) + 1;

    console.log(
      `[Pipeline] Word pace from timestamps: median ${medianMs.toFixed(0)}ms/word ` +
      `(${periods.length} intervals of ${onsets.length} words) → ${this._measuredMsPerWord}ms/w ` +
      `(${this._measuredWps.toFixed(2)} wps)`
    );
  }

  // V4: Update word progress and emit to frontend
  // Uses corpus word weights for proportional timing — heavy words (madd, verbs) get more time
  _updateWordProgress() {
    const ayah = getAyah(this._displaySurah, this._displayAyah);
    if (!ayah) return;

    const totalWords = ayah.words.length;
    if (totalWords === 0) return;

    const elapsedMs = Date.now() - this._lockTime;
    const msPerWord = this._measuredMsPerWord || 700;

    // Use corpus weights for proportional word timing
    const wordData = getWordData(this._displaySurah, this._displayAyah);
    if (wordData?.words?.length === totalWords) {
      // Weighted progress: accumulate weights until elapsed time is consumed
      const totalWeight = wordData.tw || totalWords;
      const totalDurationMs = totalWeight * msPerWord;
      let accumulated = 0;
      let wordIdx = 0;
      for (let i = 0; i < wordData.words.length; i++) {
        accumulated += wordData.words[i].w;
        const wordEndMs = (accumulated / totalWeight) * totalDurationMs;
        if (elapsedMs < wordEndMs) { wordIdx = i; break; }
        wordIdx = i;
      }
      this._currentWordIndex = Math.max(0, Math.min(wordIdx, totalWords - 1));
    } else {
      // Fallback: uniform word timing
      this._currentWordIndex = Math.max(0, Math.min(
        Math.floor(elapsedMs / msPerWord),
        totalWords - 1
      ));
    }

    // Emit word progress to frontend
    this.onStateUpdate({
      type: 'wordProgress',
      surah: this._displaySurah,
      ayah: this._displayAyah,
      wordIndex: this._currentWordIndex,
      totalWords: totalWords,
      progress: (this._currentWordIndex + 1) / totalWords,
      words: ayah.words,
    });
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
    if (this.practiceMode) return false;

    // End-of-surah exception: if we're on the last ayah, let the timer run even
    // during silence. Firing it is the trigger that resets state to SEARCHING;
    // blocking it would leave us frozen on the final ayah waiting for words
    // that'll never come (imam moves to next surah).
    const onLastAyah = this._displaySurah > 0 && this._displayAyah > 0
      && !getVerseData(this._displaySurah, this._displayAyah + 1, this.translationLang);

    // Silence hold, from the mic rather than from Whisper. The reciter pausing is
    // the clearest possible signal not to advance, but word timestamps only
    // arrive once per spot check, so they cannot resolve a breath shorter than
    // that interval — which is why this used to be driven by _lastHeardWordMs,
    // misfire during normal recitation, and end up switched off in Taraweeh.
    // The voice gate samples every ~85ms, so use it: hold through the breath,
    // and bound the hold so a mis-tuned gate can never freeze the display.
    if (!onLastAyah && this._lastDetectedVoiceAt > 0) {
      const silenceMs = Date.now() - this._lastDetectedVoiceAt;
      if (silenceMs > DISPLAY_HOLD_SILENCE_MS && silenceMs < DISPLAY_HOLD_MAX_MS) {
        if (!this._lastSilenceLogMs || (Date.now() - this._lastSilenceLogMs) > 2000) {
          console.log(`[Pipeline] Silence hold: ${silenceMs}ms since last voice — display waits on :${this._displayAyah}`);
          this._lastSilenceLogMs = Date.now();
        }
        return false;
      }
    }
    return this._displaySurah > 0 && this._displayAyah > 0
      && (this.state.mode === 'LOCKED' || this.state.mode === 'RESUMING' || this.state.mode === 'SEARCHING');
  }

  /**
   * Where is the reciter *now*? Re-match only the newest words of the window so
   * a confirmation reflects the leading edge of the recitation rather than the
   * ayah that happened to fill most of the window. Returns null unless the tail
   * gives solid, forward-only evidence, so this can correct lag but never invent
   * a jump or drag the display backwards.
   */
  _leadingEdgeAyah(surah, ayah, words) {
    if (LEADING_EDGE_TAIL_MS <= 0) return null;
    if (!this.isFastProvider || !Array.isArray(words) || words.length < LEADING_EDGE_MIN_WORDS) return null;
    const lastEnd = words[words.length - 1]?.end;
    if (typeof lastEnd !== 'number' || !Number.isFinite(lastEnd)) return null;
    const cutoff = lastEnd - LEADING_EDGE_TAIL_MS / 1000;
    const tail = words.filter((w) => typeof w.end === 'number' && w.end >= cutoff);
    if (tail.length < LEADING_EDGE_MIN_WORDS) return null;

    const probe = spotCheck(tail.map((w) => w.word).join(' '), surah, ayah, LEADING_EDGE_MAX_ADVANCE);
    if (!probe.found || probe.surah !== surah) return null;
    const advance = probe.ayah - ayah;
    if (advance <= 0 || advance > LEADING_EDGE_MAX_ADVANCE) return null;
    if (probe.score < LEADING_EDGE_MIN_SCORE) return null;
    if ((probe.matchedWords?.length ?? 0) < LEADING_EDGE_MIN_WORDS) return null;
    return { surah: probe.surah, ayah: probe.ayah, score: probe.score, tailWords: tail.length };
  }

  /**
   * A far-ahead position is believable once Whisper reports it more than once and
   * the reports are consistent (equal, or still moving forward). Counts as
   * evidence in place of a single-shot confidence score.
   */
  _forwardJumpConfirmed(surah, ayah) {
    if (surah !== this._displaySurah) return false;
    const consistent = this._forwardJumpAyah > 0
      && ayah >= this._forwardJumpAyah
      && (ayah - this._forwardJumpAyah) <= FORWARD_JUMP_DRIFT;
    this._forwardJumpCount = consistent ? this._forwardJumpCount + 1 : 1;
    this._forwardJumpAyah = ayah;
    return this._forwardJumpCount >= FORWARD_JUMP_CONFIRMS;
  }

  _isDisplayCapped() {
    return this._whisperSurah > 0
      && this._whisperSurah === this._displaySurah
      && this._whisperAyah > 0
      && (this._displayAyah - this._whisperAyah) >= this._maxDisplayLead;
  }

  _scheduleReadAdvance(confidence, afterPauseMinMs = 0, durationFactor = 1.0, overrideDurationMs = 0) {
    this._cancelReadAdvance();
    if (this.practiceMode || !this._canDisplayAdvance()) return;

    let durationMs;
    if (overrideDurationMs > 0) {
      // Resume from paused timer — skip all calculation, use exact remaining time
      durationMs = overrideDurationMs;
      console.log(`[Pipeline] Read-advance in ${durationMs}ms [resumed from pause]`);
    } else {

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
        console.log(`[Pipeline] Display BLOCKED: :${this._displayAyah} (whisper :${this._whisperAyah}, lead=${this._displayAyah - this._whisperAyah}, ${Math.round(blockedFor/1000)}s) -- waiting for Whisper`);
        const syncWaitMs = Math.max(250, BLOCKED_FORCE_UNBLOCK_MS - blockedFor);
        this._syncingDisplay = true;
        this._nextAdvanceMs = syncWaitMs;
        this._timerStartedAt = now;
        this._displayAdvanceTimer = setTimeout(() => {
          this._displayAdvanceTimer = null;
          this._nextAdvanceMs = 0;
          this._timerStartedAt = 0;
          if (!this.active || this.state.mode !== 'LOCKED') return;
          this._scheduleReadAdvance(confidence, afterPauseMinMs, durationFactor, overrideDurationMs);
        }, syncWaitMs);
        this._emitState(null, null);
        return;
      }
      // Force-unblock: assume timer-based position is correct, catch up whisperAyah
      console.log(`[Pipeline] FORCE-UNBLOCK: :${this._displayAyah} blocked for ${Math.round(blockedFor/1000)}s — advancing whisper :${this._whisperAyah} → :${this._displayAyah}`);
      this._whisperSurah = this._displaySurah;
      this._whisperAyah  = this._displayAyah;
      this._blockedSince = 0;
      this._cappedRecoveryChecks = 0;
    } else {
      this._blockedSince = 0;  // not blocked anymore
      this._cappedRecoveryChecks = 0;
    }
    this._syncingDisplay = false;

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

    // Corpus-based word weights: each word has a weight based on morphology + tajweed
    // totalWeight replaces simple wordCount — heavier words (madd, ghunnah, verb forms) get more time
    const wordData = getWordData(this._displaySurah, this._displayAyah);
    // Blend corpus weight (80%) with plain word count (20%) — pure weights add ~5s extra per ayah
    const rawWeight = wordData?.tw || wordCount;
    const totalWeight = wordData ? (rawWeight * 0.8 + wordCount * 0.2) : wordCount;
    const hasMadds = wordData?.madds || 0;
    const hasGhunnahs = wordData?.ghunnahs || 0;

    // Elongation bonus from transliteration (fallback when no corpus data)
    const strongElong = wordData ? 0 : (translit.match(/AA|ee|oo|aa|ii|uu/gi) || []).length;
    const noonEndings = wordData ? 0 : (translit.match(/oon|een|aan/gi) || []).length;
    const elongBonusMs = strongElong * 200 + noonEndings * 150;

    // Word-weight-based timer derived from measured reciter pace.
    // Live data shows ~1.9s/word for slow reciters, ~0.9s for normal, ~0.5s for fast.
    // Whisper confirms hold/extend if reciter is still on the ayah.
    // Use learned pace if available, otherwise fallback defaults
    // Base default 1400ms/w. Fast/slow nudge it ±30%. Learned pace overrides.
    // Fast mode ~700ms/word (half again faster than normal) so tight khatam-pace
    // recitation doesn't lag the display. Slow mode extends. Normal = 1400.
    const defaultMsPerWord = this.fastMode ? 700 : this.slowMode ? 1800 : 1400;
    // Trust manual pace after 1 sample (direct user feedback). Word timestamps
    // come straight from the ASR and measure the reciter's actual speaking rate,
    // so one sample is enough there too — waiting on the confirmation-interval
    // clock (3 samples) meant the first several ayahs always ran at the 1400ms
    // default, which is far slower than most reciters and put the display behind
    // before tracking had a chance to settle.
    const paceLearned = this._msPerWordSamples.length >= 1
      || (this._wordPaceSamples || 0) >= 1
      || this._whisperClockSamples >= 3;
    const msPerWord = (this._measuredMsPerWord > 0 && paceLearned)
      ? this._measuredMsPerWord : defaultMsPerWord;
    // Corpus weights spread a *generic* rate across heavy and light words, which
    // is only useful while msPerWord is still the default. A pace measured from
    // real word timestamps already contains this reciter's elongations, so
    // multiplying by the weights again double-counts them and stretches every
    // timer. Once pace is learned, time plain words and add the learned breath.
    const timingUnits = paceLearned ? wordCount : totalWeight;
    const rawMs = Math.round(timingUnits * msPerWord)
      + (paceLearned ? 0 : elongBonusMs)
      + this._measuredPauseMs;
    // Short ayahs (≤4 words, common in juz 30 khatam) get a lower floor — 1.5s instead
    // of 2.5s. On khatam nights the imam races through these; 2.5s floor causes the
    // display to lag behind by 2-3 ayahs, making tracking useless.
    const shortAyahFloor = wordCount <= 4 ? 1500 : 2500;
    // Fast mode drops the floor more aggressively: 1s on ≤4-word ayahs, 1.5s otherwise.
    // This matters for khatam-night juz-30 racing where 2.5s floors stall the display.
    const fastFloor = wordCount <= 4 ? 1000 : 1500;
    // A floor longer than the ayah itself is pure lag. Once pace is measured we
    // know how long this ayah takes, so never stretch past that — a khatam-pace
    // ayah can genuinely be shorter than the 2.5s default floor.
    const fixedFloor = this.slowMode ? 6000 : (this.fastMode ? fastFloor : shortAyahFloor);
    const floorMs = Math.max(afterPauseMinMs,
      paceLearned && !this.slowMode ? Math.min(fixedFloor, rawMs) : fixedFloor);
    const baseDurationMs = Math.max(rawMs, floorMs);
    // Per-word-count ceilings prevent short ayahs getting taraweeh-absurd timers
    // even when learned pace drifts slow. Taraweeh imams typically take:
    //   3-5 words: ~2-4s      → cap 5s
    //   6-10 words: ~3-6s     → cap 8s
    //   11-20 words: ~7-12s   → cap 16s
    //   21+ words: ~15-22s    → cap 25s
    const fixedCap = wordCount <= 5 ? 5000
      : wordCount <= 10 ? 8000
      : wordCount <= 20 ? 16000
      : 25000;
    // These absolute ceilings existed to contain a pace estimate that drifted
    // slow. Once pace comes from word timestamps and the breath is measured, they
    // become the binding constraint on any genuinely slow reciter: a 9-word ayah
    // with a 4s breath needs ~9.7s and was being cut to 8s, so the display ran
    // ahead for the rest of the surah. Keep them as a sanity bound on our own
    // estimate rather than an absolute one.
    const perCountCap = paceLearned ? Math.max(fixedCap, Math.round(rawMs * 1.25)) : fixedCap;
    durationMs = Math.min(Math.round(baseDurationMs), perCountCap, READ_ADVANCE_MAX_MS);
    // Groq cushion: pad by 20% so display naturally lingers toward Groq's heard
    // position instead of racing 1 ayah ahead on slow recitations. Groq will
    // snap us forward if we truly fall behind. Skip entirely in fast mode —
    // fast reciters need the opposite (shorter, not padded).
    // Kept flat on purpose. Scaling this by word pace was tried and measured
    // worse: two imams can share a word pace and differ entirely in how long
    // they pause, and pause length is already modelled additively above. Tying
    // the cushion to words-per-second made long-breath recitation overshoot
    // (74.9% -> 25.3% exact) while barely helping khatam pace.
    if (this.isGroqMode && !this.fastMode && GROQ_TIMER_CUSHION !== 1) {
      durationMs = Math.min(Math.round(durationMs * GROQ_TIMER_CUSHION), READ_ADVANCE_MAX_MS);
    }
    // Slow-mode user override: explicit "stretch everything" multiplier that
    // rides on top of learned pace. Cap the caps — perCountCap becomes 2x too.
    if (this.slowMode) {
      durationMs = Math.min(Math.round(durationMs * 1.5), perCountCap * 2, READ_ADVANCE_MAX_MS);
    }
    if (durationFactor < 1.0) {
      // Whisper data is ~6s old. Subtract pipeline lag — but never more than half
      // the timer. Short ayahs (3-6 words) shouldn't get crushed to 1s.
      const PIPELINE_LAG_MS = 6000;
      const maxSubtract = Math.floor(durationMs * 0.5);
      const minAfterLag = wordCount <= 4 ? 1500 : 3000;
      durationMs = Math.max(minAfterLag, durationMs - Math.min(PIPELINE_LAG_MS, maxSubtract));
    }

    const modeTag = this.fastMode ? ' [FAST]' : this.slowMode ? ' [SLOW]' : '';
    const halfTag = durationFactor < 1.0 ? (durationFactor <= FIRST_LOCK_DURATION_FACTOR + 0.05 ? ' [first-lock]' : ' [corrected]') : '';
    const weightTag = wordData ? ` wt=${totalWeight.toFixed(1)}` : '';
    console.log(`[Pipeline] Read-advance in ${durationMs}ms (${wordCount}w${weightTag} × ${msPerWord}ms/w, conf=${confidence}%${modeTag}${halfTag})`);

    } // end of normal (non-override) duration calculation

    this._nextAdvanceMs  = durationMs;
    this._timerStartedAt = Date.now();
    
    // V4: Start word progress updates (every 200ms)
    if (this._wordProgressInterval) clearInterval(this._wordProgressInterval);
    this._wordProgressInterval = setInterval(() => {
      this._updateWordProgress();
    }, 200);  // 5 FPS
    
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

        // Taraweeh khatam: after Fatiha (surah 1) ends and we have a saved position,
        // pre-display the continuation immediately instead of going blank.
        // This eliminates the "confused blank screen" after Fatiha on khatam nights.
        const taraweehResume = this.taraweehMode && prevSurah === 1 && this._preRukuSurah > 1;
        const resumeAyah = taraweehResume ? this._preRukuAyah + 1 : 0;
        const resumeSurah = taraweehResume ? this._preRukuSurah : 0;
        const resumeData = taraweehResume ? getVerseData(resumeSurah, resumeAyah, this.translationLang) : null;

        if (taraweehResume && resumeData) {
          // Pre-display continuation from where imam left off before ruku
          this._displaySurah = resumeSurah;
          this._displayAyah  = resumeAyah;
          this._whisperSurah = resumeSurah;
          this._whisperAyah  = resumeAyah;
          this._ayahStartTime = Date.now();
          this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
            surah: resumeSurah, ayah: resumeAyah,
            lastLockedSurah: resumeSurah, lastLockedAyah: resumeAyah };
          console.log(`[Pipeline] Taraweeh: Fatiha done → pre-display khatam continuation ${resumeSurah}:${resumeAyah}`);
          this._scheduleReadAdvance(Math.max(this.state.confidence, 50));
        } else if (false) {  // DISABLED: end-of-surah auto-jump to next surah
          // Previously pre-displayed the sequentially-next surah:1 after any surah
          // ended. Taraweeh imams choose their own surah order (not sequential),
          // so this was wrong in most real cases. Now we fall through to the
          // SEARCHING branch below — display shows "Listening…" / last verse and
          // re-locks based on what the reciter actually recites next.
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
        this._lockTime = this._ayahStartTime;  // V4: Track lock time for word progress
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
      this._driftMult    = 1.0;
      this._measuredWps  = READ_WORDS_PER_SEC;
      this._behindRepeatCount = 0;
      this._behindRepeatAyah  = 0;
      this._sameAyahStreak = 0;
      this._bumpCountForAyah = 0;

      // Taraweeh khatam: after Fatiha, pre-display continuation
      const taraweehResume = this.taraweehMode && prevSurah === 1 && this._preRukuSurah > 1;
      const rAyah = taraweehResume ? this._preRukuAyah + 1 : 0;
      const rSurah = taraweehResume ? this._preRukuSurah : 0;
      const rData = taraweehResume ? getVerseData(rSurah, rAyah, this.translationLang) : null;

      if (taraweehResume && rData) {
        this._displaySurah = rSurah;
        this._displayAyah  = rAyah;
        this._whisperSurah = rSurah;
        this._whisperAyah  = rAyah;
        this.state = { ...this.state, mode: 'LOCKED', missedChunks: 0,
          surah: rSurah, ayah: rAyah,
          lastLockedSurah: rSurah, lastLockedAyah: rAyah };
        console.log(`[Pipeline] Pause-advance: Fatiha done → khatam continuation ${rSurah}:${rAyah}`);
        this._scheduleReadAdvance(Math.max(this.state.confidence, 50));
      } else {
        this._displaySurah = 0;
        this._displayAyah  = 0;
        this._whisperSurah = 0;
        this._whisperAyah  = 0;
        this.state = { ...createState(), mode: 'SEARCHING',
          lastLockedSurah: prevSurah, lastLockedAyah: prevAyah };
        this._restorePreRukuIfNeeded(prevSurah);
        this._resetSearchBuf();
        console.log(`[Pipeline] Pause-advance: end of surah ${prevSurah} — soft reset, searching for next`);
      }
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
    if (this.practiceMode) return;
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
    // V4: Clear word progress interval
    if (this._wordProgressInterval) { clearInterval(this._wordProgressInterval); this._wordProgressInterval = null; }
    this._nextAdvanceMs  = 0;
    this._timerStartedAt = 0;
    this._pauseAccumMs   = 0;
    this._syncingDisplay = false;
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  _emitTaraweeh() {
    this.onStateUpdate({
      type: 'taraweeh',
      position: this._taraweehPos,
      rakat: this._rakatCount,
    });
  }

  // Taraweeh prayer transition state machine: QIYAM → RUKU → up → SAJDA → up → SAJDA → up → resume
  // Triggers: takbeer ("الله أكبر") AND tasmee' ("سمع الله لمن حمده") — both advance the state.
  // Auto-advance: if stuck in RUKU/SAJDA for >15s, force transition (missed audio).
  // Sound/distortion may cause missed transitions — recitation (lock/candidate) always wins and
  // transitions to QIYAM. Transitions are best-effort; we never block verse display.
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
        // New rakat — imam will recite Fatiha first, then resume previous surah
        this._expectFatiha = true;
        // Restore pre-ruku so anchor searches for continuation (resume same surah)
        if (this._preRukuSurah > 1) {
          this.state = { ...this.state, lastLockedSurah: this._preRukuSurah, lastLockedAyah: this._preRukuAyah };
          console.log(`[Pipeline] Taraweeh takbeer: SAJDA (2nd) → up, expectFatiha=true, resume from ${this._preRukuSurah}:${this._preRukuAyah}`);
        } else {
          console.log(`[Pipeline] Taraweeh takbeer: SAJDA (2nd) → up (QIYAM), expectFatiha=true, ready for new surah`);
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
        // Preserve the anchor target so QIYAM-after-takbeer-cycle resumes
        // from the correct surah instead of cold-searching. Prefer the
        // explicitly saved pre-ruku position; fall back to state's last lock.
        this.state = { ...createState(),
          lastLockedSurah: this._preRukuSurah || this.state.lastLockedSurah || 0,
          lastLockedAyah:  this._preRukuAyah  || this.state.lastLockedAyah  || 0 };
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
        // Preserve the anchor target so QIYAM-after-takbeer-cycle resumes
        // from the correct surah instead of cold-searching. Prefer the
        // explicitly saved pre-ruku position; fall back to state's last lock.
        this.state = { ...createState(),
          lastLockedSurah: this._preRukuSurah || this.state.lastLockedSurah || 0,
          lastLockedAyah:  this._preRukuAyah  || this.state.lastLockedAyah  || 0 };
        this._resetSearchBuf();
      }
    }
    this._taraweehPosEnteredAt = Date.now();  // track when we entered this state (for stuck timeout)
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
        winsRequired: this.practiceMode ? 1 : 2,
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
    }

    // V4: Include word progress in state so UI shows "Word X / Y" immediately when LOCKED (and after reconnect)
    let stateTotalWords;
    let stateWordIndex;
    if (this.state.mode === 'LOCKED' && this._displaySurah && this._displayAyah) {
      const ayah = getAyah(this._displaySurah, this._displayAyah);
      if (ayah?.words?.length) {
        stateTotalWords = ayah.words.length;
        stateWordIndex = Math.max(0, Math.min(this._currentWordIndex ?? 0, stateTotalWords - 1));
      }
    }
    if (isCandidate) {
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
        timerMs: this.practiceMode ? undefined : (timerMs || undefined),
        syncing: this._syncingDisplay || undefined,
        isCandidate:     isCandidate || false,
        candidateScore:  isCandidate ? Math.round(topScore * 100) : undefined,
        candidateMargin: isCandidate ? topMargin : undefined,
        practiceMode:    !!this.practiceMode,
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
        // V4: Word X/Y so frontend can show progress as soon as LOCKED (e.g. after reconnect)
        totalWords: stateTotalWords,
        wordIndex: stateWordIndex,
        whisperSurah: this._whisperSurah || undefined,
        whisperAyah: this._whisperAyah || undefined,
      },
      whisperText: whisperText ?? null,
      rms: rms != null ? +rms.toFixed(4) : null,
      candidates: candidates.length > 0 ? candidates : undefined,
    });
  }
}
