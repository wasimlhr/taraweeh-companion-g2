import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionTrace, redactSecrets } from './sessionTrace.js';
import { TraceStore } from './traceStore.js';
import { PrayerTracker, POSITIONS, TIMING } from './prayerTracker.js';

function makeTrace(opts = {}) {
  let clock = 1_000_000;
  const streamed = [];
  const trace = new SessionTrace({
    now: () => clock,
    onEvent: (e) => streamed.push(e),
    ...opts,
  });
  return { trace, streamed, advance(ms) { clock += ms; } };
}

test('sessionTrace — recording', async (t) => {
  await t.test('stamps each event with a sequence number and session-relative time', () => {
    const h = makeTrace();
    h.advance(1500);
    const e = h.trace.record('asr', { text: 'الله أكبر', audioMs: 3000 });
    assert.equal(e.seq, 1);
    assert.equal(e.t, 1500);
    assert.equal(e.type, 'asr');
    assert.equal(e.audioMs, 3000);
  });

  await t.test('records whether or not anyone is streaming', () => {
    const h = makeTrace();
    h.trace.record('asr', { text: 'one' });
    assert.equal(h.streamed.length, 0, 'nothing pushed while the panel is closed');
    assert.equal(h.trace.events.length, 1, 'but it is still on the buffer');

    h.trace.setStreaming(true);
    h.trace.record('asr', { text: 'two' });
    assert.equal(h.streamed.length, 1);
    assert.equal(h.trace.events.length, 2);
  });

  await t.test('drops the oldest events and says how many', () => {
    const h = makeTrace({ maxEvents: 10 });
    for (let i = 0; i < 25; i++) h.trace.record('audio', { i });
    assert.equal(h.trace.events.length, 10);
    assert.equal(h.trace.dropped, 15);
    assert.equal(h.trace.events[0].i, 15, 'the newest ten survive');
    assert.equal(h.trace.summary().dropped, 15);
  });

  await t.test('clips long transcripts rather than carrying them whole', () => {
    const h = makeTrace();
    const e = h.trace.record('asr', { text: 'ا'.repeat(500) });
    assert.equal(e.text.length, 200);
    assert.ok(e.text.endsWith('\u2026'));
  });

  await t.test('a listener that throws cannot take the pipeline down', () => {
    const trace = new SessionTrace({ onEvent: () => { throw new Error('socket closed'); } });
    trace.setStreaming(true);
    assert.doesNotThrow(() => trace.record('asr', { text: 'x' }));
    assert.equal(trace.events.length, 1);
  });
});

test('sessionTrace — summary', async (t) => {
  await t.test('counts rejections by reason, which is what a report is read for', () => {
    const h = makeTrace();
    h.trace.record('cue', { kind: 'takbeer', accepted: true, reason: 'accepted' });
    h.trace.record('cue', { kind: 'takbeer', accepted: false, reason: 'refractory' });
    h.trace.record('cue', { kind: 'takbeer', accepted: false, reason: 'refractory' });
    h.trace.record('cue', { kind: 'tasleem', accepted: false, reason: 'quoted-by-the-ayah' });

    const s = h.trace.summary();
    assert.equal(s.cues.total, 4);
    assert.equal(s.cues.accepted, 1);
    assert.deepEqual(s.cues.byKind, { takbeer: 3, tasleem: 1 });
    assert.deepEqual(s.cues.rejectedBecause, { 'refractory': 2, 'quoted-by-the-ayah': 1 });
  });

  await t.test('reports how far the prayer got and how it got there', () => {
    const h = makeTrace();
    h.trace.record('prayer', { from: 'QIYAM', to: 'RUKU', reason: 'cue-takbeer', rakat: 1 });
    h.trace.record('prayer', { from: 'RUKU', to: 'ITIDAL', reason: 'timeout', rakat: 1 });
    h.trace.record('prayer', { from: 'ITIDAL', to: 'SAJDA1', reason: 'cue-takbeer', rakat: 2 });

    const s = h.trace.summary();
    assert.equal(s.prayer.transitions, 3);
    assert.equal(s.prayer.rakatReached, 2);
    assert.deepEqual(s.prayer.byReason, { 'cue-takbeer': 2, 'timeout': 1 });
  });

  await t.test('separates transcripts that came back empty', () => {
    const h = makeTrace();
    h.trace.record('asr', { text: 'الحمد لله' });
    h.trace.record('asr', { text: '' });
    h.trace.record('asr', { text: '' });
    const s = h.trace.summary();
    assert.deepEqual(s.transcripts, { total: 3, empty: 2 });
  });
});

test('sessionTrace — redaction', async (t) => {
  await t.test('never carries a key, but says one was present', () => {
    const out = redactSecrets({
      groqApiKey: 'gsk_abcdefghijklmnop',
      openaiApiKey: '',
      provider: 'groq',
      nested: { authorization: 'Bearer tok_12345678' },
    });
    assert.ok(!JSON.stringify(out).includes('gsk_abcdefghijklmnop'));
    assert.match(out.groqApiKey, /redacted 20 chars, ends …mnop/);
    assert.equal(out.openaiApiKey, '[empty]');
    assert.equal(out.provider, 'groq', 'non-secrets pass through');
    assert.ok(!JSON.stringify(out).includes('tok_12345678'));
  });

  await t.test('survives cycles and deep nesting without hanging', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { apiKey: 'x' } } } } } } } };
    assert.doesNotThrow(() => redactSecrets(deep));
    assert.doesNotThrow(() => redactSecrets([1, 'two', null, undefined]));
  });

  await t.test('strips keys out of the metadata a report carries', () => {
    const h = makeTrace();
    h.trace.setMeta({ provider: 'groq', groqApiKey: 'gsk_secret_value_here' });
    assert.ok(!JSON.stringify(h.trace.report()).includes('gsk_secret_value_here'));
    assert.equal(h.trace.meta.provider, 'groq');
  });
});

