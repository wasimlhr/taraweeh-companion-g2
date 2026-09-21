import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getAdvW, getTextWidth, pxTruncate } from '@evenrealities/pretext';
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the shipped frontend with a fake bridge, DOM, and clock. Do not start its
// DOMContentLoaded bootstrap, network requests, microphone, or real timers.
function harness() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, dataset: {}, textContent: '', innerHTML: '', value: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, appendChild() {},
      querySelector(selector) { return node(id + selector); },
      querySelectorAll() { return []; },
    });
    return nodes.get(id);
  }
  const timeouts = new Map(), intervals = new Map();
  let timerID = 0;
  const writes = [], messages = [];
  const context = vm.createContext({
    console, performance, URL, TextEncoder, Uint8Array, Int16Array, Float32Array, ArrayBuffer,
    navigator: {}, location: { hostname: 'localhost', origin: 'http://localhost', search: '' },
    crypto: { randomUUID: () => 'glasses-ui-test' },
    localStorage: { getItem: () => null, setItem() {} },
    WebSocket: { OPEN: 1 },
    document: {
      getElementById: node, querySelectorAll: () => [], addEventListener() {},
      documentElement: { getAttribute: () => null, setAttribute() {} },
    },
    setTimeout(fn, ms) { const id = ++timerID; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++timerID; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  context.window = context;
  context.addEventListener = () => {};
  const exported = `
    window.testUI = { S, onG2Event, handleServerMsg, glassesStartup,
      recoverStartupIfBlank, glassesMenu, _writeGlasses, buildGlassesText,
      clearGlassesPreamble, startSearchingDots, PREAMBLE_GLASSES,
      startPageFlip,
      setPractice: function (value) { _practiceMode = value; _taraweehMode = !value; },
      setMetrics: function (metrics) { _pretext = metrics; }
    };
  `;
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, exported + '})();'), context);
  const ui = context.testUI;
  Object.assign(ui.S, {
    isG2: true, isRecording: true, startupPageCreated: true, displayRebuilt: false,
    settings: {}, ws: { readyState: 1, send: (msg) => messages.push(JSON.parse(msg)) },
    bridge: {
      createStartUpPageContainer: async (page) => { writes.push({ type: 'startup', page }); return 0; },
      rebuildPageContainer: async (page) => { writes.push({ type: 'rebuild', page }); return true; },
      textContainerUpgrade: async (data) => { writes.push({ type: 'text', data }); return true; },
      audioControl: async () => { throw new Error('Unexpected capture lifecycle change'); },
    },
  });
  return { ui, writes, messages, nodes, timeouts, intervals,
    async flush() { for (let i = 0; i < 12; i++) await ui.S.bridgeCallQueue; },
  };
}

test('glasses menu is valid and preserved by startup, recovery, and verse rebuilds', async () => {
  const h = harness();
  h.ui.glassesStartup();
  await h.flush();
  h.ui.S.startupPageCreated = false;
  h.ui.recoverStartupIfBlank();
  await h.flush();
  h.ui.S.displayRebuilt = false;
  await h.ui._writeGlasses({ hdr: 'Verse', body: 'A new verse' });
  const pages = h.writes.filter((w) => w.page);
  assert.ok(pages.some((w) => w.type === 'startup'));
  assert.ok(pages.filter((w) => w.type === 'rebuild').length >= 2);
  for (const { page } of pages) {
    assert.equal(validateEvenHubPageContainer(page).valid, true);
    assert.deepEqual(Array.from(page.menuObject.menuItems, (item) => item.itemID), [1, 2]);
  }
});

test('menu selection changes the count without pausing or restarting capture', async () => {
  const h = harness();
  h.ui.onG2Event({ sysEvent: { eventType: 4 } });
  h.ui.onG2Event({ menuItemClickEvent: { itemID: 2 } });
  h.ui.onG2Event({ sysEvent: { eventType: 5 } });
  await h.flush();
  assert.deepEqual(h.messages, [{ type: 'adjust_rakat', delta: 1 }]);
  assert.equal(h.ui.S.isRecording, true);
  h.ui.onG2Event({ menuItemClickEvent: { itemID: 1 } });
  h.ui.onG2Event({ menuItemClickEvent: { itemID: 999 } });
  assert.deepEqual(h.messages.at(-1), { type: 'adjust_rakat', delta: -1 });
  assert.equal(h.messages.length, 2);
  h.ui.setPractice(true);
  h.ui.onG2Event({ menuItemClickEvent: { itemID: 2 } });
  assert.equal(h.messages.length, 2);
});

