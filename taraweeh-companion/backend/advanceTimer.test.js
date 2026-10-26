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
    pipeline._wordPaceSamples = 5;
    pipeline._measuredMsPerWord = 818;
    pipeline._msPerWordSamples = [1688, 1700, 1542, 1396];
    pipeline._ayahStartTime = Date.now() - 6960;
    pipeline._learnPaceFromManual();
    assert.equal(pipeline._measuredMsPerWord, 870);
    assert.deepEqual(pipeline._msPerWordSamples, [870]);
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
