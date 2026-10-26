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
  assert.equal(isOpeningPreamble('بسم الله'), true);
  assert.equal(isOpeningPreamble('بسم الله الرحمن'), true);
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

test('Practice publishes its first partial match and replaces it with the next heard verse', async t => {
  loadQuran();
  const updates = [];
  const pipeline = new AudioPipeline({ onStateUpdate: m => updates.push(m), onStatus() {}, onError() {},
    whisperOpts: { provider: 'groq', groqApiKey: 'test-key' } });
  pipeline.active = true;
  pipeline.setPracticeMode(true);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ text: 'إنا أطيناك الكوثر' }), { status: 200 }));
  try {
    updates.length = 0;
    await pipeline._processSearchTranscript({ text: 'سمرا دعنا هم أسفل سفلين', words: [], rms: 0.007,
      bufMs: 5120, audioWindow: { startMs: 0, endMs: 5120 }, submittedBufferBytes: 0, myGen: pipeline._searchGen });
    assert.ok(updates.some(m => m.type === 'state' && m.state.mode === 'LOCKED' && m.state.surah === 95 && m.state.ayah === 5),
      'accepted partial match must reach the screen immediately');
    await pipeline._processLockedChunk(Buffer.alloc(3000 * 32, 1), 1);
    assert.equal(pipeline._displaySurah, 108);
    assert.equal(pipeline._displayAyah, 1);
    assert.ok(updates.some(m => m.type === 'state' && m.state.mode === 'LOCKED' && m.state.surah === 108 && m.state.ayah === 1));
    assert.equal(pipeline._displayAdvanceTimer, null, 'Practice must remain recognition-driven');
    assert.equal(pipeline.processing, false);
  } finally { pipeline.destroy(); }
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

test('all reciter speeds keep automatic advancement separate from Practice', () => {
 const pipeline=new AudioPipeline({onStateUpdate(){},onStatus(){}});
 pipeline.setFastMode(true);assert.equal(pipeline.followMode,false);assert.equal(pipeline.fastMode,true);
 pipeline.setSlowMode(true);assert.equal(pipeline.followMode,false);assert.equal(pipeline.fastMode,false);assert.equal(pipeline.slowMode,true);
 pipeline.setSlowMode(false);assert.equal(pipeline.followMode,false);assert.equal(pipeline.practiceMode,false);pipeline.stop();
});

test('Normal Translate advances on its timer without another ASR confirmation, including after speed changes', async () => {
 loadQuran();
 const {pipeline}=makePipeline();
 try {
  pipeline.active=true;pipeline.setTaraweehMode(false);
  pipeline.state={mode:'LOCKED',surah:112,ayah:1,confidence:95};
  pipeline._displaySurah=112;pipeline._displayAyah=1;
  pipeline._whisperSurah=112;pipeline._whisperAyah=1;
  pipeline.setFastMode(true);pipeline.setSlowMode(true);pipeline.setSlowMode(false);
  assert.equal(pipeline.followMode,false);
  pipeline._scheduleReadAdvance(95,0,1,20);
  assert.ok(pipeline._displayAdvanceTimer);
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(pipeline._displayAyah,2);
  pipeline.setPracticeMode(true);
  pipeline._scheduleReadAdvance(95,0,1,20);
  assert.equal(pipeline._displayAdvanceTimer,null);
 } finally {pipeline.destroy();}
});


test('provider quota exhaustion blocks retries and temporary rate limits honor Retry-After', () => {
 const {pipeline,statuses}=makePipeline();
 pipeline._handleTranscriptionError({status:429,retryAfterMs:90000});
 assert.ok(pipeline._rateLimitedUntilMs-Date.now()>89000);
 pipeline._handleTranscriptionError({status:429,quotaExhausted:true});
 assert.equal(pipeline._rateLimitedUntilMs,Infinity);assert.equal(pipeline._isRateLimited(),true);
 assert.equal(statuses.at(-1).quotaExhausted,true);pipeline.destroy();
});

test('steady low simulator noise does not open the transcription gate', () => {
 const {pipeline}=makePipeline();pipeline.setAudioSource('simulator');pipeline.active=true;
 const pcm=Buffer.alloc(6400);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE((i/2)%2?49:-49,i);
 for(let i=0;i<100;i++)pipeline.ingest(pcm);
 assert.equal(pipeline._lastDetectedVoiceAt,0);
 const voice=Buffer.alloc(6400);for(let i=0;i<voice.length;i+=2)voice.writeInt16LE((i/2)%2?600:-600,i);
 pipeline.ingest(voice);assert.ok(pipeline._lastDetectedVoiceAt>0);pipeline.destroy();
});