for (const [kind, raw, title] of [
  ['bismillah', 'بسم الله الرحمن الرحيم', 'Bismillah'],
  ['istiadhah', 'أعوذ بالله من الشيطان الرجيم', "A'udhu billah"],
]) {
  test(`${kind} reaches glasses, survives search, and yields immediately to a verse`, async () => {
    const h = harness();
    h.ui.setMetrics({ getTextWidth, pxTruncate });
    h.ui.handleServerMsg({ type: 'match_progress', whisperText: raw, candidates: [] });
    await h.flush();
    const page = h.writes.find((w) => w.page)?.page;
    assert.ok(page, 'preamble must reach the bridge');
    assert.equal(page.textObject.find((c) => c.containerID === 1).content, title);
    const body = page.textObject.find((c) => c.containerID === 3).content;
    assert.match(body, /Allah/);
    for (const line of body.split('\n')) {
      assert.ok(getTextWidth(line) <= 572);
      for (const ch of line) assert.ok(getAdvW(ch.codePointAt(0)) > 0, `missing glyph ${ch}`);
    }
    h.ui.handleServerMsg({ type: 'state', state: { mode: 'SEARCHING' } });
    for (const timer of h.intervals.values()) timer.fn();
    assert.equal(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, title);
    h.ui.setPractice(true);
    h.ui.handleServerMsg({ type: 'state', state: {
      mode: 'LOCKED', surah: 112, ayah: 1, confidence: 0.9,
      arabic: 'قل هو الله أحد', translation: 'Say, He is Allah, One.',
    } });
    await h.flush();
    assert.notEqual(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, title);
    assert.equal([...h.timeouts.values()].filter((t) => t.ms === 1500).length, 0);
  });
}

test('preamble expires without a verse and does not display while stopped', async () => {
  const h = harness();
  h.ui.handleServerMsg({ type: 'match_progress', preamble: 'bismillah' });
  await h.flush();
  const expiry = [...h.timeouts.values()].find((t) => t.ms === 1500);
  assert.ok(expiry);
  expiry.fn();
  await h.flush();
  assert.notEqual(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, 'Bismillah');
  h.ui.S.isRecording = false;
  h.writes.length = 0;
  h.ui.handleServerMsg({ type: 'match_progress', preamble: 'bismillah' });
  await h.flush();
  assert.equal(h.writes.length, 0);
});

test('repeated preambles never extend the notice or bring it back after expiry', async () => {
  const h = harness();
  const opening = { type: 'match_progress', preamble: 'bismillah' };
  h.ui.handleServerMsg(opening);
  await h.flush();
  const timer = [...h.timeouts.entries()].find(([, t]) => t.ms === 1500);
  h.ui.handleServerMsg(opening);
  assert.equal(h.timeouts.get(timer[0]), timer[1]);
  timer[1].fn();
  await h.flush();
  h.writes.length = 0;
  h.ui.handleServerMsg(opening);
  await h.flush();
  assert.equal(h.writes.length, 0);
});

test('fresh recitation dismisses the preamble before a candidate or lock arrives', async () => {
  const h = harness();
  h.ui.handleServerMsg({ type: 'match_progress', preamble: 'bismillah' });
  h.ui.handleServerMsg({ type: 'match_progress', whisperText: 'الحمد لله رب العالمين' });
  await h.flush();
  assert.notEqual(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, 'Bismillah');
  assert.equal([...h.timeouts.values()].filter((t) => t.ms === 1500).length, 0);
});

test('an opening followed by Ya-Sin is recitation, not a renewed preamble notice', async () => {
  const h = harness();
  h.ui.handleServerMsg({ type: 'match_progress', preamble: 'bismillah' });
  h.ui.handleServerMsg({ type: 'match_progress', whisperText: 'بسم الله الرحمن الرحيم يس' });
  await h.flush();
  assert.notEqual(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, 'Bismillah');
  assert.equal([...h.timeouts.values()].filter((t) => t.ms === 1500).length, 0);
});

test('glasses show the verse and timer from the first frame with no match percentages', async () => {
  const h = harness();
  h.ui.setMetrics({ getTextWidth, pxTruncate });
  const verse = { surah: 1, ayah: 2, surahName: 'Al-Fatihah',
    confidence: 0.96, candidateScore: 96, translation: 'All praise is due to Allah.' };
  for (const state of [
    { ...verse, mode: 'LOCKED' },
    { ...verse, mode: 'SEARCHING', isCandidate: true },
    { ...verse, mode: 'SEARCHING', userSearching: true },
  ]) {
    const display = h.ui.buildGlassesText(state);
    assert.doesNotMatch(display.hdr + display.pages.join(''), /Match|%/);
  }
  h.ui.startPageFlip(h.ui.buildGlassesText({ ...verse, mode: 'LOCKED' }), 8000);
  await h.flush();
  const firstHeader = h.writes.find((w) => w.page).page.textObject.find((c) => c.containerID === 1).content;
  assert.match(firstHeader, /Al-Fatihah 1:2\s+8s$/);
  assert.ok(getTextWidth(firstHeader) <= 356);
  assert.doesNotMatch(firstHeader, /Match|%/);
});
