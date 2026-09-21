/**
 * Prayer position / rak'ah tracker.
 *
 * Acoustic cues alone cannot name a posture — "Allahu akbar" is said moving
 * into ruku', into sujood, out of sujood, and standing for the next rak'ah.
 * Only the order is fixed, so the tracker is a deterministic state machine and
 * the audio just advances it. Quran alignment is the correction layer: Al-Fatiha
 * only ever happens in qiyam, so hearing it resynchronises the machine no matter
 * how many takbeers were lost to reverb.
 *
 * Three things gate every transition, in the order they are cheapest to check:
 *
 *   1. Hard vetoes — a global refractory window, a minimum dwell per position,
 *      and rejection of audio that overlaps a window whose cue was already
 *      consumed. A second takbeer 400 ms after the first is an echo, not a
 *      posture change; and because the search buffer grows and is re-sent to
 *      Whisper, one takbeer legitimately appears in several transcripts.
 *   2. A weighted vote over the acoustic confidence, whether a verse is actively
 *      being matched, and whether the elapsed time is plausible.
 *   3. The transition table itself, which also carries the fallbacks for missed
 *      cues (skipped tasmee', skipped jalsah) and the edge cases — sajdah
 *      at-tilawah, witr qunoot, sajdah as-sahw, and an imam who stands up by
 *      mistake and sits back down.
 */

import { detectPrayerCue, hasSajdah, normalizeCue } from './prayerKeywords.js';

export const POSITIONS = Object.freeze({
  QIYAM: 'QIYAM',
  RUKU: 'RUKU',
  ITIDAL: 'ITIDAL',
  SAJDA1: 'SAJDA1',
  JALSAH: 'JALSAH',
  SAJDA2: 'SAJDA2',
  TASHAHHUD: 'TASHAHHUD',
  SAJDAH_TILAWAH: 'SAJDAH_TILAWAH',
  QUNOOT: 'QUNOOT',
});

/** Display metadata. `short` is sized for the G2 top bar; `label` for the app. */
export const POSITION_META = Object.freeze({
  QIYAM:          { short: 'QIY',  label: 'Standing',   arabic: '\u0642\u064A\u0627\u0645' },
  RUKU:           { short: 'RUKU', label: 'Bowing',     arabic: '\u0631\u0643\u0648\u0639' },
  ITIDAL:         { short: 'ITDL', label: 'Rising',     arabic: '\u0627\u0639\u062A\u062F\u0627\u0644' },
  SAJDA1:         { short: 'SJD1', label: 'Prostration 1', arabic: '\u0633\u062C\u0648\u062F' },
  JALSAH:         { short: 'JLSA', label: 'Sitting',    arabic: '\u062C\u0644\u0633\u0629' },
  SAJDA2:         { short: 'SJD2', label: 'Prostration 2', arabic: '\u0633\u062C\u0648\u062F' },
  TASHAHHUD:      { short: 'TSHD', label: 'Tashahhud',  arabic: '\u062A\u0634\u0647\u062F' },
  SAJDAH_TILAWAH: { short: 'TILW', label: 'Sajdah Tilawah', arabic: '\u0633\u062C\u062F\u0629 \u062A\u0644\u0627\u0648\u0629' },
  QUNOOT:         { short: 'QNUT', label: 'Qunoot',     arabic: '\u0642\u0646\u0648\u062A' },
});

/** The order a rak'ah walks through, used for timeout auto-advance and the UI strip. */
export const RAKAH_CYCLE = Object.freeze([
  POSITIONS.QIYAM, POSITIONS.RUKU, POSITIONS.ITIDAL,
  POSITIONS.SAJDA1, POSITIONS.JALSAH, POSITIONS.SAJDA2,
]);

// ── Temporal heuristics ────────────────────────────────────────────────────
// Physiological limits, not preferences: a ruku' cannot be over in a second and
// a jalsah does not last a minute. Below `min` a cue is an echo; past `max` the
// transition audio was missed and the machine advances itself.

export const TIMING = Object.freeze({
  /** No two accepted transitions may be closer together than this. */
  REFRACTORY_MS: 1800,
  /** Sujood inside this window after tasleem are sahw, not a new rak'ah. */
  GRACE_PERIOD_POST_SALAM_MS: 50000,
  /** A qiyam shorter than this that collapses back to sitting was a mistake. */
  IMAM_RECOVERY_MS: 10000,
  /** A takbeer this long into ruku' means tasmee' was missed and i'tidal passed. */
  TASMEE_MISS_MS: 5000,
  /** A takbeer this long into sajda 1 means the jalsah came and went unheard. */
  JALSAH_ELAPSED_MS: 15000,
  /** How long a sajdah ayah keeps the tilawah branch armed. */
  SAJDAH_TILAWAH_ARM_MS: 40000,
});

