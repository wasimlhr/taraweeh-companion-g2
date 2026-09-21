import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPrayerCue, normalizeCue, hasSajdah, SAJDAH_AYAT,
  isTakbeer, isTasmee, isTasleem, isTashahhud, isFatihaEnd, isPrayerTransition,
  isTahmeed,
} from './prayerKeywords.js';
import { PrayerTracker, POSITIONS, TIMING, RAKAH_CYCLE } from './prayerTracker.js';

// ── Test harness ────────────────────────────────────────────────────────────
// A controllable clock: the machine is almost entirely about elapsed time, so
// every test drives it explicitly rather than sleeping.

function makeTracker(config = {}) {
  const events = [];
  let clock = 1_000_000;
  const tracker = new PrayerTracker({
    config,
    now: clock,
    log: () => {},
    onChange: (s) => events.push(s),
  });
  return {
    tracker,
    events,
    now: () => clock,
    advance(ms) { clock += ms; return clock; },
    /** Wait out the current position's minimum dwell, then speak a cue. */
    cue(text, { wait = 6000, verseActive = 0, windowStartMs = 0, windowEndMs = 0 } = {}) {
      clock += wait;
      return tracker.feedText(text, { now: clock, verseActive, windowStartMs, windowEndMs });
    },
    tick() { return tracker.tick(clock); },
    verse(v) { return tracker.feedVerse(v, { now: clock }); },
  };
}

const TAKBEER = 'الله أكبر';
const TASMEE = 'سمع الله لمن حمده';
const TASLEEM = 'السلام عليكم ورحمة الله';
const TASHAHHUD = 'التحيات لله والصلوات والطيبات';
const FATIHA_END = 'ولا الضالين';

/** Walk one complete rak'ah using the textbook cue sequence. */
function prayRakah(h) {
  h.cue(TAKBEER);   // qiyam → ruku
  h.cue(TASMEE);    // ruku  → i'tidal
  h.cue(TAKBEER);   // i'tidal → sajda 1
  h.cue(TAKBEER);   // sajda 1 → jalsah
  h.cue(TAKBEER);   // jalsah → sajda 2
  h.cue(TAKBEER);   // sajda 2 → next qiyam or tashahhud
}

// ── Keyword layer ───────────────────────────────────────────────────────────

test('prayerKeywords', async (t) => {
  await t.test('matches the takbeer spellings Whisper actually produces', () => {
    for (const v of [
      'الله أكبر', 'اللَّهُ أَكْبَرُ', 'الله اكبر', 'الله اكبى', 'الله اكبي',
      'اللّٰه أكبر', 'اللە اكبر', 'الله أكبرا',
      'اللهم أكبر', 'اللهم اكبر',
    ]) {
      assert.equal(isTakbeer(v), true, `expected takbeer: ${v}`);
    }
    assert.equal(isTakbeer('الحمد لله رب العالمين'), false);
    assert.equal(isTakbeer(''), false);
  });

  await t.test('matches tasmee, tasleem, tashahhud and the Fatiha close', () => {
    assert.equal(isTasmee('سمع الله لمن حمده'), true);
    assert.equal(isTasmee('سميع الله لمن حمد'), true);
    assert.equal(isTasmee('الله لمن حميدا'), true, 'small-whisper drops سمع');
    assert.equal(isTahmeed('ربنا ولك الحمد'), true);
    assert.equal(isTahmeed('أولك الحمد'), true);
    assert.equal(isTahmeed('ولك الحمد'), true);
    assert.equal(isTasleem('السلام عليكم ورحمة الله'), true);
    assert.equal(isTashahhud('التحيات لله والصلوات'), true);
    assert.equal(isTashahhud('اللهم صل على محمد'), true);
    assert.equal(isFatihaEnd('غير المغضوب عليهم ولا الضالين'), true);
    assert.equal(isFatihaEnd('الحمد لله رب العالمين'), false);
  });

  await t.test('normalizes alef, ya and teh-marbuta variants', () => {
    assert.equal(normalizeCue('أَكْبَرُ'), 'اكبر');
    assert.equal(normalizeCue('رحمةُ'), 'رحمه');
    assert.equal(normalizeCue('  الله   أكبر  '), 'الله اكبر');
  });

  await t.test('scores an isolated cue high and an embedded one low', () => {
    const alone = detectPrayerCue(TAKBEER);
    assert.equal(alone.kind, 'takbeer');
    assert.equal(alone.confidence, 1);

    // 29:45 is Quran that contains the takbeer verbatim.
    const embedded = detectPrayerCue('ولذكر الله أكبر والله يعلم ما تصنعون');
    assert.equal(embedded.kind, 'takbeer');
    assert.ok(embedded.confidence <= 0.5, `expected low confidence, got ${embedded.confidence}`);
  });

  await t.test('prefers the more specific phrase over the takbeer inside it', () => {
    assert.equal(detectPrayerCue(TASMEE).kind, 'tasmee');
    assert.equal(detectPrayerCue(TASHAHHUD).kind, 'tashahhud');
  });

  await t.test('knows all 15 ayat of sajdah', () => {
    assert.equal(SAJDAH_AYAT.length, 15);
    assert.equal(hasSajdah(32, 15), true);
    assert.equal(hasSajdah(96, 19), true);
    assert.equal(hasSajdah(22, 18), true);
    assert.equal(hasSajdah(22, 77), true);
    assert.equal(hasSajdah(2, 255), false);
  });

  await t.test('keeps the legacy isPrayerTransition contract', () => {
    assert.equal(isPrayerTransition(TAKBEER), true);
    assert.equal(isPrayerTransition(TASMEE), true);
    assert.equal(isPrayerTransition(FATIHA_END), false);
  });
});

