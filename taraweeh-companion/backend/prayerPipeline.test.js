/**
 * Integration cover for the pipeline ↔ tracker wiring.
 *
 * The unit tests in prayerTracker.test.js prove the state machine. These prove
 * that AudioPipeline V4 actually drives it: that transcripts reach it with the
 * right audio-window identity, that leaving qiyam parks the verse display and
 * remembers where the imam stopped, and that the WebSocket messages the two
 * UIs render carry the whole snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioPipeline } from './audioPipelineV4.js';
import { POSITIONS } from './prayerTracker.js';
import { loadQuran } from './keywordMatcher.js';
import { prepareMatcherText, isOpeningPreamble, openingPreambleKind } from './whisperClean.js';

const TAKBEER = 'الله أكبر';
const TASMEE = 'سمع الله لمن حمده';
const TASLEEM = 'السلام عليكم ورحمة الله';

test('opening cleanup preserves short Quran letters and ignores quoted basmala', () => {
  for (const opener of ['يس', 'طه', 'ص', 'ق', 'ن', 'الم', 'يسي', 'ياسين']) {
    for (const prefix of ['بسم الله الرحمن الرحيم', 'أعوذ بالله من الشيطان الرجيم',
      'أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم']) {
      const text = `${prefix} ${opener}`;
      assert.equal(prepareMatcherText(text), opener);
      assert.equal(isOpeningPreamble(text), false, text);
    }
  }
  assert.equal(isOpeningPreamble('بسم الله الرحمن الرحيم'), true);
  assert.equal(isOpeningPreamble('أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم'), true);
  assert.equal(openingPreambleKind('إنه من سليمان وإنه بسم الله الرحمن الرحيم'), null);
});

test('Ya-Sin after Bismillah locks in the same request as Ya-Sin alone', async (t) => {
  loadQuran();
  for (const prefix of ['', 'بسم الله الرحمن الرحيم ', 'أعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم ']) {
    for (const opener of ['يس', 'يسي', 'ياسين']) {
      await t.test(`${prefix}${opener}`, async (t) => {
        const { pipeline } = makePipeline();
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => {
          calls++;
          return new Response(JSON.stringify({ text: prefix + opener }), { status: 200 });
        });
        try {
          pipeline.active = true;
          pipeline._forceNextSearch = true;
          pipeline._searchBuf = Buffer.alloc(3000 * 32, 1);
          await pipeline._processSearchChunk();
          assert.equal(calls, 1);
          assert.equal(pipeline.state.mode, 'LOCKED');
          assert.equal(pipeline.state.surah, 36);
          assert.equal(pipeline.state.ayah, 1);
        } finally { pipeline.destroy(); }
      });
    }
  }
});

test('Bismillah releases a previous lock and keeps new audio without resetting rakah', async (t) => {
  loadQuran();
  const { pipeline, updates } = makePipeline();
  let releaseOpening;
  const openingResponse = new Promise(resolve => { releaseOpening = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    await openingResponse;
    return new Response(JSON.stringify({ text: 'بسم الله الرحمن الرحيم' }), { status: 200 });
  });
  try {
    pipeline.active = true;
    pipeline.adjustRakat(2);
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 55, ayah: 13,
      lastLockedSurah: 55, lastLockedAyah: 13, _wins: 2, _pendingMatch: { surah: 55, ayah: 13 } };
    pipeline._displaySurah = 55;
    pipeline._displayAyah = 13;
    pipeline._arRahmanRefrainSeen = true;
    pipeline._lastSearchTexts = ['فبأي آلاء ربكما تكذبان'];
    pipeline._displayAdvanceTimer = setTimeout(() => assert.fail('old verse timer fired'), 10000);
    const opening = Buffer.alloc(3000 * 32, 1);
    const nextAyah = Buffer.alloc(2000 * 32, 2);
    pipeline._lockedBuf = opening;
    pipeline._audioClockMs = 3000;
    pipeline._lockedInFlight = 1;
    const pending = pipeline._processLockedChunk(opening, 1, { startMs: 0, endMs: 3000 });
    pipeline._audioClockMs = 5000;
    pipeline._lockedBuf = Buffer.concat([opening, nextAyah]);
    pipeline._lockedVoicedMs = 2000;
    pipeline._lockedLastVoiceAt = Date.now();
    releaseOpening();
    await pending;
    assert.equal(pipeline.state.mode, 'SEARCHING');
    assert.equal(pipeline.state.lastLockedSurah, 0);
    assert.equal(pipeline.state._pendingMatch, null);
    assert.equal(pipeline._displaySurah, 0);
    assert.equal(pipeline._displayAdvanceTimer, null);
    assert.equal(pipeline._arRahmanRefrainSeen, false);
    assert.equal(pipeline.prayer.rakat, 3);
    assert.deepEqual(pipeline._searchBuf, nextAyah);
    assert.equal(pipeline._searchWinIdx, 0);
    assert.equal(pipeline._searchVoicedMs, 2000);
    assert.equal(pipeline.processing, false);
    assert.ok(updates.some(m => m.preamble === 'bismillah'));
  } finally { pipeline.destroy(); }
});

test('an opening and Ya-Sin in a locked check switch surahs without retranscribing', async (t) => {
  loadQuran();
  const { pipeline } = makePipeline();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ text: 'بسم الله الرحمن الرحيم يس' }), { status: 200 });
  });
  try {
    pipeline.active = true;
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 55, ayah: 13 };
    pipeline._displaySurah = 55;
    pipeline._displayAyah = 13;
    pipeline._lockedInFlight = 1;
    await pipeline._processLockedChunk(Buffer.alloc(3000 * 32, 1), 1);
    assert.equal(calls, 1);
    assert.equal(pipeline.state.mode, 'LOCKED');
    assert.equal(pipeline.state.surah, 36);
    assert.equal(pipeline._displaySurah, 36);
    const trace = pipeline.trace.report();
    assert.equal(trace.events.filter(e => e.type === 'asr').length, 1);
    assert.ok(trace.events.some(e => e.type === 'lock' && e.at === '36:1'));
  } finally { pipeline.destroy(); }
});

test('a late result from the previous lock cannot undo an opening reset', async (t) => {
  loadQuran();
  const { pipeline } = makePipeline();
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const call = ++calls;
    if (call === 1) await oldResponse;
    return new Response(JSON.stringify({ text: call === 1
      ? 'فبأي آلاء ربكما تكذبان' : 'بسم الله الرحمن الرحيم يس' }), { status: 200 });
  });
  try {
    pipeline.active = true;
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 55, ayah: 13 };
    pipeline._displaySurah = 55;
    pipeline._displayAyah = 13;
    pipeline._lockedInFlight = 2;
    const older = pipeline._processLockedChunk(Buffer.alloc(3000 * 32, 1), 1);
    await pipeline._processLockedChunk(Buffer.alloc(3000 * 32, 1), 2);
    assert.equal(pipeline.state.surah, 36);
    const currentState = pipeline.state;
    releaseOld();
    await older;
    assert.equal(pipeline.state, currentState);
    assert.equal(pipeline._displaySurah, 36);
    assert.equal(pipeline._lockedInFlight, 0);
    assert.equal(pipeline.processing, false);
  } finally { releaseOld(); pipeline.destroy(); }
});

test('opening preamble keeps a short search and retains the next ayah arriving during ASR', async (t) => {
  loadQuran();
  const { pipeline, updates } = makePipeline();
  let releaseOpening;
  const openingResponse = new Promise((resolve) => { releaseOpening = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) await openingResponse;
    return new Response(JSON.stringify({ text: calls === 1
      ? 'بسم الله الرحمن الرحيم'
      : 'الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    pipeline.active = true;
    pipeline._forceNextSearch = true;
    pipeline._searchWinIdx = 2;
    pipeline._searchBuf = Buffer.alloc(8000 * 32, 1);
    pipeline._audioClockMs = 8000;
    const pending = pipeline._processSearchChunk();
    // These bytes were never part of the submitted opening window.
    const nextAyah = Buffer.alloc(3000 * 32, 2);
    pipeline._searchBuf = Buffer.concat([pipeline._searchBuf, nextAyah]);
    pipeline._audioClockMs += 3000;
    pipeline._searchVoicedMs = 3000;
    pipeline._searchLastVoiceAt = Date.now();
    releaseOpening();
    await pending;
    assert.equal(pipeline._searchWinIdx, 0, 'must not wait for a 12-second window');
    assert.deepEqual(pipeline._searchBuf, nextAyah);
    assert.deepEqual(pipeline._lastSearchTexts, []);
    assert.equal(pipeline._searchVoicedMs, 3000);
    assert.equal(pipeline.state.mode, 'SEARCHING');
    assert.ok(updates.some((m) => m.preamble === 'bismillah'));
    // Model the provider throttle elapsing; retain the normal rate limit.
    pipeline._lastSearchCall = Date.now() - 3000;
    await pipeline._processSearchChunk();
    assert.equal(calls, 2);
    assert.equal(pipeline.state.mode, 'LOCKED');
    assert.equal(pipeline.state.surah, 1);
    assert.ok(pipeline.state.ayah >= 2, 'must lock on the recitation, not Bismillah');
  } finally {
    pipeline.destroy();
  }
});

test('a ready post-opening buffer is searched without waiting for another microphone frame', async (t) => {
  loadQuran();
  const { pipeline } = makePipeline();
  let releaseOpening;
  const openingResponse = new Promise(resolve => { releaseOpening = resolve; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const call = ++calls;
    if (call === 1) await openingResponse;
    return new Response(JSON.stringify({ text: call === 1 ? 'بسم الله الرحمن الرحيم' : 'يس' }), { status: 200 });
  });
  try {
    pipeline.active = true;
    pipeline._forceNextSearch = true;
    pipeline._searchBuf = Buffer.alloc(3000 * 32, 1);
    const pending = pipeline._processSearchChunk();
    pipeline._searchBuf = Buffer.concat([pipeline._searchBuf, Buffer.alloc(3000 * 32, 2)]);
    pipeline._searchVoicedMs = 3000;
    pipeline._searchLastVoiceAt = Date.now();
    // Model three seconds spent awaiting ASR while the following verse arrives.
    pipeline._lastSearchCall = Date.now() - 3000;
    releaseOpening();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 2);
    assert.equal(pipeline.state.mode, 'LOCKED');
    assert.equal(pipeline.state.surah, 36);
  } finally { releaseOpening(); pipeline.destroy(); }
});

function makePipeline(opts = {}) {
  const updates = [];
  const statuses = [];
  const pipeline = new AudioPipeline({
    onStateUpdate: (m) => updates.push(m),
    onStatus: (s) => statuses.push(s),
    onError: () => {},
    whisperOpts: { provider: 'groq', groqApiKey: 'test-key' },
    ...opts,
  });
  pipeline.setTaraweehMode(true);
  return { pipeline, updates, statuses };
}

/** Feed a cue as if it came from a transcription window of fresh audio. */
function speak(pipeline, text, { advanceMs = 6000, locked = false } = {}) {
  const start = pipeline._audioClockMs;
  pipeline._audioClockMs += advanceMs;
  // The tracker's clock is real time, so the dwell has to pass for real.
  pipeline.prayer.enteredAt -= advanceMs;
  if (pipeline.prayer.lastAcceptedAt) pipeline.prayer.lastAcceptedAt -= advanceMs;
  return pipeline._feedPrayerCue(text, {
    locked,
    audioWindow: { startMs: start, endMs: pipeline._audioClockMs },
  });
}