const WINDOWS = Object.freeze({
  QIYAM:          { min: 2000, max: 0 },       // recitation is unbounded
  RUKU:           { min: 3000, max: 45000 },
  ITIDAL:         { min: 1500, max: 15000 },
  SAJDA1:         { min: 3000, max: 60000 },
  JALSAH:         { min: 1200, max: 12000 },
  SAJDA2:         { min: 3000, max: 60000 },
  TASHAHHUD:      { min: 5000, max: 0 },
  SAJDAH_TILAWAH: { min: 3000, max: 60000 },
  QUNOOT:         { min: 3000, max: 360000 },
});

/** Shafi'i/Hanbali witr holds i'tidal for the whole du'a, so its ceiling lifts. */
const SHAFII_ITIDAL_MAX_MS = 360000;

// ── Voting weights ─────────────────────────────────────────────────────────
// w2 outweighs w1 so that an actively matched verse beats a takbeer-shaped
// string: 29:45 is literally "وَلَذِكْرُ اللَّهِ أَكْبَرُ" and must stay recitation.

const W_AUDIO = 0.40;
const W_VERSE = 0.35;
const W_TEMPORAL = 0.25;
const ACCEPT_THRESHOLD = 0.55;

/**
 * A cue buried in six or more other words is recitation, whatever else agrees.
 * The imam's takbeer comes over the loudspeaker in its own breath; a chunk that
 * also carries most of an ayah is the ayah.
 */
const MIN_AUDIO_CONFIDENCE = 0.3;