test('Practice selection rejects other surahs and manual Next stays inside its boundary', () => {
 loadQuran();const {pipeline}=makePipeline();pipeline.setPracticeMode(true);pipeline.setRestrictSurah(112);
 pipeline._snapPracticeVerse(112,4,0.95);pipeline.manualAdvance();
 assert.equal(pipeline._displaySurah,112);assert.equal(pipeline._displayAyah,4);
 pipeline._snapPracticeVerse(114,1,0.95);assert.equal(pipeline._displaySurah,112);
 pipeline.manualPrev();assert.equal(pipeline._displayAyah,3);pipeline.destroy();
});

test('Translate and Taraweeh follow the same confirmed ayahs while only Taraweeh feeds prayer counting', () => {
 loadQuran();const results=[];
 for(const taraweeh of [false,true]) {
  const {pipeline}=makePipeline();pipeline.setTaraweehMode(taraweeh);pipeline.setFollowMode(true);
  pipeline.state={mode:'LOCKED',surah:114,ayah:1,confidence:1};pipeline._displaySurah=114;pipeline._displayAyah=1;
  let prayerEvents=0;pipeline.prayer.feedVerse=()=>{prayerEvents++};
  const shown=[];for(const ayah of [2,3,4]){pipeline._onWhisperConfirm(114,ayah,0.95,'recitation',0.1,true);shown.push(pipeline._displayAyah);}
  results.push(shown);assert.equal(prayerEvents,taraweeh?3:0);assert.equal(pipeline.practiceMode,false);pipeline.destroy();
 }
 assert.deepEqual(results[0],results[1]);
});


test('PC and phone profiles reject steady noisy-room audio before any transcription can start', () => {
 for(const source of ['simulator','browser']) {
  const {pipeline}=makePipeline();pipeline.setAudioSource(source);pipeline.active=true;
  let sends=0;pipeline._processSearchChunk=()=>{sends++};
  let seed=123;for(let frame=0;frame<150;frame++) {
   const pcm=Buffer.alloc(6400);for(let i=0;i<3200;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;pcm.writeInt16LE(Math.round((seed/2147483648)*500),i*2);}
   pipeline.ingest(pcm);
  }
  assert.equal(sends,0,source+' steady room noise must not trigger requests');
  const voice=Buffer.alloc(6400);for(let i=0;i<3200;i++)voice.writeInt16LE(Math.round(1800*Math.sin(2*Math.PI*500*i/16000)),i*2);
  for(let i=0;i<4;i++)pipeline.ingest(voice);
  assert.ok(pipeline._searchVoicedMs>=500,source+' speech-level activity must open the gate');
  assert.ok(pipeline._micFilter);pipeline.destroy();
 }
});

test('G2 and PC use separate conditioning and gain profiles', () => {
 const {pipeline}=makePipeline();pipeline.setAudioSource('g2');assert.equal(pipeline._micFilter,null);
 const g2Gain=pipeline._audioProfile.maxBoostGain;
 pipeline.setAudioSource('simulator');assert.ok(pipeline._micFilter);assert.ok(pipeline._audioProfile.maxBoostGain<g2Gain);
 pipeline.destroy();
});

test('PC and phone retain quiet speech activity but reject a single short click', () => {
 for (const source of ['simulator', 'browser']) {
  const {pipeline}=makePipeline();pipeline.setAudioSource(source);pipeline.active=true;
  let sends=0;pipeline._processSearchChunk=()=>{sends++};
  const silence=Buffer.alloc(6400);
  for(let i=0;i<20;i++)pipeline.ingest(silence);
  const click=Buffer.alloc(6400);click.writeInt16LE(30000,100);
  pipeline.ingest(click);
  assert.equal(sends,0);assert.equal(pipeline._searchGateOpen(),false);
  const quiet=Buffer.alloc(6400);
  for(let i=0;i<3200;i++)quiet.writeInt16LE(Math.round(160*Math.sin(2*Math.PI*400*i/16000)),i*2);
  for(let i=0;i<20;i++)pipeline.ingest(quiet);
  assert.ok(pipeline._searchVoicedMs>=500,source+' quiet activity survives conditioning');
  assert.ok(sends>0,source+' sustained quiet activity permits a request');pipeline.destroy();
 }
});

test('search gate never opens merely because time passed without voice', () => {
 const {pipeline}=makePipeline();pipeline._lastSearchCall=1;
 assert.equal(pipeline._searchGateOpen(60000),false);
 assert.equal(pipeline._searchGateOpen(600000),false);pipeline.destroy();
});