function prayRakah(pipeline) {
  speak(pipeline, TAKBEER);
  speak(pipeline, TASMEE);
  speak(pipeline, TAKBEER);
  speak(pipeline, TAKBEER);
  speak(pipeline, TAKBEER);
  speak(pipeline, TAKBEER);
}

test('pipeline wiring — taraweeh mode', async (t) => {
  await t.test('announces the prayer snapshot when taraweeh mode is switched on', () => {
    const { pipeline, statuses } = makePipeline();
    const s = statuses.find((x) => x.type === 'taraweeh_mode' && x.enabled);
    assert.ok(s, 'expected a taraweeh_mode status');
    assert.equal(s.position, POSITIONS.QIYAM);
    assert.equal(s.rakat, 1);
    assert.equal(s.prayer.targetRakat, 20);
    pipeline.destroy();
  });

  await t.test('accepts a prayer configuration from the client', () => {
    const { pipeline, statuses } = makePipeline({ prayerConfig: { targetRakat: 8, rakatPerSet: 2 } });
    const s = statuses.find((x) => x.type === 'taraweeh_mode' && x.enabled);
    assert.equal(s.prayer.targetRakat, 8);
    pipeline.destroy();
  });

  await t.test('drives the machine from transcripts and emits every move', () => {
    const { pipeline, updates } = makePipeline();
    updates.length = 0;

    assert.equal(speak(pipeline, TAKBEER), true);
    const taraweeh = updates.filter((m) => m.type === 'taraweeh');
    assert.equal(taraweeh.length, 1);
    assert.equal(taraweeh[0].position, POSITIONS.RUKU);
    assert.equal(taraweeh[0].rakat, 1);
    assert.equal(taraweeh[0].prayer.positionLabel, 'Bowing');
    assert.equal(pipeline._taraweehPos, POSITIONS.RUKU, 'the display mirror follows');
    pipeline.destroy();
  });

  await t.test('counts two rak\'ahs and sits for tashahhud', () => {
    const { pipeline, updates } = makePipeline();
    prayRakah(pipeline);
    assert.equal(pipeline._taraweehPos, POSITIONS.QIYAM);
    prayRakah(pipeline);
    assert.equal(pipeline._taraweehPos, POSITIONS.TASHAHHUD);
    assert.equal(pipeline.prayer.completedRakat, 2);

    speak(pipeline, TASLEEM, { advanceMs: 20000 });
    const last = updates.filter((m) => m.type === 'taraweeh').at(-1);
    assert.equal(last.position, POSITIONS.QIYAM);
    assert.equal(last.rakat, 3);
    assert.equal(last.prayer.setNumber, 2);
    pipeline.destroy();
  });

  await t.test('ignores a takbeer replayed by a re-transcribed window', () => {
    const { pipeline } = makePipeline();
    const start = pipeline._audioClockMs;
    pipeline._audioClockMs += 6000;
    pipeline.prayer.enteredAt -= 6000;
    assert.equal(pipeline._feedPrayerCue(TAKBEER, {
      audioWindow: { startMs: start, endMs: pipeline._audioClockMs },
    }), true);

    // The search buffer grew; the same takbeer is inside the longer window.
    pipeline._audioClockMs += 5000;
    pipeline.prayer.enteredAt -= 5000;
    pipeline.prayer.lastAcceptedAt -= 5000;
    assert.equal(pipeline._feedPrayerCue(TAKBEER, {
      audioWindow: { startMs: start, endMs: pipeline._audioClockMs },
    }), false);
    assert.equal(pipeline._taraweehPos, POSITIONS.RUKU);
    pipeline.destroy();
  });
});

