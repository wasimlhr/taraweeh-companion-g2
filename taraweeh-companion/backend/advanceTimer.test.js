import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPipeline } from './audioPipelineV4.js';
import { loadQuran } from './keywordMatcher.js';

function lockedPipeline() {
  loadQuran();
  const pipeline = new AudioPipeline({ onStateUpdate() {}, onStatus() {}, onError() {} });
  pipeline.active = true;
  pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 112, ayah: 1, confidence: 95 };
  pipeline._displaySurah = pipeline._whisperSurah = 112;
  pipeline._displayAyah = pipeline._whisperAyah = 1;
  return pipeline;
}

test('Heard position follows the latest real verse while progression remains forward-only', () => {
  loadQuran();
  let latest;
  const pipeline = new AudioPipeline({ onStateUpdate(message) { latest = message; }, onStatus() {}, onError() {} });
  try {
    pipeline.active = true;
    pipeline.state = { ...pipeline.state, mode: 'LOCKED', surah: 36, ayah: 5, confidence: 95 };
    pipeline._displaySurah = pipeline._whisperSurah = pipeline._heardSurah = 36;
    pipeline._displayAyah = pipeline._whisperAyah = pipeline._heardAyah = 5;
    pipeline._onWhisperConfirm(36, 3, 95, 'تنزيل العزيز الرحيم', 0.1, true);
    pipeline._emitState('تنزيل العزيز الرحيم', 0.1);
    assert.equal(pipeline._whisperAyah, 5, 'pacing ratchet must not move backward on one observation');
    assert.equal(latest.state.heardSurah, 36);
    assert.equal(latest.state.heardAyah, 3, 'Heard UI follows the most recent confirmed recitation');
  } finally { pipeline.destroy(); }
});

test('Taraweeh expired advance survives a breath and resumes when voice returns without ASR', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline.setTaraweehMode(true);
    pipeline._lastDetectedVoiceAt = Date.now();
    pipeline._scheduleReadAdvance(95, 0, 1, 3000);
    t.mock.timers.tick(3000);
    assert.equal(pipeline._displayAyah, 1, 'hold through the silence');
    assert.ok(pipeline._displayAdvanceTimer, 'a retry must survive the expired countdown');
    pipeline._lastDetectedVoiceAt = Date.now();
    t.mock.timers.tick(250);
    assert.equal(pipeline._displayAyah, 2, 'resume the due advance without another transcript');
    assert.ok(pipeline._displayAdvanceTimer, 'next verse has its own timer');
  } finally { pipeline.destroy(); }
});

for (const action of ['stop', 'practice', 'follow']) {
  test(`silence retry is cancelled by ${action}`, t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
    const pipeline = lockedPipeline();
    try {
      pipeline.setTaraweehMode(true);
      pipeline._lastDetectedVoiceAt = Date.now();
      pipeline._scheduleReadAdvance(95, 0, 1, 3000);
      t.mock.timers.tick(3000);
      assert.ok(pipeline._displayAdvanceTimer);
      if (action === 'stop') pipeline.stop();
      else if (action === 'practice') pipeline.setPracticeMode(true);
      else pipeline.setFollowMode(true);
      const heldAyah = pipeline._displayAyah;
      pipeline._lastDetectedVoiceAt = Date.now();
      t.mock.timers.tick(1000);
      assert.equal(pipeline._displayAyah, heldAyah);
      assert.equal(pipeline._displayAdvanceTimer, null);
    } finally { pipeline.destroy(); }
  });
}

test('a new manual pace correction does not resurrect old samples after speech learns a faster tempo', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline._displaySurah = 36;
    pipeline._displayAyah = 8;
    pipeline._measuredMsPerWord = 818;
    pipeline._whisperClockSamples = 5;
    pipeline._msPerWordSamples = [1688, 1700, 1542, 1396];
    pipeline._ayahStartTime = Date.now() - 6960;
    pipeline._learnPaceFromManual();
    assert.equal(pipeline._measuredMsPerWord, 870);
    assert.deepEqual(pipeline._msPerWordSamples, [870]);
  } finally { pipeline.destroy(); }
});