// ── The standard cycle ──────────────────────────────────────────────────────

test('prayerTracker — standard rak\'ah cycle', async (t) => {
  await t.test('walks qiyam → ruku → i\'tidal → sajda → jalsah → sajda', () => {
    const h = makeTracker();
    assert.equal(h.tracker.position, POSITIONS.QIYAM);

    assert.equal(h.cue(TAKBEER).position, POSITIONS.RUKU);
    assert.equal(h.cue(TASMEE).position, POSITIONS.ITIDAL);
    assert.equal(h.cue(TAKBEER).position, POSITIONS.SAJDA1);
    assert.equal(h.cue(TAKBEER).position, POSITIONS.JALSAH);
    assert.equal(h.cue(TAKBEER).position, POSITIONS.SAJDA2);
    assert.equal(h.cue(TAKBEER).position, POSITIONS.QIYAM);
  });

  await t.test('counts a rak\'ah only once the second sujood is left', () => {
    const h = makeTracker();
    assert.equal(h.tracker.rakat, 1);
    h.cue(TAKBEER); h.cue(TASMEE); h.cue(TAKBEER); h.cue(TAKBEER); h.cue(TAKBEER);
    assert.equal(h.tracker.position, POSITIONS.SAJDA2);
    assert.equal(h.tracker.rakat, 1, 'still inside rak\'ah 1');
    assert.equal(h.tracker.completedRakat, 0);
    h.cue(TAKBEER);
    assert.equal(h.tracker.completedRakat, 1);
    assert.equal(h.tracker.rakat, 2);
  });

  await t.test('sits for tashahhud at the end of a two-rak\'ah set', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h);
    assert.equal(h.tracker.position, POSITIONS.QIYAM);
    prayRakah(h);
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
    assert.equal(h.tracker.completedRakat, 2);

    const after = h.cue(TASLEEM, { wait: 20000 });
    assert.equal(after.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.setsCompleted, 1);
    assert.equal(h.tracker.completedRakat, 2);
    assert.equal(h.tracker.rakat, 3);
    assert.equal(h.tracker.setNumber, 2);
    assert.equal(h.tracker.rakatInSet, 1);
  });

  await t.test('tracks a full 20-rak\'ah taraweeh across ten sets', () => {
    const h = makeTracker({ rakatPerSet: 2, targetRakat: 20 });
    for (let set = 0; set < 10; set++) {
      prayRakah(h);
      prayRakah(h);
      assert.equal(h.tracker.position, POSITIONS.TASHAHHUD, `set ${set + 1} should end sitting`);
      h.cue(TASLEEM, { wait: 20000 });
      // Recitation resumes, which closes the correction-prostration window.
      h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.9 });
    }
    assert.equal(h.tracker.completedRakat, 20);
    assert.equal(h.tracker.setsCompleted, 10);
  });
});

// ── Debouncing ──────────────────────────────────────────────────────────────