test('pipeline wiring — verse display across a rak\'ah', async (t) => {
  await t.test('parks the display and remembers the position when qiyam ends', () => {
    const { pipeline } = makePipeline();
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 2, ayah: 40 };
    pipeline._displaySurah = 2;
    pipeline._displayAyah = 40;

    speak(pipeline, TAKBEER);
    assert.equal(pipeline._taraweehPos, POSITIONS.RUKU);
    assert.equal(pipeline._preRukuSurah, 2);
    assert.equal(pipeline._preRukuAyah, 40);
    assert.equal(pipeline._displaySurah, 0, 'nothing is being recited in ruku');
    assert.equal(pipeline.state.lastLockedSurah, 2, 'the anchor still points at the surah');
    pipeline.destroy();
  });

  await t.test('primes the Fatiha express lock when the next rak\'ah opens', () => {
    const { pipeline } = makePipeline();
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 2, ayah: 40 };
    pipeline._expectFatiha = false;
    prayRakah(pipeline);
    assert.equal(pipeline._taraweehPos, POSITIONS.QIYAM);
    assert.equal(pipeline._expectFatiha, true);
    assert.equal(pipeline.state.lastLockedSurah, 2, 'resume target survives the rak\'ah');
    pipeline.destroy();
  });

  await t.test('a sajdah of recitation resumes the surah instead of expecting Fatiha', () => {
    const { pipeline } = makePipeline();
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 32, ayah: 15 };
    pipeline.prayer.feedVerse({ surah: 32, ayah: 15, locked: true, confidence: 0.95 });
    pipeline._expectFatiha = false;

    speak(pipeline, TAKBEER);
    assert.equal(pipeline._taraweehPos, POSITIONS.SAJDAH_TILAWAH);
    speak(pipeline, TAKBEER);
    assert.equal(pipeline._taraweehPos, POSITIONS.QIYAM);
    assert.equal(pipeline._expectFatiha, false, 'he carries on from where he stopped');
    assert.equal(pipeline.prayer.completedRakat, 0);
    pipeline.destroy();
  });

  await t.test('biases the search to Al-Fatiha while the imam is not standing', () => {
    const { pipeline } = makePipeline();
    speak(pipeline, TAKBEER);
    assert.equal(pipeline._taraweehPos, POSITIONS.RUKU);
    assert.notEqual(pipeline._taraweehPos, POSITIONS.QIYAM);
    pipeline.destroy();
  });
});