test('Ayat al-Kursi uses canonical words and character length instead of the old 25s cap', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 2;
    pipeline._displayAyah = pipeline._whisperAyah = pipeline.state.ayah = 255;
    pipeline._measuredMsPerWord = 1400;
    pipeline._msPerWordSamples = [];
    pipeline._whisperClockSamples = 0;
    pipeline._scheduleReadAdvance(95, 0, 0.25);
    assert.ok(pipeline._nextAdvanceMs >= 40000,
      `long-ayah first-lock timer should retain inferred remaining length, got ${pipeline._nextAdvanceMs}ms`);
  } finally { pipeline.destroy(); }
});

for (const provider of ['soniox', 'groq', 'openai', 'elevenlabs']) {
  test(`${provider} token timestamps never become Quran word pace`, () => {
    const pipeline = lockedPipeline();
    try {
      pipeline.resolvedProvider = provider;
      pipeline._measuredMsPerWord = 1400;
      pipeline._wordTimestamps = [
        { start: 0.00 }, { start: 0.24 }, { start: 0.48 }, { start: 0.72 },
      ];
      assert.equal(pipeline._learnWordPaceFromTimestamps(), false);
      assert.equal(pipeline._measuredMsPerWord, 1400);
    } finally { pipeline.destroy(); }
  });
}

test('Normal pace does not race through Al-Baqarah 2:1 and 2:2', () => {
  const pipeline = lockedPipeline();
  try {
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 2;
    pipeline._displayAyah = pipeline._whisperAyah = pipeline.state.ayah = 1;
    pipeline._scheduleReadAdvance(95);
    assert.ok(pipeline._nextAdvanceMs >= 4500,
      `muqattaat must be timed as spoken letters, got ${pipeline._nextAdvanceMs}ms`);
    pipeline._cancelReadAdvance();

    pipeline._displayAyah = pipeline._whisperAyah = pipeline.state.ayah = 2;
    pipeline._scheduleReadAdvance(95);
    assert.ok(pipeline._nextAdvanceMs >= 10000,
      `normal 2:2 must retain its inferred length, got ${pipeline._nextAdvanceMs}ms`);
  } finally { pipeline.destroy(); }
});

for (const speed of ['normal', 'fast', 'slow']) {
  test(`Translate ${speed} keeps advancing through silence beyond the last heard ayah`, t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
    const pipeline = lockedPipeline();
    try {
      pipeline.setFastMode(speed === 'fast');
      pipeline.setSlowMode(speed === 'slow');
      pipeline._lastDetectedVoiceAt = Date.now() - 5000;
      pipeline._scheduleReadAdvance(95);
      for (const ayah of [2, 3, 4]) {
        assert.ok(pipeline._displayAdvanceTimer, 'pacer stays scheduled without new ASR');
        assert.equal(pipeline._syncingDisplay, false, 'no wait for ASR to catch up');
        t.mock.timers.tick(pipeline._nextAdvanceMs);
        assert.equal(pipeline._displayAyah, ayah);
        assert.equal(pipeline._whisperAyah, 1, 'prediction does not invent heard evidence');
      }
    } finally { pipeline.destroy(); }
  });
}

test('Translate heard-behind corrections adjust pace without cancelling the clock', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 36;
    pipeline._displayAyah = pipeline.state.ayah = 5;
    pipeline._lastDetectedVoiceAt = Date.now() - 5000;
    pipeline._scheduleReadAdvance(95);
    const drift = pipeline._driftMult;
    pipeline._onWhisperConfirm(36, 2, 95, 'والقرآن الحكيم', 0.01, true);
    assert.ok(pipeline._displayAdvanceTimer);
    assert.ok(pipeline._driftMult > drift);
    t.mock.timers.tick(pipeline._nextAdvanceMs);
    assert.equal(pipeline._displayAyah, 6);
  } finally { pipeline.destroy(); }
});