test('prayerTracker — debouncing and duplicate suppression', async (t) => {
  await t.test('rejects a second cue inside the refractory window', () => {
    const h = makeTracker();
    assert.equal(h.cue(TAKBEER).position, POSITIONS.RUKU);
    // An echo off the back wall, 400 ms later.
    assert.equal(h.cue('اللهُ أكبرُ', { wait: 400 }), null);
    assert.equal(h.tracker.position, POSITIONS.RUKU);
  });

  await t.test('ignores a takbeer replayed by a re-transcribed audio window', () => {
    const h = makeTracker();
    // The search buffer grows and is re-sent to Whisper, so one takbeer at 4 s
    // comes back in the 0–5 s window, then again in 0–9 s and 0–13 s.
    assert.equal(h.cue(TAKBEER, { windowStartMs: 0, windowEndMs: 5000 }).position, POSITIONS.RUKU);
    assert.equal(h.cue(TAKBEER, { wait: 4000, windowStartMs: 0, windowEndMs: 9000 }), null);
    assert.equal(h.cue(TAKBEER, { wait: 4000, windowStartMs: 0, windowEndMs: 13000 }), null);
    assert.equal(h.tracker.position, POSITIONS.RUKU, 'must not walk the machine forward');
  });

  await t.test('accepts a takbeer from fresh audio recorded after the last one', () => {
    const h = makeTracker();
    assert.equal(h.cue(TAKBEER, { windowStartMs: 0, windowEndMs: 5000 }).position, POSITIONS.RUKU);
    const later = h.cue(TAKBEER, { wait: 8000, windowStartMs: 5000, windowEndMs: 13000 });
    assert.ok(later, 'a genuinely new takbeer must still land');
    assert.equal(later.position, POSITIONS.SAJDA1);
  });

  await t.test('back-to-back takbeers pass when the windows do not overlap', () => {
    // Sajda → jalsah → sajda repeats the identical phrase seconds apart, so
    // text-identity suppression would break the second half of every rak\'ah.
    const h = makeTracker();
    h.cue(TAKBEER, { windowStartMs: 0, windowEndMs: 6000 });
    h.cue(TASMEE, { windowStartMs: 6000, windowEndMs: 12000 });
    assert.equal(h.cue(TAKBEER, { windowStartMs: 12000, windowEndMs: 18000 }).position, POSITIONS.SAJDA1);
    assert.equal(h.cue(TAKBEER, { wait: 4000, windowStartMs: 18000, windowEndMs: 22000 }).position, POSITIONS.JALSAH);
    assert.equal(h.cue(TAKBEER, { wait: 3000, windowStartMs: 22000, windowEndMs: 25000 }).position, POSITIONS.SAJDA2);
  });

  await t.test('rejects a cue that arrives faster than the posture allows', () => {
    const h = makeTracker();
    h.cue(TAKBEER);                      // → ruku at t0
    // Past the 1.8 s refractory but inside ruku's 3 s floor, so the dwell gate
    // is what has to reject it — not the refractory, and not a failure to
    // recognise the phrase.
    assert.equal(h.cue(TAKBEER, { wait: 2000 }), null);
    assert.equal(h.tracker.position, POSITIONS.RUKU);
  });
});

// ── Voting ──────────────────────────────────────────────────────────────────

test('prayerTracker — dual probability voting', async (t) => {
  await t.test('an actively matched verse outvotes a takbeer-shaped string', () => {
    const h = makeTracker();
    const res = h.cue('ولذكر الله أكبر والله يعلم ما تصنعون', { verseActive: 1 });
    assert.equal(res, null, '29:45 must stay recitation');
    assert.equal(h.tracker.position, POSITIONS.QIYAM);
  });

  await t.test('the same string transitions when no verse is being matched', () => {
    const h = makeTracker();
    // Isolated cue, nothing locked: audio + verse + temporal all agree.
    assert.equal(h.cue(TAKBEER, { verseActive: 0 }).position, POSITIONS.RUKU);
  });

  await t.test('a clean cue still wins while a verse is only weakly matched', () => {
    const h = makeTracker();
    assert.equal(h.cue(TAKBEER, { verseActive: 0.5 }).position, POSITIONS.RUKU);
  });
});

// ── Fallbacks for missed audio ──────────────────────────────────────────────