test('pipeline wiring — verse evidence beats a takbeer-shaped verse', async (t) => {
  await t.test('29:45 stays recitation while it is the locked ayah', () => {
    const { pipeline } = makePipeline();
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 29, ayah: 45 };
    pipeline._displaySurah = 29;
    pipeline._displayAyah = 45;
    const moved = speak(pipeline, 'ولذكر الله أكبر والله يعلم ما تصنعون', { locked: true });
    assert.equal(moved, false);
    assert.equal(pipeline._taraweehPos, POSITIONS.QIYAM);
    pipeline.destroy();
  });

  await t.test('an isolated takbeer still bows even while locked', () => {
    const { pipeline } = makePipeline();
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 29, ayah: 45 };
    pipeline._displaySurah = 29;
    pipeline._displayAyah = 45;
    assert.equal(speak(pipeline, TAKBEER, { locked: true }), true);
    assert.equal(pipeline._taraweehPos, POSITIONS.RUKU);
    pipeline.destroy();
  });
});

test('pipeline wiring — end-of-utterance flush', async (t) => {
  const BYTES_PER_MS = 32;   // 16 kHz, 16-bit mono

  /**
   * Put the pipeline in the state the trace caught: a short burst of speech is
   * buffered, the speaker has stopped, and the search window's three-second
   * target is still far away.
   */
  function armed({ voicedMs = 700, bufferedMs = 1500, taraweeh = true, posture = 'RUKU' } = {}) {
    const { pipeline } = makePipeline();
    if (!taraweeh) pipeline.setPracticeMode(true);
    else pipeline.prayer.setPosition(posture);
    pipeline.active = true;
    pipeline._searchBuf = Buffer.alloc(Math.round(bufferedMs * BYTES_PER_MS));
    pipeline._searchVoicedMs = voicedMs;
    pipeline._searchLastVoiceAt = Date.now() - 60000;   // hangover long expired
    pipeline._searchHasSignal = true;
    let flushed = false;
    pipeline._processSearchChunk = () => { flushed = true; };
    // One frame of silence, which is what makes the hangover fire.
    pipeline.ingest(Buffer.alloc(200 * BYTES_PER_MS));
    const result = { flushed, buffered: pipeline._searchBuf.length / BYTES_PER_MS };
    pipeline.destroy();
    return result;
  }

  await t.test('transcribes a short burst instead of discarding it', () => {
    // Without this the takbeer is thrown away: the hangover resets the buffer
    // while it waits for three seconds of audio that never comes, because the
    // imam is bowing in silence.
    assert.equal(armed().flushed, true);
  });

  await t.test('still discards a burst too short to be speech', () => {
    const r = armed({ voicedMs: 150 });
    assert.equal(r.flushed, false);
    // Reset, then the frame that triggered it is appended to the empty buffer:
    // the 1500ms that was there is gone, as before.
    assert.equal(r.buffered, 200, 'a cough resets the buffer as before');
  });

  await t.test('leaves recitation to the ordinary window path', () => {
    // Anything this long has already tripped the 3s window target, so
    // flushing would only duplicate the call.
    assert.equal(armed({ voicedMs: 4000 }).flushed, false);
  });

  await t.test('does not change Practice mode, which has no cues to catch', () => {
    assert.equal(armed({ taraweeh: false }).flushed, false);
  });

  await t.test('catches the takbeer that ends qiyam, not only the later ones', () => {
    // The cue that leaves qiyam looks exactly like the ones that follow it,
    // and it is the one that starts the rak'ah count.
    assert.equal(armed({ posture: 'QIYAM' }).flushed, true);
  });
});