test('Fast continuously slows at one ayah ahead without snapping, then recovers gradually', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline.setFastMode(true);
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 36;
    pipeline._displayAyah = pipeline.state.ayah = 5;
    pipeline._measuredMsPerWord = 900;
    pipeline._msPerWordSamples = [900];
    pipeline._scheduleReadAdvance(95);
    const initialMs = pipeline._nextAdvanceMs;

    pipeline._onWhisperConfirm(36, 4, 95, 'إنا جعلنا في أعناقهم أغلالا', 0.01, true);
    const firstDrift = pipeline._driftMult;
    const firstAdjustedMs = pipeline._nextAdvanceMs;
    assert.equal(pipeline._displayAyah, 5, 'Translate does not snap backward');
    assert.ok(firstDrift > 1);
    assert.ok(firstAdjustedMs > initialMs, 'current countdown is lengthened immediately');

    pipeline._onWhisperConfirm(36, 4, 95, 'إنا جعلنا في أعناقهم أغلالا', 0.01, true);
    assert.equal(pipeline._displayAyah, 5);
    assert.ok(pipeline._driftMult > firstDrift, 'slowdown accumulates on repeated ahead evidence');
    assert.ok(pipeline._nextAdvanceMs > firstAdjustedMs, 'running timer keeps retarding rather than receiving a one-time adjustment');

    const accumulatedDrift = pipeline._driftMult;
    pipeline._onWhisperConfirm(36, 5, 95, 'فهم مقمحون', 0.01, true);
    assert.ok(pipeline._driftMult < accumulatedDrift && pipeline._driftMult > 1,
      'alignment recovers gradually instead of discarding feedback at once');
  } finally { pipeline.destroy(); }
});

test('Translate resyncs backward after two strong confirmations when display is two ayahs ahead', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline.setFastMode(true);
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 36;
    pipeline._displayAyah = pipeline.state.ayah = 5;
    pipeline._scheduleReadAdvance(95);

    pipeline._onWhisperConfirm(36, 3, 95, 'لقد حق القول على أكثرهم', 0.01, true);
    assert.equal(pipeline._displayAyah, 5, 'one confirmation only slows the timer');
    assert.ok(pipeline._driftMult > 1);

    pipeline._onWhisperConfirm(36, 3, 95, 'لقد حق القول على أكثرهم', 0.01, true);
    assert.equal(pipeline._displayAyah, 3, 'repeated strong evidence resyncs the displayed ayah');
    assert.equal(pipeline._driftMult, 1, 'resync starts a fresh timing baseline');
    assert.ok(pipeline._displayAdvanceTimer, 'pacing resumes from the confirmed position');
  } finally { pipeline.destroy(); }
});

test('backward resync requires consecutive strong evidence and ignores an interrupted or weak sequence', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const pipeline = lockedPipeline();
  try {
    pipeline._displaySurah = pipeline._whisperSurah = pipeline.state.surah = 36;
    pipeline._displayAyah = pipeline.state.ayah = 5;
    pipeline._scheduleReadAdvance(95);

    pipeline._onWhisperConfirm(36, 3, 95, 'إنك لمن المرسلين', 0.01, true);
    pipeline._onWhisperConfirm(36, 4, 95, 'على صراط مستقيم', 0.01, true);
    pipeline._onWhisperConfirm(36, 3, 95, 'إنك لمن المرسلين', 0.01, true);
    assert.equal(pipeline._displayAyah, 5, 'an intervening nearer result breaks the resync sequence');

    pipeline._onWhisperConfirm(36, 2, 30, 'والقرآن الحكيم', 0.01, true);
    pipeline._onWhisperConfirm(36, 2, 95, 'والقرآن الحكيم', 0.01, true);
    assert.equal(pipeline._displayAyah, 5, 'a weak result does not count as the first confirmation');

    pipeline._onWhisperConfirm(36, 2, 95, 'والقرآن الحكيم', 0.01, true);
    assert.equal(pipeline._displayAyah, 2, 'two consecutive strong confirmations resync backward');
  } finally { pipeline.destroy(); }
});