test('prayerTracker — missed-cue fallbacks', async (t) => {
  await t.test('a takbeer during ruku means tasmee was missed and i\'tidal passed', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    const res = h.cue(TAKBEER, { wait: 9000 });
    assert.equal(res.position, POSITIONS.SAJDA1);
    assert.equal(res.reason, 'recover-missed-tasmee');
    assert.equal(h.tracker.missedCues, 1);
  });

  await t.test('a late takbeer during sajda 1 means the jalsah elapsed unheard', () => {
    const h = makeTracker();
    h.cue(TAKBEER); h.cue(TASMEE); h.cue(TAKBEER);
    assert.equal(h.tracker.position, POSITIONS.SAJDA1);
    const res = h.cue(TAKBEER, { wait: TIMING.JALSAH_ELAPSED_MS + 2000 });
    assert.equal(res.position, POSITIONS.SAJDA2);
    assert.equal(res.reason, 'recover-missed-jalsah');
  });

  await t.test('tasmee while we believe he is standing recovers the missed ruku', () => {
    const h = makeTracker();
    const res = h.cue(TASMEE, { wait: 30000 });
    assert.equal(res.position, POSITIONS.ITIDAL);
    assert.equal(res.reason, 'recover-missed-ruku');
  });

  await t.test('"rabbana wa lakal hamd" works as an i\'tidal cue too', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    assert.equal(h.cue('ربنا ولك الحمد').position, POSITIONS.ITIDAL);
  });
});

// ── Quran super-anchors ─────────────────────────────────────────────────────

test('prayerTracker — Quran alignment anchors', async (t) => {
  await t.test('the end of Al-Fatiha forces qiyam and closes the lost rak\'ah', () => {
    const h = makeTracker();
    h.cue(TAKBEER); h.cue(TASMEE); h.cue(TAKBEER);
    assert.equal(h.tracker.position, POSITIONS.SAJDA1);
    assert.equal(h.tracker.completedRakat, 0);

    h.advance(20000);
    const res = h.verse({ surah: 1, ayah: 7, fatihaEnd: true, locked: true, confidence: 1 });
    assert.equal(res.position, POSITIONS.QIYAM);
    assert.equal(res.reason, 'verse-anchor');
    assert.equal(h.tracker.completedRakat, 1, 'the rak\'ah we lost still happened');
    assert.equal(h.tracker.resyncs, 1);
  });

  await t.test('an anchor while already standing changes nothing', () => {
    const h = makeTracker();
    h.advance(8000);
    assert.equal(h.verse({ surah: 1, ayah: 7, fatihaEnd: true }), null);
    assert.equal(h.tracker.completedRakat, 0);
  });

  await t.test('a weak unlocked match is not enough to resync', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.advance(5000);
    assert.equal(h.verse({ surah: 2, ayah: 20, locked: false, confidence: 0.2 }), null);
    assert.equal(h.tracker.position, POSITIONS.RUKU);
  });

  await t.test('Ameen confirms qiyam because it follows Al-Fatiha', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.advance(12000);
    const res = h.tracker.feedAmeen({ now: h.now() });
    assert.equal(res.position, POSITIONS.QIYAM);
  });

  await t.test('does not resync out of tashahhud on a verse match', () => {
    const h = makeTracker();
    prayRakah(h); prayRakah(h);
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
    h.advance(10000);
    const before = h.tracker.completedRakat;
    h.verse({ surah: 1, ayah: 7, fatihaEnd: true, locked: true, confidence: 1 });
    assert.equal(h.tracker.completedRakat, before, 'sitting is not a lost rak\'ah');
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
  });

  await t.test('Fatiha locked during sujood closes the rak\'ah (night-26 mosque audio)', () => {
    const h = makeTracker();
    h.cue(TAKBEER); h.cue(TASMEE); h.cue(TAKBEER);
    assert.equal(h.tracker.position, POSITIONS.SAJDA1);
    h.advance(8000);
    const res = h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.62 });
    assert.equal(res.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 1, 'imam already stood for the next rak\'ah');
  });

  await t.test('Fatiha locked during ruku does not count a rak\'ah', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.advance(5000);
    const res = h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.62 });
    assert.equal(res.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 0, 'opening takbeer misread as ruku');
  });
});

// ── Edge cases from the architecture note ───────────────────────────────────