test('traceStore — field reports', async (t) => {
  const report = (over = {}) => ({ v: 1, sessionId: 'abc12345', summary: { events: 3 }, events: [], ...over });

  await t.test('accepts a well-formed report and hands back an id', () => {
    const store = new TraceStore();
    const r = store.add(report(), { note: 'counted nine instead of eight' });
    assert.equal(r.ok, true);
    assert.match(r.id, /^r\d+$/);
    assert.equal(store.list()[0].note, 'counted nine instead of eight');
  });

  await t.test('rejects anything that is not a version 1 report', () => {
    const store = new TraceStore();
    assert.equal(store.add(null).ok, false);
    assert.equal(store.add('a string').ok, false);
    assert.equal(store.add({ v: 2 }).ok, false);
    assert.equal(store.list().length, 0);
  });

  await t.test('refuses a report too large to be worth keeping', () => {
    const store = new TraceStore();
    const huge = report({ events: new Array(200000).fill({ type: 'audio', rms: 0.1234 }) });
    const r = store.add(huge);
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  });

  await t.test('keeps only the most recent reports, newest listed first', () => {
    const store = new TraceStore({ maxReports: 3 });
    for (let i = 0; i < 6; i++) store.add(report({ sessionId: 's' + i }));
    const list = store.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].sessionId, 's5');
    assert.equal(list[2].sessionId, 's3');
  });

  await t.test('the index omits the events, the detail view keeps them', () => {
    const store = new TraceStore();
    const { id } = store.add(report({ events: [{ seq: 1, type: 'asr' }] }));
    assert.equal(store.list()[0].events, undefined);
    assert.equal(store.get(id).report.events.length, 1);
    assert.equal(store.get('nope'), null);
  });
});

test('prayerTracker — decision breakdown', async (t) => {
  function makeTracker(config = {}) {
    const decisions = [];
    let clock = 1_000_000;
    const tracker = new PrayerTracker({
      config, now: clock, log: () => {},
      onDecision: (d) => decisions.push(d),
    });
    return {
      tracker, decisions,
      cue(text, opts = {}) {
        clock += opts.wait == null ? 6000 : opts.wait;
        return tracker.feedText(text, { now: clock, ...opts });
      },
    };
  }
  const TAKBEER = 'الله أكبر';

  await t.test('reports an accepted cue with the scores behind it', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    assert.equal(h.decisions.length, 1);
    const d = h.decisions[0];
    assert.equal(d.accepted, true);
    assert.equal(d.reason, 'accepted');
    assert.equal(d.from, POSITIONS.QIYAM);
    assert.equal(d.to, POSITIONS.RUKU);
    assert.equal(d.pAudio, 1);
    assert.equal(d.pTemporal, 1);
    assert.ok(d.score >= 0.55);
  });

  await t.test('names the refractory window when an echo is dropped', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    h.cue(TAKBEER, { wait: 400 });
    const d = h.decisions.at(-1);
    assert.equal(d.accepted, false);
    assert.equal(d.reason, 'refractory');
    assert.equal(d.sinceLastMs, 400);
  });

  await t.test('names replayed audio, with the window that was already consumed', () => {
    const h = makeTracker();
    h.cue(TAKBEER, { windowStartMs: 0, windowEndMs: 5000 });
    h.cue(TAKBEER, { wait: 4000, windowStartMs: 0, windowEndMs: 9000 });
    const d = h.decisions.at(-1);
    assert.equal(d.reason, 'replayed-audio');
    assert.equal(d.consumedUntil, 5000);
  });

  await t.test('names the minimum dwell when a cue arrives too fast', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    // Past the refractory window but well inside ruku's three-second floor.
    assert.equal(h.cue(TAKBEER, { wait: 2000 }), null);
    const d = h.decisions.at(-1);
    assert.equal(d.reason, 'too-soon');
    assert.equal(d.minDwellMs, 3000);
  });

  await t.test('names the ayah veto for a verse that quotes a cue', () => {
    const h = makeTracker();
    h.cue('ولذكر الله أكبر', { verseActive: 1 });
    const d = h.decisions.at(-1);
    assert.equal(d.accepted, false);
    assert.equal(d.reason, 'quoted-by-the-ayah');
    assert.equal(d.leading, 1);
  });

  await t.test('names a cue buried in recitation', () => {
    const h = makeTracker();
    h.cue('ولذكر الله أكبر والله يعلم ما تصنعون وهو على كل شيء قدير');
    const d = h.decisions.at(-1);
    assert.equal(d.reason, 'buried-in-recitation');
    assert.ok(d.pAudio < 0.3);
  });

  await t.test('names the state machine when a cue lands with nowhere to go', () => {
    const h = makeTracker();
    h.cue(TAKBEER);                       // → ruku'
    h.cue('ربنا ولك الحمد');              // → i'tidal
    h.cue('اللهم اهدنا فيمن هديت');       // → qunoot
    const before = h.tracker.position;
    h.cue('ربنا ولك الحمد');              // qunoot has no tahmeed transition
    const d = h.decisions.at(-1);
    assert.equal(d.accepted, false);
    assert.equal(d.reason, 'no-transition-from-here');
    assert.equal(h.tracker.position, before);
  });

  await t.test('is silent when there is no cue at all', () => {
    const h = makeTracker();
    h.cue('الحمد لله رب العالمين');
    assert.equal(h.decisions.length, 0);
  });

  await t.test('refractory uses the documented window', () => {
    const h = makeTracker();
    h.cue(TAKBEER);
    assert.equal(h.cue(TAKBEER, { wait: TIMING.REFRACTORY_MS - 100 }), null);
  });
});