const DEFAULT_CONFIG = Object.freeze({
  /** Taraweeh is prayed in sets of two with a tasleem between them. */
  rakatPerSet: 2,
  /** 8 or 20 are the common taraweeh counts; 0 means "don't show a target". */
  targetRakat: 20,
  /** 'off' | 'hanafi' (extra takbeer + qunoot in qiyam) | 'shafii' (qunoot in i'tidal) */
  witrMode: 'off',
});

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export class PrayerTracker {
  /**
   * @param {object}   [opts]
   * @param {Function} [opts.onChange] called with a snapshot whenever state moves
   * @param {Function} [opts.log]      diagnostic sink (defaults to console.log)
   * @param {object}   [opts.config]   see DEFAULT_CONFIG
   * @param {number}   [opts.now]      injectable clock for tests
   */
  constructor({ onChange = () => {}, onDecision = null, log = null, config = {}, now = Date.now() } = {}) {
    this.onChange = onChange;
    /**
     * Called for every cue considered, accepted or not, with the score
     * breakdown behind the verdict. Field reports almost always turn on "why
     * was that takbeer ignored", and a silent `return null` cannot answer it.
     */
    this.onDecision = onDecision || (() => {});
    this._log = log || ((m) => console.log(`[Prayer] ${m}`));
    this.config = { ...DEFAULT_CONFIG };
    this.setConfig(config, { silent: true });
    this._resetState(now);
  }

  _resetState(now) {
    this.position = POSITIONS.QIYAM;
    this.enteredAt = now;
    /** Rak'ahs finished (a rak'ah closes when the second sujood is left). */
    this.completedRakat = 0;
    this.sajdaCount = 0;
    this.lastAcceptedAt = 0;
    this.lastCueKind = null;
    this.lastCueText = '';
    this.lastCueAt = 0;
    /** End of the audio window whose cue was last consumed (pipeline clock). */
    this.consumedWindowEndMs = 0;
    this.lastReason = 'init';
    this.lastScore = 1;
    this.pendingSajdahTilawahUntil = 0;
    this.postSalamUntil = 0;
    this.inSahw = false;
    this.qunootFrom = null;
    /** Set when a takbeer lifted the imam out of tashahhud — armed for a sit-back-down. */
    this.recoveryArmedUntil = 0;
    this.setsCompleted = 0;
    this.manualOverrides = 0;
    this.resyncs = 0;
    this.missedCues = 0;
  }

  // ── Configuration ────────────────────────────────────────────────────────

  setConfig(config = {}, { silent = false } = {}) {
    if (config.rakatPerSet != null) {
      this.config.rakatPerSet = clampInt(config.rakatPerSet, 1, 8, this.config.rakatPerSet);
    }
    if (config.targetRakat != null) {
      this.config.targetRakat = clampInt(config.targetRakat, 0, 100, this.config.targetRakat);
    }
    if (config.witrMode != null) {
      const m = String(config.witrMode);
      if (m === 'off' || m === 'hanafi' || m === 'shafii') this.config.witrMode = m;
    }
    if (!silent) this._emit();
    return this.config;
  }

  // ── Derived view ─────────────────────────────────────────────────────────

  get rakatInSet() {
    return (this.completedRakat % this.config.rakatPerSet) + 1;
  }

  get setNumber() {
    return Math.floor(this.completedRakat / this.config.rakatPerSet) + 1;
  }

  /** 1-based number of the rak'ah currently being prayed. */
  get rakat() {
    return this.completedRakat + 1;
  }

  snapshot(now = Date.now()) {
    const meta = POSITION_META[this.position] || POSITION_META.QIYAM;
    return {
      position: this.position,
      positionShort: meta.short,
      positionLabel: meta.label,
      positionArabic: meta.arabic,
      rakat: this.rakat,
      rakatInSet: this.rakatInSet,
      rakatPerSet: this.config.rakatPerSet,
      completedRakat: this.completedRakat,
      targetRakat: this.config.targetRakat,
      setNumber: this.setNumber,
      sajdaCount: this.sajdaCount,
      sinceMs: Math.max(0, now - this.enteredAt),
      inSahw: this.inSahw,
      qunootFrom: this.qunootFrom,
      awaitingSajdahTilawah: now < this.pendingSajdahTilawahUntil,
      witrMode: this.config.witrMode,
      reason: this.lastReason,
      confidence: this.lastScore,
      lastCue: this.lastCueKind,
      /** True while the imam is not standing — the app hides the verse then. */
      inPrayerPosition: this.position !== POSITIONS.QIYAM,
      stats: {
        resyncs: this.resyncs,
        missedCues: this.missedCues,
        manualOverrides: this.manualOverrides,
      },
    };
  }

  _emit(now = Date.now()) {
    try { this.onChange(this.snapshot(now)); } catch (_) {}
  }

  // ── Transition plumbing ──────────────────────────────────────────────────

  _windowFor(position) {
    const w = WINDOWS[position] || WINDOWS.QIYAM;
    if (position === POSITIONS.ITIDAL && this.config.witrMode === 'shafii') {
      return { min: w.min, max: SHAFII_ITIDAL_MAX_MS };
    }
    return w;
  }

  _temporalScore(now) {
    const { min, max } = this._windowFor(this.position);
    const dwell = now - this.enteredAt;
    if (dwell < min) return 0;
    if (!max || dwell <= max) return 1;
    // Overrun: still plausible, the imam simply held the position.
    return 0.5;
  }

  _move(position, now, reason, { score = 1, countRakah = false, sajdaCount = null } = {}) {
    const from = this.position;
    if (countRakah) this.completedRakat += 1;
    this.position = position;
    this.enteredAt = now;
    this.lastAcceptedAt = now;
    this.lastReason = reason;
    this.lastScore = Number(score.toFixed(3));
    this.sajdaCount = sajdaCount != null ? sajdaCount
      : position === POSITIONS.SAJDA1 ? 1
      : position === POSITIONS.SAJDA2 ? 2
      : 0;
    this._log(`${from} → ${position} (${reason}, rakat ${this.rakat}/${this.config.targetRakat || '?'}, p=${this.lastScore})`);
    this._emit(now);
    return this.snapshot(now);
  }

  // ── Audio cue input ──────────────────────────────────────────────────────

  /**
   * Feed a transcript chunk. Returns the new snapshot when a transition was
   * accepted, or null when the chunk was ignored.
   *
   * @param {string} text        Whisper transcript (already cleaned)
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @param {number} [opts.verseActive] 0..1 — how strongly this chunk looks like
   *                                    ongoing recitation rather than a spoken cue
   * @param {number} [opts.windowStartMs] start of the audio window behind this
   *                                    transcript, on the pipeline's clock
   * @param {number} [opts.windowEndMs]  end of that window
   */
  feedText(text, opts = {}) {
    const cue = detectPrayerCue(text);
    if (!cue) return null;
    return this.feedCue(cue, opts);
  }

  /** @param {{kind: string, confidence: number, text?: string}} cue */
  feedCue(cue, { now = Date.now(), verseActive = 0,
                 windowStartMs = 0, windowEndMs = 0 } = {}) {
    if (!cue || !cue.kind) return null;
    const kind = cue.kind;
    const pAudio = Number.isFinite(cue.confidence) ? cue.confidence : 1;
    const from = this.position;
    const dwellMs = now - this.enteredAt;

    /** Record the verdict, then hand the caller the usual null-or-snapshot. */
    const verdict = (reason, extra = {}) => {
      const accepted = reason === 'accepted';
      try {
        this.onDecision({
          kind, accepted, reason, from,
          to: accepted ? this.position : from,
          dwellMs,
          text: cue.text || '',
          pAudio, verseActive,
          leading: cue.leading || 0,
          trailing: cue.trailing || 0,
          ...extra,
        });
      } catch (_) {}
      if (!accepted && reason !== 'refractory' && reason !== 'replayed-audio') {
        this._log(`cue ${kind} ignored (${reason})`);
      }
      return extra.result ?? null;
    };

    if (pAudio < MIN_AUDIO_CONFIDENCE) return verdict('buried-in-recitation');

    // Hard veto 1 — refractory. Loudspeaker echo and clipping produce a second
    // copy of the same syllables a few hundred ms later.
    if (this.lastAcceptedAt && now - this.lastAcceptedAt < TIMING.REFRACTORY_MS) {
      return verdict('refractory', { sinceLastMs: now - this.lastAcceptedAt });
    }

    // Hard veto 2 — audio we have already acted on. The search buffer grows and
    // is re-sent to Whisper, so one takbeer arrives in several transcripts. The
    // windows themselves disambiguate: anything starting before the end of the
    // window we last consumed is a replay, not a new posture change. Comparing
    // the text instead would be wrong, because real takbeers repeat verbatim
    // seconds apart (sajda → jalsah → sajda).
    if (windowEndMs > 0 && this.consumedWindowEndMs
        && windowStartMs < this.consumedWindowEndMs) {
      return verdict('replayed-audio', { windowStartMs, consumedUntil: this.consumedWindowEndMs });
    }

    this.lastCueKind = kind;
    this.lastCueText = normalizeCue(cue.text || '');
    this.lastCueAt = now;

    // Hard veto 3 — physiologically impossible dwell. A tasleem is exempt:
    // it is unambiguous and ends the set whenever it lands.
    const pTemporal = this._temporalScore(now);
    if (pTemporal === 0 && kind !== 'tasleem') {
      return verdict('too-soon', { pTemporal, minDwellMs: this._windowFor(from).min });
    }

    // Hard veto 4 — the ayah being recited contains this phrase and the chunk
    // carries more than the phrase alone. A cue spoken by itself still counts
    // however Quranic its words are; a cue with recitation wrapped around it,
    // in a verse known to quote it, is the verse.
    const pVerse = 1 - Math.max(0, Math.min(1, verseActive));
    if (verseActive >= 0.85 && ((cue.leading || 0) > 0 || (cue.trailing || 0) > 0)) {
      return verdict('quoted-by-the-ayah', { pTemporal, pVerse });
    }

    const score = W_AUDIO * pAudio + W_VERSE * pVerse + W_TEMPORAL * pTemporal;
    if (score < ACCEPT_THRESHOLD) {
      return verdict('outvoted', { pTemporal, pVerse, score: +score.toFixed(3), threshold: ACCEPT_THRESHOLD });
    }

    const result = this._applyCue(kind, now, score);
    if (!result) return verdict('no-transition-from-here', { pTemporal, pVerse, score: +score.toFixed(3) });
    if (windowEndMs) this.consumedWindowEndMs = windowEndMs;
    return verdict('accepted', { pTemporal, pVerse, score: +score.toFixed(3), result });
  }

  _applyCue(kind, now, score) {
    const dwell = now - this.enteredAt;

    // Salam is said sitting, after tashahhud. Treating it as valid from ruku'
    // or the first sujood lets a Quranic "سلام" (43:89 "وقل سلام") or a
    // hallucinated greeting wipe the rak'ah count — that is what happened on a
    // real Makkah night-26 recording. If the machine is lost in sujood, the
    // dwell timeout still walks it to jalsah / sajda 2, where a real tasleem
    // is accepted.
    if (kind === 'tasleem') {
      const seated = this.position === POSITIONS.TASHAHHUD
        || this.position === POSITIONS.SAJDA2
        || this.position === POSITIONS.JALSAH;
      if (!seated) return null;
      return this._completeSet(now, score);
    }

    // Sujood immediately after tasleem are corrective, never a new rak'ah.
    if (kind === 'takbeer' && now < this.postSalamUntil && !this.inSahw) {
      this.inSahw = true;
      this._log('takbeer inside the post-salam grace window — sajdah as-sahw');
      return this._move(POSITIONS.SAJDA1, now, 'sahw', { score, sajdaCount: 1 });
    }

    switch (this.position) {
      case POSITIONS.QIYAM:            return this._fromQiyam(kind, now, score, dwell);
      case POSITIONS.RUKU:             return this._fromRuku(kind, now, score, dwell);
      case POSITIONS.ITIDAL:           return this._fromItidal(kind, now, score);
      case POSITIONS.QUNOOT:           return this._fromQunoot(kind, now, score);
      case POSITIONS.SAJDA1:           return this._fromSajda1(kind, now, score, dwell);
      case POSITIONS.JALSAH:           return this._fromJalsah(kind, now, score);
      case POSITIONS.SAJDA2:           return this._fromSajda2(kind, now, score);
      case POSITIONS.TASHAHHUD:        return this._fromTashahhud(kind, now, score);
      case POSITIONS.SAJDAH_TILAWAH:   return this._fromSajdahTilawah(kind, now, score);
      default:                         return null;
    }
  }

  _fromQiyam(kind, now, score, dwell) {
    // The imam stood for a rak'ah that isn't there, the congregation said
    // "SubhanAllah", and he sat straight back down — saying "Allahu akbar" on
    // the way. A rak'ah always opens with Al-Fatiha, so a takbeer this soon
    // after rising from tashahhud is the correction, not a bow.
    if (this.recoveryArmedUntil > now && dwell < TIMING.IMAM_RECOVERY_MS
        && (kind === 'takbeer' || kind === 'tashahhud')) {
      this.recoveryArmedUntil = 0;
      this._log('qiyam abandoned inside the recovery window — back to tashahhud');
      return this._move(POSITIONS.TASHAHHUD, now, 'imam-recovery', { score });
    }
    if (kind === 'tashahhud') {
      return this._move(POSITIONS.TASHAHHUD, now, 'cue-tashahhud', { score });
    }
    if (kind === 'qunoot') {
      this.qunootFrom = POSITIONS.QIYAM;
      return this._move(POSITIONS.QUNOOT, now, 'cue-qunoot', { score });
    }
    // Rising out of ruku' while we still believe he is standing: the takbeer
    // into ruku' was lost. Credit the missed cue and land in i'tidal.
    if (kind === 'tasmee' || kind === 'tahmeed') {
      this.missedCues += 1;
      return this._move(POSITIONS.ITIDAL, now, 'recover-missed-ruku', { score });
    }
    if (kind !== 'takbeer') return null;

    if (now < this.pendingSajdahTilawahUntil) {
      this.pendingSajdahTilawahUntil = 0;
      return this._move(POSITIONS.SAJDAH_TILAWAH, now, 'sajdah-tilawah', { score, sajdaCount: 0 });
    }
    // Hanafi witr: an extra takbeer while standing opens du'a al-qunoot.
    if (this.config.witrMode === 'hanafi' && this._isWitrRakah()) {
      this.qunootFrom = POSITIONS.QIYAM;
      return this._move(POSITIONS.QUNOOT, now, 'witr-hanafi-takbeer', { score });
    }
    return this._move(POSITIONS.RUKU, now, 'cue-takbeer', { score });
  }

  _fromRuku(kind, now, score, dwell) {
    if (kind === 'tasmee' || kind === 'tahmeed') {
      return this._move(POSITIONS.ITIDAL, now, 'cue-tasmee', { score });
    }
    if (kind === 'takbeer') {
      // Tasmee' drowned in the congregation's response; i'tidal already passed.
      if (dwell >= TIMING.TASMEE_MISS_MS) this.missedCues += 1;
      return this._move(POSITIONS.SAJDA1, now, 'recover-missed-tasmee', { score, sajdaCount: 1 });
    }
    return null;
  }

  _fromItidal(kind, now, score) {
    if (kind === 'qunoot') {
      this.qunootFrom = POSITIONS.ITIDAL;
      return this._move(POSITIONS.QUNOOT, now, 'cue-qunoot', { score });
    }
    if (kind === 'takbeer') {
      return this._move(POSITIONS.SAJDA1, now, 'cue-takbeer', { score, sajdaCount: 1 });
    }
    return null;
  }

  _fromQunoot(kind, now, score) {
    if (kind !== 'takbeer') return null;
    // Hanafi qunoot is said standing, so the next move is into ruku'.
    // Shafi'i qunoot is said in i'tidal, so the next move is into sujood.
    if (this.qunootFrom === POSITIONS.ITIDAL) {
      this.qunootFrom = null;
      return this._move(POSITIONS.SAJDA1, now, 'qunoot-end', { score, sajdaCount: 1 });
    }
    this.qunootFrom = null;
    return this._move(POSITIONS.RUKU, now, 'qunoot-end', { score });
  }

  _fromSajda1(kind, now, score, dwell) {
    if (kind !== 'takbeer') return null;
    // The takbeer out of jalsah is the quietest of the set. If this one is late
    // enough that a whole jalsah fits behind it, that is what happened.
    if (dwell >= TIMING.JALSAH_ELAPSED_MS) {
      this.missedCues += 1;
      return this._move(POSITIONS.SAJDA2, now, 'recover-missed-jalsah', { score, sajdaCount: 2 });
    }
    return this._move(POSITIONS.JALSAH, now, 'cue-takbeer', { score, sajdaCount: 1 });
  }

  _fromJalsah(kind, now, score) {
    if (kind !== 'takbeer') return null;
    return this._move(POSITIONS.SAJDA2, now, 'cue-takbeer', { score, sajdaCount: 2 });
  }

  _fromSajda2(kind, now, score) {
    if (kind === 'tashahhud') return this._closeRakah(now, score, 'cue-tashahhud');
    if (kind !== 'takbeer') return null;
    return this._closeRakah(now, score, 'cue-takbeer');
  }

  _fromTashahhud(kind, now, score) {
    if (kind === 'takbeer') {
      // Standing for a further rak'ah (witr, or isha's third and fourth). The
      // rak'ah just prayed was counted on the way into tashahhud, so nothing is
      // credited here — the new one counts when its own sujood finish.
      this.recoveryArmedUntil = now + TIMING.IMAM_RECOVERY_MS;
      return this._move(POSITIONS.QIYAM, now, 'rise-from-tashahhud', { score });
    }
    return null;
  }

  _fromSajdahTilawah(kind, now, score) {
    if (kind !== 'takbeer') return null;
    // A prostration of recitation is not part of the rak'ah cycle — the imam
    // stands back up and carries on from where he stopped.
    return this._move(POSITIONS.QIYAM, now, 'sajdah-tilawah-end', { score });
  }

  /** Second sujood left: the rak'ah is done — stand again, or sit for tashahhud. */
  _closeRakah(now, score, reason) {
    if (this.inSahw) {
      this.inSahw = false;
      return this._move(POSITIONS.TASHAHHUD, now, 'sahw-end', { score });
    }
    const willComplete = this.completedRakat + 1;
    const sitsForTashahhud = willComplete % this.config.rakatPerSet === 0;
    if (sitsForTashahhud) {
      return this._move(POSITIONS.TASHAHHUD, now, reason, { score, countRakah: true });
    }
    return this._move(POSITIONS.QIYAM, now, reason, { score, countRakah: true });
  }

  _completeSet(now, score) {
    // Salam is only given after a rak'ah has finished, so if the machine still
    // believes he is mid-cycle it missed the end of one — credit it.
    const midCycle = RAKAH_CYCLE.includes(this.position) && this.position !== POSITIONS.QIYAM;
    if (midCycle) this.missedCues += 1;
    this.postSalamUntil = now + TIMING.GRACE_PERIOD_POST_SALAM_MS;
    this.inSahw = false;
    this.setsCompleted += 1;
    this.recoveryArmedUntil = 0;
    const result = this._move(POSITIONS.QIYAM, now, 'tasleem', { score, countRakah: midCycle });
    this._log(`tasleem — set ${this.setsCompleted} complete (${this.completedRakat} rak'ah total)`);
    return result;
  }

  _isWitrRakah() {
    return this.config.witrMode !== 'off'
      && this.config.rakatPerSet === 3
      && this.rakatInSet === 3;
  }

  // ── Quran alignment super-anchors ────────────────────────────────────────

  /**
   * Ground truth from the verse matcher. Al-Fatiha is recited standing in every
   * rak'ah, so hearing it means qiyam regardless of what the cue chain believed.
   *
   * @param {object} v
   * @param {number} v.surah
   * @param {number} v.ayah
   * @param {boolean} [v.locked]   true once the anchor state machine is locked
   * @param {number} [v.confidence] 0..1
   * @param {boolean} [v.fatihaEnd] the closing words of Al-Fatiha were heard
   */
  feedVerse({ surah, surahNum, ayah, locked = false, confidence = 0, fatihaEnd = false } = {},
            { now = Date.now() } = {}) {
    const s = Number(surah ?? surahNum) || 0;
    const a = Number(ayah) || 0;

    // Recitation after a tasleem means the next set has started, so the
    // correction-prostration window closes. Without this, the takbeer into the
    // first ruku' of the new set would be filed as a sajdah as-sahw.
    if (s && a && this.postSalamUntil) {
      this.postSalamUntil = 0;
      this.inSahw = false;
    }

    // An ayah of sajdah arms the tilawah branch: the imam may prostrate straight
    // from qiyam, and those two takbeers must not be read as a rak'ah.
    if (s && a && hasSajdah(s, a)) {
      this.pendingSajdahTilawahUntil = now + TIMING.SAJDAH_TILAWAH_ARM_MS;
      this._log(`ayah of sajdah ${s}:${a} — tilawah branch armed`);
    }

    const certain = fatihaEnd || (s === 1 && a >= 5);
    if (!certain && !(locked && confidence >= 0.6)) return null;
    if (this.position === POSITIONS.QIYAM) return null;
    // Tashahhud is already sitting after a counted rak'ah. A stray 1:2 lock
    // must not stand him up or the tasleem that follows is missed.
    if (this.position === POSITIONS.TASHAHHUD) return null;

    // Recitation while we believed he was bowing or prostrating means the rest
    // of the cue chain was lost. Al-Fatiha (or any lock) during the sujood
    // cycle means the imam has already stood for the next rak'ah — close the
    // one we were in. The same lock during ruku' / i'tidal is usually a false
    // bow (opening takbeer, "rabbana lakal hamd" matching 1:2), so we stand
    // back up without counting.
    const inSujoodCycle = this.position === POSITIONS.SAJDA1
      || this.position === POSITIONS.JALSAH
      || this.position === POSITIONS.SAJDA2;
    const shouldClose = inSujoodCycle;
    this.resyncs += 1;
    this.missedCues += 1;
    this._log(`verse anchor ${s}:${a}${fatihaEnd ? ' (end of Fatiha)' : ''} while in ${this.position} — resyncing to qiyam`);
    return this._move(POSITIONS.QIYAM, now, 'verse-anchor', {
      score: certain ? 1 : confidence,
      countRakah: shouldClose,
    });
  }

  /** The congregational "Ameen" lands right after Al-Fatiha, so it is a qiyam marker. */
  feedAmeen({ now = Date.now() } = {}) {
    if (this.position === POSITIONS.QIYAM) return null;
    if (this.position === POSITIONS.TASHAHHUD) return null;
    return this.feedVerse({ surah: 1, ayah: 7, fatihaEnd: true }, { now });
  }

  // ── Timeouts ─────────────────────────────────────────────────────────────

  /**
   * Advance out of a position that has outlived its physiological ceiling. Call
   * this on a timer, not only when audio arrives: the usual way to get stuck is
   * for the room to go quiet in the middle of sujood.
   */
  tick(now = Date.now()) {
    const { max } = this._windowFor(this.position);
    if (!max) return null;
    const dwell = now - this.enteredAt;
    if (dwell <= max) return null;

    this.missedCues += 1;
    const score = 0.4;
    switch (this.position) {
      case POSITIONS.RUKU:
        return this._move(POSITIONS.ITIDAL, now, 'timeout', { score });
      case POSITIONS.ITIDAL:
        return this._move(POSITIONS.SAJDA1, now, 'timeout', { score, sajdaCount: 1 });
      case POSITIONS.SAJDA1:
        return this._move(POSITIONS.JALSAH, now, 'timeout', { score, sajdaCount: 1 });
      case POSITIONS.JALSAH:
        return this._move(POSITIONS.SAJDA2, now, 'timeout', { score, sajdaCount: 2 });
      case POSITIONS.SAJDA2:
        return this._closeRakah(now, score, 'timeout');
      case POSITIONS.SAJDAH_TILAWAH:
      case POSITIONS.QUNOOT:
        return this._move(POSITIONS.QIYAM, now, 'timeout', { score });
      default:
        return null;
    }
  }

  // ── Manual override (UX fail-safe) ───────────────────────────────────────

  /** `+1` / `-1` from the app when the model has desynced. */
  adjustRakat(delta, { now = Date.now() } = {}) {
    const d = clampInt(delta, -20, 20, 0);
    if (!d) return this.snapshot(now);
    this.completedRakat = Math.max(0, Math.min(200, this.completedRakat + d));
    this.manualOverrides += 1;
    this._log(`manual rak'ah adjust ${d > 0 ? '+' : ''}${d} → ${this.rakat}`);
    this._emit(now);
    return this.snapshot(now);
  }

  /** "Fix state" — drop the machine into the posture the user can actually see. */
  setPosition(position, { now = Date.now() } = {}) {
    if (!POSITIONS[position]) return this.snapshot(now);
    this.manualOverrides += 1;
    this.inSahw = false;
    this.recoveryArmedUntil = 0;
    return this._move(position, now, 'manual', { score: 1 });
  }

  /** Step to the next posture in the cycle without waiting for audio. */
  nextPosition({ now = Date.now() } = {}) {
    const idx = RAKAH_CYCLE.indexOf(this.position);
    if (idx < 0) return this.setPosition(POSITIONS.QIYAM, { now });
    if (this.position === POSITIONS.SAJDA2) {
      this.manualOverrides += 1;
      return this._closeRakah(now, 1, 'manual');
    }
    this.manualOverrides += 1;
    return this._move(RAKAH_CYCLE[idx + 1], now, 'manual', { score: 1 });
  }

  reset({ now = Date.now() } = {}) {
    const config = this.config;
    this._resetState(now);
    this.config = config;
    this._log('tracker reset');
    this._emit(now);
    return this.snapshot(now);
  }

  // ── Persistence across reconnects ────────────────────────────────────────

  toJSON(now = Date.now()) {
    return {
      v: 1,
      position: this.position,
      completedRakat: this.completedRakat,
      sajdaCount: this.sajdaCount,
      setsCompleted: this.setsCompleted,
      inSahw: this.inSahw,
      qunootFrom: this.qunootFrom,
      config: { ...this.config },
      /** Stored as an age so a clock skew between client and server cannot matter. */
      sinceMs: Math.max(0, now - this.enteredAt),
      ts: now,
    };
  }

  restore(data, { now = Date.now(), maxAgeMs = 20 * 60 * 1000 } = {}) {
    if (!data || typeof data !== 'object' || data.v !== 1) return false;
    const ts = Number(data.ts);
    if (!Number.isFinite(ts) || now - ts > maxAgeMs || ts > now + 60000) return false;
    if (!POSITIONS[data.position]) return false;
    this.position = data.position;
    this.completedRakat = clampInt(data.completedRakat, 0, 200, 0);
    this.sajdaCount = clampInt(data.sajdaCount, 0, 2, 0);
    this.setsCompleted = clampInt(data.setsCompleted, 0, 100, 0);
    this.inSahw = !!data.inSahw;
    if (data.config) this.setConfig(data.config, { silent: true });
    // Qunoot can start before or after ruku'; preserve which branch to resume.
    this.qunootFrom = this.position === POSITIONS.QUNOOT
      ? (data.qunootFrom === POSITIONS.ITIDAL ? POSITIONS.ITIDAL
        : data.qunootFrom === POSITIONS.QIYAM ? POSITIONS.QIYAM
        : this.config.witrMode === 'shafii' ? POSITIONS.ITIDAL : POSITIONS.QIYAM)
      : null;
    // The gap the client spent disconnected counts toward the dwell.
    this.enteredAt = now - clampInt(data.sinceMs, 0, 3600000, 0) - (now - ts);

    // What is worth carrying across a reconnect is the rak'ah count. The
    // posture is only worth carrying if it is still physically plausible —
    // nobody has been in sujood for the ten minutes the app was closed, and
    // restoring that would leave the glasses insisting on it until the next
    // takbeer. Past the ceiling, keep the count and stand him back up.
    const { max } = this._windowFor(this.position);
    if (max && now - this.enteredAt > max) {
      this._log(`restored posture ${this.position} is ${Math.round((now - this.enteredAt) / 1000)}s stale — keeping rak'ah ${this.rakat}, resetting to qiyam`);
      this.position = POSITIONS.QIYAM;
      this.sajdaCount = 0;
      this.inSahw = false;
      this.qunootFrom = null;
      this.enteredAt = now;
    }
    this.lastReason = 'restored';
    this._log(`restored ${this.position} at rak'ah ${this.rakat}`);
    this._emit(now);
    return true;
  }
}

export default PrayerTracker;