test('prayerTracker — sajdah at-tilawah', async (t) => {
  await t.test('an ayah of sajdah routes the next two takbeers around the rak\'ah count', () => {
    const h = makeTracker();
    h.advance(10000);
    h.verse({ surah: 32, ayah: 15, locked: true, confidence: 0.95 });
    assert.equal(h.tracker.snapshot(h.now()).awaitingSajdahTilawah, true);

    const down = h.cue(TAKBEER);
    assert.equal(down.position, POSITIONS.SAJDAH_TILAWAH);

    const up = h.cue(TAKBEER, { wait: 9000 });
    assert.equal(up.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 0, 'a prostration of recitation is not a rak\'ah');
  });

  await t.test('a non-sajdah ayah leaves the branch disarmed', () => {
    const h = makeTracker();
    h.advance(10000);
    h.verse({ surah: 32, ayah: 14, locked: true, confidence: 0.95 });
    assert.equal(h.cue(TAKBEER).position, POSITIONS.RUKU);
  });

  await t.test('the armed branch expires so a later takbeer is an ordinary ruku', () => {
    const h = makeTracker();
    h.verse({ surah: 96, ayah: 19, locked: true, confidence: 0.95 });
    h.advance(TIMING.SAJDAH_TILAWAH_ARM_MS + 5000);
    assert.equal(h.cue(TAKBEER, { wait: 100 }).position, POSITIONS.RUKU);
  });
});

test('prayerTracker — witr variations', async (t) => {
  await t.test('Hanafi: an extra takbeer in the third rak\'ah opens qunoot', () => {
    const h = makeTracker({ rakatPerSet: 3, witrMode: 'hanafi' });
    prayRakah(h);
    prayRakah(h);
    assert.equal(h.tracker.completedRakat, 2);
    assert.equal(h.tracker.rakatInSet, 3);

    const q = h.cue(TAKBEER, { wait: 20000 });
    assert.equal(q.position, POSITIONS.QUNOOT);
    // Qunoot is said standing, so he bows from there.
    assert.equal(h.cue(TAKBEER, { wait: 30000 }).position, POSITIONS.RUKU);
  });

  await t.test('Shafi\'i: i\'tidal may be held for the whole du\'a without timing out', () => {
    const h = makeTracker({ rakatPerSet: 3, witrMode: 'shafii' });
    h.cue(TAKBEER);
    h.cue(TASMEE);
    assert.equal(h.tracker.position, POSITIONS.ITIDAL);
    h.advance(120000);
    assert.equal(h.tick(), null, 'a long qunoot i\'tidal must not auto-advance');
    assert.equal(h.tracker.position, POSITIONS.ITIDAL);
  });

  await t.test('off-mode i\'tidal still times out at 15s', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.cue(TASMEE);
    h.advance(20000);
    assert.equal(h.tick().position, POSITIONS.SAJDA1);
  });
});

test('prayerTracker — sajdah as-sahw', async (t) => {
  await t.test('sujood just after tasleem are corrective, not a new rak\'ah', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h); prayRakah(h);
    h.cue(TASLEEM, { wait: 20000 });
    assert.equal(h.tracker.completedRakat, 2);

    const sahw = h.cue(TAKBEER, { wait: 4000 });
    assert.equal(sahw.position, POSITIONS.SAJDA1);
    assert.equal(sahw.reason, 'sahw');

    h.cue(TAKBEER, { wait: 6000 });   // → jalsah
    h.cue(TAKBEER, { wait: 4000 });   // → sajda 2
    const done = h.cue(TAKBEER, { wait: 6000 });
    assert.equal(done.position, POSITIONS.TASHAHHUD);
    assert.equal(h.tracker.completedRakat, 2, 'correction prostrations add no rak\'ah');
  });

  await t.test('recitation after tasleem closes the grace window', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h); prayRakah(h);
    h.cue(TASLEEM, { wait: 20000 });
    h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.9 });

    const next = h.cue(TAKBEER, { wait: 25000 });
    assert.equal(next.position, POSITIONS.RUKU, 'the next set must start normally');
    assert.equal(next.reason, 'cue-takbeer');
  });

  await t.test('a Quranic سلام does not end the set from the first sujood', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    h.cue(TAKBEER); h.cue(TASMEE); h.cue(TAKBEER);
    assert.equal(h.tracker.position, POSITIONS.SAJDA1);
    h.advance(8000);
    const res = h.cue('السلام عليكم ورحمة الله', { wait: 100 });
    assert.equal(res, null);
    assert.equal(h.tracker.position, POSITIONS.SAJDA1);
    assert.equal(h.tracker.setsCompleted, 0);
    assert.equal(h.tracker.completedRakat, 0);
  });
});