test('pipeline wiring — manual overrides and persistence', async (t) => {
  await t.test('exposes the manual controls the app calls over the socket', () => {
    const { pipeline, updates } = makePipeline();
    pipeline.adjustRakat(2);
    assert.equal(pipeline.prayer.rakat, 3);
    pipeline.adjustRakat(-1);
    assert.equal(pipeline.prayer.rakat, 2);

    pipeline.setPrayerPosition(POSITIONS.SAJDA2);
    assert.equal(pipeline._taraweehPos, POSITIONS.SAJDA2);

    pipeline.setPrayerConfig({ targetRakat: 8 });
    assert.equal(updates.filter((m) => m.type === 'taraweeh').at(-1).prayer.targetRakat, 8);

    pipeline.resetRakat();
    assert.equal(pipeline.prayer.rakat, 1);
    assert.equal(pipeline._taraweehPos, POSITIONS.QIYAM);
    pipeline.destroy();
  });

  await t.test('round-trips the prayer state the client carries across a reconnect', () => {
    const a = makePipeline();
    prayRakah(a.pipeline);
    speak(a.pipeline, TAKBEER);
    const saved = JSON.parse(JSON.stringify(a.pipeline.prayerState()));
    a.pipeline.destroy();

    const b = makePipeline();
    assert.equal(b.pipeline.restorePrayerState(saved), true);
    assert.equal(b.pipeline.prayer.completedRakat, 1);
    assert.equal(b.pipeline._taraweehPos, POSITIONS.RUKU);
    b.pipeline.destroy();
  });

  await t.test('leaving taraweeh mode clears the count and stops the timer', () => {
    const { pipeline } = makePipeline();
    prayRakah(pipeline);
    assert.equal(pipeline.prayer.completedRakat, 1);
    pipeline.setPracticeMode(true);
    assert.equal(pipeline.prayer.completedRakat, 0);
    assert.equal(pipeline._prayerTickTimer, null);
    pipeline.destroy();
  });
});