test('Translate and Taraweeh reuse a cross-surah transcript instead of discarding it', async (t) => {
 loadQuran();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({text:'إن الإنسان لفي خسر'}),{status:200});});
 for(const taraweeh of [false,true]) {
  const {pipeline}=makePipeline();pipeline.setTaraweehMode(taraweeh);pipeline.setFollowMode(true);
  pipeline.active=true;pipeline.state={...pipeline.state,mode:'LOCKED',surah:55,ayah:13,missedChunks:0};
  pipeline._displaySurah=55;pipeline._displayAyah=13;pipeline._lockedInFlight=1;
  try {
   await pipeline._processLockedChunk(Buffer.alloc(3000*32,1),1);
   assert.equal(pipeline._displaySurah,55,'first unexpected jump stays pending');
   await pipeline._processLockedChunk(Buffer.alloc(3000*32,1),2);
   assert.equal(pipeline.state.mode,'LOCKED');assert.equal(pipeline.state.surah,103);
   assert.equal(pipeline._displaySurah,103);assert.equal(pipeline._displayAyah,2);
  } finally {pipeline.destroy();}
 }
 assert.equal(calls,4,'two independent checks per mode confirm the jump');
});

test('a single unexpected verse cannot switch surahs and intervening results break confirmation', () => {
 const {pipeline}=makePipeline();
 assert.equal(pipeline._confirmGlobalJump({surah:28,ayah:83}),false);
 pipeline._pendingGlobalJump=null;
 assert.equal(pipeline._confirmGlobalJump({surah:36,ayah:12}),false);
 assert.equal(pipeline._confirmGlobalJump({surah:36,ayah:13}),true);
 assert.equal(pipeline._confirmGlobalJump({surah:103,ayah:2}),false);pipeline.destroy();
});

test('Follow keeps word progress separate from predicted verse advancement', () => {
 loadQuran();const {pipeline,updates}=makePipeline();pipeline.setTaraweehMode(false);pipeline.setFollowMode(true);
 pipeline.active=true;pipeline._onWhisperConfirm(36,12,0.95,'recitation',0.03,true);
 assert.ok(pipeline._wordProgressInterval);assert.equal(pipeline._displayAdvanceTimer,null);
 assert.ok(updates.some(x=>x.type==='wordProgress'&&x.surah===36&&x.ayah===12));
 pipeline._onWhisperConfirm(36,13,0.95,'recitation',0.03,true);
 assert.equal(pipeline._displayAyah,13);assert.equal(pipeline._displayAdvanceTimer,null);pipeline.destroy();
});

test('switching reciter speeds replaces the timer and Normal keeps word updates', () => {
 loadQuran();const {pipeline}=makePipeline();pipeline.setTaraweehMode(false);pipeline.active=true;
 pipeline.state={...pipeline.state,mode:'LOCKED',surah:36,ayah:12,confidence:0.95};
 pipeline._displaySurah=36;pipeline._displayAyah=12;pipeline._lastDetectedVoiceAt=Date.now();
 pipeline.setFastMode(true);assert.ok(pipeline._displayAdvanceTimer);const first=pipeline._displayAdvanceTimer;
 pipeline.setSlowMode(true);assert.ok(pipeline._displayAdvanceTimer);assert.notEqual(pipeline._displayAdvanceTimer,first);
 pipeline.setSlowMode(false);assert.ok(pipeline._displayAdvanceTimer);assert.ok(pipeline._wordProgressInterval);
 pipeline.setFastMode(true);assert.ok(pipeline._displayAdvanceTimer);pipeline.destroy();
});

test('one hallucinated foreign ayah does not interrupt a following real Ya-Sin match',async(t)=>{
 loadQuran();const {pipeline}=makePipeline();pipeline.setTaraweehMode(false);pipeline.setFollowMode(true);
 const texts=['تلك الدار الآخرة نجعلها للذين لا يريدون علوا في الأرض ولا فسادا والعاقبة للمتقين','إنما تنذر من اتبع الذكر وخشي الرحمن بالغيب فبشره بمغفرة وأجر كريم'];
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({text:texts.shift()}),{status:200}));
 pipeline.active=true;pipeline.state={...pipeline.state,mode:'LOCKED',surah:36,ayah:10};pipeline._displaySurah=36;pipeline._displayAyah=10;
 try{
  await pipeline._processLockedChunk(Buffer.alloc(3000*32,1),1);assert.equal(pipeline._displaySurah,36);assert.equal(pipeline._displayAyah,10);
  await pipeline._processLockedChunk(Buffer.alloc(3000*32,1),2);assert.equal(pipeline._displaySurah,36);assert.equal(pipeline._displayAyah,11);assert.equal(pipeline._pendingGlobalJump,null);
 }finally{pipeline.destroy();}
});