test('prayerTracker — imam recovery', async (t) => {
  await t.test('a takbeer moments after rising from tashahhud sits him back down', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h); prayRakah(h);
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);

    const up = h.cue(TAKBEER, { wait: 15000 });
    assert.equal(up.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 2, 'rising does not pre-credit a rak\'ah');

    const back = h.cue(TAKBEER, { wait: 5000 });
    assert.equal(back.position, POSITIONS.TASHAHHUD);
    assert.equal(back.reason, 'imam-recovery');
    assert.equal(h.tracker.completedRakat, 2);
  });

  await t.test('a genuine third rak\'ah is untouched once past the recovery window', () => {
    const h = makeTracker({ rakatPerSet: 4 });
    prayRakah(h); prayRakah(h);
    h.cue(TASHAHHUD, { wait: 8000 });
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
    h.cue(TAKBEER, { wait: 20000 });
    assert.equal(h.tracker.position, POSITIONS.QIYAM);

    const ruku = h.cue(TAKBEER, { wait: 25000 });
    assert.equal(ruku.position, POSITIONS.RUKU);
    prayRakah(h);
    assert.equal(h.tracker.completedRakat, 3);
  });
});

// ── Timeouts ────────────────────────────────────────────────────────────────

test('prayerTracker — timeout auto-advance', async (t) => {
  await t.test('does nothing while the position is within its ceiling', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.advance(10000);
    assert.equal(h.tick(), null);
  });

  await t.test('walks the cycle forward when the room goes silent', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.advance(50000);
    assert.equal(h.tick().position, POSITIONS.ITIDAL);
    h.advance(20000);
    assert.equal(h.tick().position, POSITIONS.SAJDA1);
    h.advance(70000);
    assert.equal(h.tick().position, POSITIONS.JALSAH);
    h.advance(20000);
    assert.equal(h.tick().position, POSITIONS.SAJDA2);
    h.advance(70000);
    assert.equal(h.tick().position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 1);
  });

  await t.test('never times out of qiyam — recitation has no ceiling', () => {
    const h = makeTracker();
    h.advance(30 * 60 * 1000);
    assert.equal(h.tick(), null);
    assert.equal(h.tracker.position, POSITIONS.QIYAM);
  });

  await t.test('never times out of tashahhud', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h); prayRakah(h);
    h.advance(10 * 60 * 1000);
    assert.equal(h.tick(), null);
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
  });
});

// ── Manual override ─────────────────────────────────────────────────────────

test('prayerTracker — manual override', async (t) => {
  await t.test('+1 and -1 move the rak\'ah count and clamp at zero', () => {
    const h = makeTracker();
    assert.equal(h.tracker.adjustRakat(1).rakat, 2);
    assert.equal(h.tracker.adjustRakat(3).rakat, 5);
    assert.equal(h.tracker.adjustRakat(-2).rakat, 3);
    assert.equal(h.tracker.adjustRakat(-99).rakat, 1);
    assert.equal(h.tracker.snapshot().stats.manualOverrides, 4);
  });

  await t.test('"fix state" drops the machine into the posture the user can see', () => {
    const h = makeTracker();
    const s = h.tracker.setPosition(POSITIONS.SAJDA2, { now: h.now() });
    assert.equal(s.position, POSITIONS.SAJDA2);
    assert.equal(s.sajdaCount, 2);
    assert.equal(s.reason, 'manual');
    assert.equal(h.tracker.setPosition('NOT_A_POSITION', { now: h.now() }).position, POSITIONS.SAJDA2);
  });

  await t.test('stepping past the second sujood by hand closes the rak\'ah', () => {
    const h = makeTracker();
    h.tracker.setPosition(POSITIONS.SAJDA2, { now: h.now() });
    h.advance(5000);
    const s = h.tracker.nextPosition({ now: h.now() });
    assert.equal(s.position, POSITIONS.QIYAM);
    assert.equal(h.tracker.completedRakat, 1);
  });

  await t.test('reset clears the count and the posture but keeps the configuration', () => {
    const h = makeTracker({ targetRakat: 8, rakatPerSet: 2 });
    prayRakah(h);
    h.cue(TAKBEER, { wait: 20000 });
    const s = h.tracker.reset({ now: h.now() });
    assert.equal(s.position, POSITIONS.QIYAM);
    assert.equal(s.rakat, 1);
    assert.equal(s.completedRakat, 0);
    assert.equal(s.targetRakat, 8);
  });

  await t.test('rejects out-of-range configuration', () => {
    const h = makeTracker();
    const c = h.tracker.setConfig({ rakatPerSet: 99, targetRakat: -5, witrMode: 'nonsense' });
    assert.equal(c.rakatPerSet, 8);
    assert.equal(c.targetRakat, 0);
    assert.equal(c.witrMode, 'off');
  });
});

