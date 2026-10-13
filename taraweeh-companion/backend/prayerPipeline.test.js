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

test('count corrections and Fatiha openings never reset recitation', () => {
  const {pipeline,updates}=makePipeline();
  try {
    pipeline.state={...pipeline.state,mode:'LOCKED',surah:114,ayah:1};
    pipeline._displaySurah=114;pipeline._displayAyah=1;
    const before=pipeline.state;
    assert.equal(pipeline._feedPrayerCue(TAKBEER),false);
    pipeline.prayer.feedVerse({surah:1,ayah:2,locked:true,confidence:1});
    pipeline.prayer.feedVerse({surah:1,ayah:7,locked:true,confidence:1});
    pipeline.prayer.lastOpeningAt-=30000;
    pipeline.prayer.feedVerse({surah:1,ayah:2,locked:true,confidence:1});
    assert.equal(pipeline.prayer.rakat,2);
    pipeline.adjustRakat(1);
    assert.equal(pipeline.prayer.rakat,3);
    assert.equal(pipeline.state,before);
    assert.equal(pipeline._displaySurah,114);
    assert.ok(updates.some(m=>m.type==='taraweeh' && m.rakat===2));
  } finally {pipeline.destroy();}
});


test('Follow blocks predicted advancement and moves only on real heard confirmation', () => {
 const pipeline=new AudioPipeline({onStateUpdate(){},onStatus(){}});
 pipeline.active=true;pipeline.state={mode:'LOCKED',surah:114,ayah:1,confidence:1};
 pipeline._displaySurah=114;pipeline._displayAyah=1;
 pipeline.setFollowMode(true);assert.equal(pipeline.practiceMode,false);
 pipeline._scheduleReadAdvance(100);assert.equal(pipeline._displayAdvanceTimer,null);
 pipeline._onWhisperConfirm(114,2,0.95,'heard verse',0.1,false);assert.equal(pipeline._displayAyah,1);
 pipeline._onWhisperConfirm(114,2,0.95,'heard verse',0.1,true);assert.equal(pipeline._displayAyah,2);
 assert.equal(pipeline._displayAdvanceTimer,null);pipeline.stop();
});

test('pace choices keep Follow separate from Practice and preserve fast and slow selection', () => {
 const pipeline=new AudioPipeline({onStateUpdate(){},onStatus(){}});
 pipeline.setFastMode(true);assert.equal(pipeline.followMode,false);assert.equal(pipeline.fastMode,true);
 pipeline.setSlowMode(true);assert.equal(pipeline.followMode,false);assert.equal(pipeline.fastMode,false);assert.equal(pipeline.slowMode,true);
 pipeline.setSlowMode(false);assert.equal(pipeline.followMode,true);assert.equal(pipeline.practiceMode,false);pipeline.stop();
});