// ── Snapshots and persistence ───────────────────────────────────────────────

test('prayerTracker — snapshot and persistence', async (t) => {
  await t.test('reconnecting during qunoot preserves the next posture', () => {
    for (const from of [POSITIONS.QIYAM, POSITIONS.ITIDAL]) {
      const now = 100000;
      const tracker = new PrayerTracker({ log: () => {}, now });
      tracker.setPosition(from, { now });
      tracker.feedCue({ kind: 'qunoot', confidence: 1 }, { now: now + 5000 });
      for (const saved of [tracker.toJSON(now + 5000), {
        ...tracker.snapshot(now + 5000), v: 1, ts: now + 5000,
      }]) {
        const fresh = new PrayerTracker({ log: () => {}, now: now + 10000 });
        assert.equal(fresh.restore(saved, { now: now + 10000 }), true);
        const next = fresh.feedCue({ kind: 'takbeer', confidence: 1 }, { now: now + 11000 });
        assert.equal(next.position, from === POSITIONS.ITIDAL ? POSITIONS.SAJDA1 : POSITIONS.RUKU);
        assert.equal(next.completedRakat, 0);
      }
    }
  });

  await t.test('the snapshot carries everything the two UIs render', () => {
    const h = makeTracker({ targetRakat: 20, rakatPerSet: 2 });
    prayRakah(h);
    h.cue(TAKBEER, { wait: 20000 });
    const s = h.tracker.snapshot(h.now());
    assert.equal(s.position, POSITIONS.RUKU);
    assert.equal(s.positionShort, 'RUKU');
    assert.equal(s.positionLabel, 'Bowing');
    assert.equal(s.rakat, 2);
    assert.equal(s.rakatInSet, 2);
    assert.equal(s.targetRakat, 20);
    assert.equal(s.setNumber, 1);
    assert.equal(s.inPrayerPosition, true);
    assert.ok(s.positionArabic.length > 0);
  });

  await t.test('every accepted transition notifies the listener exactly once', () => {
    const h = makeTracker();
    h.events.length = 0;
    prayRakah(h);
    assert.equal(h.events.length, 6);
    assert.equal(h.events.at(-1).position, POSITIONS.QIYAM);
  });

  await t.test('round-trips through JSON so a reconnect keeps the count', () => {
    const h = makeTracker({ targetRakat: 8 });
    prayRakah(h);
    h.cue(TAKBEER, { wait: 20000 });
    h.cue(TASMEE);
    const saved = JSON.parse(JSON.stringify(h.tracker.toJSON(h.now())));

    const fresh = new PrayerTracker({ log: () => {}, now: h.now() });
    assert.equal(fresh.restore(saved, { now: h.now() }), true);
    assert.equal(fresh.position, POSITIONS.ITIDAL);
    assert.equal(fresh.completedRakat, 1);
    assert.equal(fresh.config.targetRakat, 8);
  });

  await t.test('refuses stale or malformed saved state', () => {
    const h = makeTracker();
    const saved = h.tracker.toJSON(h.now());
    const fresh = new PrayerTracker({ log: () => {}, now: h.now() });
    assert.equal(fresh.restore(saved, { now: h.now() + 60 * 60 * 1000 }), false);
    assert.equal(fresh.restore({ v: 2, position: 'RUKU', ts: h.now() }, { now: h.now() }), false);
    assert.equal(fresh.restore({ v: 1, position: 'NOPE', ts: h.now() }, { now: h.now() }), false);
    assert.equal(fresh.restore(null), false);
  });

  await t.test('a brief disconnect keeps the posture as well as the count', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    const saved = h.tracker.toJSON(h.now());
    const later = h.now() + 4000;
    const fresh = new PrayerTracker({ log: () => {}, now: later });
    fresh.restore(saved, { now: later });
    assert.equal(fresh.position, POSITIONS.RUKU, 'he is still bowing');
  });

  await t.test('a long gap keeps the rak\'ah count but drops the stale posture', () => {
    const h = makeTracker();
    prayRakah(h);
    h.cue(TAKBEER);            // into ruku' of rak'ah 2
    assert.equal(h.tracker.position, POSITIONS.RUKU);
    const saved = h.tracker.toJSON(h.now());

    // The app was closed for ten minutes. Nobody bowed for ten minutes.
    const later = h.now() + 10 * 60 * 1000;
    const fresh = new PrayerTracker({ log: () => {}, now: later });
    assert.equal(fresh.restore(saved, { now: later }), true);
    assert.equal(fresh.position, POSITIONS.QIYAM);
    assert.equal(fresh.completedRakat, 1, 'the count is what was worth keeping');
    assert.equal(fresh.rakat, 2);
  });

  await t.test('tashahhud has no ceiling, so it survives a long gap', () => {
    const h = makeTracker({ rakatPerSet: 2 });
    prayRakah(h); prayRakah(h);
    assert.equal(h.tracker.position, POSITIONS.TASHAHHUD);
    const saved = h.tracker.toJSON(h.now());
    const later = h.now() + 10 * 60 * 1000;
    const fresh = new PrayerTracker({ log: () => {}, now: later });
    fresh.restore(saved, { now: later });
    assert.equal(fresh.position, POSITIONS.TASHAHHUD);
    assert.equal(fresh.completedRakat, 2);
  });
});

test('prayerTracker — cycle metadata', () => {
  assert.deepEqual(RAKAH_CYCLE, [
    POSITIONS.QIYAM, POSITIONS.RUKU, POSITIONS.ITIDAL,
    POSITIONS.SAJDA1, POSITIONS.JALSAH, POSITIONS.SAJDA2,
  ]);
});

// Strings taken from faster-whisper-small on Makkah night-26 1446 last-4-rakah.
test('prayerTracker — night-26 mosque ASR sequence', () => {
  const h = makeTracker({ rakatPerSet: 2 });
  // Opening takbeer was standing up, then Fatiha — not a bow.
  h.cue('الله أكبر  الله  الله', { wait: 6000 });
  assert.equal(h.tracker.position, POSITIONS.RUKU);
  h.advance(7000);
  h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.62 });
  assert.equal(h.tracker.position, POSITIONS.QIYAM);
  assert.equal(h.tracker.completedRakat, 0);

  // Real ruku' after ~3 min of Az-Zukhruf. Whisper dropped "سمع".
  assert.equal(h.cue('الله أكبر', { wait: 180000 }).position, POSITIONS.RUKU);
  assert.equal(h.cue('الله لمن حميدا', { wait: 4000 }).position, POSITIONS.ITIDAL);
  assert.equal(h.cue('الله أكبر', { wait: 18000 }).position, POSITIONS.SAJDA1);
  // "اللهم أكبر" ~17s later: jalsah elapsed, land in second sujood.
  assert.equal(h.cue('اللهم أكبر', { wait: 17000 }).position, POSITIONS.SAJDA2);
  h.advance(4000);
  h.verse({ surah: 1, ayah: 2, locked: true, confidence: 0.62 });
  assert.equal(h.tracker.position, POSITIONS.QIYAM);
  assert.equal(h.tracker.completedRakat, 1);

  // 43:89 "وقل سلام" transcribed as a full tasleem during the next sujood
  // must not close the set.
  h.cue(TAKBEER, { wait: 20000 });
  h.cue(TASMEE, { wait: 8000 });
  h.cue(TAKBEER, { wait: 8000 });
  assert.equal(h.tracker.position, POSITIONS.SAJDA1);
  assert.equal(h.cue('السلام عليكم ورحمة الله', { wait: 8000 }), null);
  assert.equal(h.tracker.setsCompleted, 0);
  assert.equal(h.tracker.completedRakat, 1);
});

