import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getAdvW, getTextWidth, pxTruncate } from '@evenrealities/pretext';
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';
import { HOME_MODES, modeHomePage } from '../app/glassesHome.js';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the shipped frontend with a fake bridge, DOM, and clock. Do not start its
// DOMContentLoaded bootstrap, network requests, microphone, or real timers.
function harness() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, dataset: {}, options: [], children: [], selectedIndex: 0, textContent: '', innerHTML: '', value: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, setAttribute() {}, appendChild(child) {this.children.push(child);}, replaceChildren() {this.children=[];},
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
      createElement: tag => node('created-' + tag),
      createTextNode: text => ({ textContent:text }),
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
      setAudioControls: controls=>{_audioMode=true;_audioUI=controls;},
      recoverStartupIfBlank, glassesMenu, _writeGlasses, buildGlassesText,
      showModeHome, leaveModeHome, getHome:()=>({active:_homeActive,index:_homeIndex}),
      setReaderPicker:(kind,value,max)=>{_readerActive=true;_readerPicking=kind;_readerPick=value;_readerData={surah:2,verses:Array(max).fill({})};},
      getReaderPicker:()=>({kind:_readerPicking,value:_readerPick}),
      clearGlassesPreamble, startSearchingDots, PREAMBLE_GLASSES,
      quranArabicDisplay, arabicLayoutPages, arabicImageCanvas, buildPages, G2_BODY_LINES, startPageFlip, _buildTraceReport, stopListening, rakatHdr, _applyPrayerSnapshot,
      setMode: function (mode) {
        _reciteMode = mode; _practiceMode = mode === 'practice'; _taraweehMode = mode === 'taraweeh';
      },
      setReciteMode: window.setReciteMode,
      applyLocalTranslation, fetchLangPack,
      setPack: function (lang, verses) { _langPacks[lang] = verses; },
      setPractice: function (value) { _practiceMode = value; _taraweehMode = !value; _reciteMode = value ? 'practice' : 'taraweeh'; },
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
  return { ui, writes, messages, nodes, timeouts, intervals, context,
    async flush() { for (let i = 0; i < 12; i++) await ui.S.bridgeCallQueue; },
  };
}

test('switching local languages preserves the source state and English glasses fallback', () => {
  const h = harness();
  const pack = text => Array.from({ length: 114 }, () => [text]);
  h.ui.setPack('fr', pack('French'));
  h.ui.setPack('ur', pack('Urdu'));
  h.ui.setPack('en', pack('English'));
  const state = { surah: 1, ayah: 1, translation: 'English', translationGlasses: 'English' };
  h.ui.S.settings.lang = 'fr';
  const french = h.ui.applyLocalTranslation(state);
  assert.equal(french.translationGlasses, 'French');
  assert.equal(state.translation, 'English');
  h.ui.S.settings.lang = 'ur';
  const urdu = h.ui.applyLocalTranslation(state);
  assert.equal(urdu.translation, 'Urdu');
  assert.equal(urdu.translationGlasses, 'English');
});

test('a stalled pack source times out and falls through to the next source', async () => {
  const h = harness();
  const urls = [];
  h.context.fetch = url => {
    urls.push(url);
    if (urls.length === 1) return new Promise(() => {});
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ verses: Array.from({length:114}, () => ['translation']) }) });
  };
  const result = h.ui.fetchLangPack('fr');
  const timeout = [...h.timeouts.values()].find(timer => timer.ms === 15000);
  assert.ok(timeout);
  timeout.fn();
  const verses = await result;
  assert.equal(verses.length, 114);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/translations\/fr\.json$/);
  assert.match(urls[1], /\/app\/translations\/fr\.json$/);
  assert.equal(new URL(urls[0]).origin, new URL(urls[1]).origin);
});

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
    assert.deepEqual(Array.from(page.menuObject.menuItems, (item) => item.itemID), [3, 4, 5, 6, 10, 11, 12]);
  }
});

test('menu selection changes the count without pausing or restarting capture', async () => {
  const h = harness();
  h.ui.setMode('taraweeh');
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
  for (const mode of ['practice', 'listen']) {
    h.ui.setMode(mode);
    h.ui.onG2Event({ menuItemClickEvent: { itemID: 2 } });
    assert.equal(h.messages.length, 2);
  }
});

test('Listen is the default: no rak\'ah header, and it tells the backend Taraweeh is off', async () => {
  const h = harness();
  assert.equal(h.ui.rakatHdr(), 'Translate mode');
  h.ui.setReciteMode('listen');
  assert.deepEqual(h.messages, [
    { type: 'set_restrict_surah', surah: 0 },
    { type: 'set_practice_mode', enabled: false },
    { type: 'set_taraweeh_mode', enabled: false },
  ]);
  h.ui.setReciteMode('taraweeh');
  assert.deepEqual(h.messages.slice(3), [
    { type: 'set_restrict_surah', surah: 0 },
    { type: 'set_practice_mode', enabled: false },
    { type: 'set_taraweeh_mode', enabled: true },
  ]);
  assert.equal(h.ui.rakatHdr(), 'Rakat 1');
});

test('combined status envelope updates the compact count and diagnostics export preserves SDK metrics', async () => {
  const h = harness();
  h.ui.setMetrics({ getTextWidth, pxTruncate });
  h.ui.setMode('taraweeh');
  h.ui.handleServerMsg({ type: 'sys_status', statusType: 'taraweeh_mode',
    prayer: { rakat: 4, position: 'QIYAM' } });
  assert.equal(h.nodes.get('rakatCount').textContent, "Rakat 4");
  h.ui.S.settings = { groqApiKey: 'test-secret-credential', keyMode: 'byok' };
  const pending = h.ui._buildTraceReport();
  assert.deepEqual(h.messages.at(-1), { type: 'get_trace' });
  h.ui.handleServerMsg({ type: 'trace_report', report: { v: 1,
    events: [{ type: 'asr', text: 'يس' }, { type: 'lock', at: '36:1' }] } });
  const report = await pending;
  assert.equal(report.app.prayer.rakat, 4);
  assert.equal(report.app.pixelMetrics, true);
  assert.equal(report.app.settings.keyMode, 'byok');
  assert.equal(report.backend.events[1].at, '36:1');
  assert.doesNotMatch(JSON.stringify(report), /test-secret-credential/);
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
    h.ui.setMode('practice');
    h.ui.handleServerMsg({ type: 'state', state: {
      mode: 'LOCKED', surah: 112, ayah: 1, confidence: 0.9,
      arabic: 'قل هو الله أحد', translation: 'Say, He is Allah, One.',
    } });
    await h.flush();
    assert.notEqual(h.ui.buildGlassesText({ mode: 'SEARCHING' }).hdr, title);
    assert.equal([...h.timeouts.values()].filter((t) => t.ms === 1500).length, 0);
  });
}

test('Bismillah notice takes priority over a stale Arabic candidate', async () => {
  const h = harness();
  h.ui.S.settings.arabicImage = true;
  h.ui.S._lastGlassesState = {mode:'SEARCHING',isCandidate:true,surah:1,ayah:1,arabic:'بسم الله',translation:'In the name of Allah'};
  h.ui.handleServerMsg({type:'match_progress',preamble:'bismillah'});
  await h.flush();
  assert.equal(h.ui.buildGlassesText(h.ui.S._lastGlassesState).hdr,'Bismillah');
  assert.equal(h.writes.at(-1).page.textObject.find(c=>c.containerID===1).content,'Bismillah');
});

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

test('old posture messages update only the counter and preserve the verse',async()=>{
 const h=harness();h.ui.setMode("taraweeh");h.ui.S.displayRebuilt=true;
 h.ui._applyPrayerSnapshot({position:'RUKU',rakat:3});await h.flush();
 assert.equal(h.ui.rakatHdr(),'Rakat 3');
 assert.ok(h.writes.every(w=>!w.data || w.data.containerName!=='body'));
});
test('stop clears timers and stale verse; late state cannot repaint glasses',async()=>{
 const h=harness();h.ui.S.bridge.audioControl=async()=>{};
 h.ui.startPageFlip({hdr:'An-Nas 114:1',pages:['Old verse']},60000);await h.flush();
 h.ui.stopListening();await h.flush();
 const stop=h.writes.filter(w=>w.page).at(-1);
 assert.match(stop.page.textObject.find(c=>c.containerName==='body').content,/Translate[\s\S]*Practice[\s\S]*Read Quran[\s\S]*Taraweeh/);
 const count=h.writes.length;
 h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:114,ayah:1,translation:'late verse'}});await h.flush();
 assert.equal(h.writes.length,count);assert.equal(h.ui.S.isRecording,false);
});

test('mode launcher fits four images and one full-screen gesture target inside G2 limits',()=>{
 const page=modeHomePage({menuItems:[]});
 assert.equal(validateEvenHubPageContainer(page).valid,true);
 assert.equal(page.imageObject.length,4);
 assert.equal(page.textObject[0].isEventCapture,1);
 assert.equal(page.textObject[0].height,288);
 assert.deepEqual(HOME_MODES.map(m=>m.key),['listen','practice','reader','taraweeh','audio','settings']);
});

test('glasses ayah picker bounds swipes and ten-ayah jumps; omitted click type selects the ayah',async()=>{
 const h=harness();h.ui.setReaderPicker('ayah',286,286);
 assert.equal(validateEvenHubPageContainer(modeHomePage(h.ui.glassesMenu())).valid,true);
 assert.deepEqual(Array.from(h.ui.glassesMenu().menuItems.slice(0,4),i=>i.itemID),[13,17,18,19]);
 h.ui.onG2Event({textEvent:{eventType:2}});assert.equal(h.ui.getReaderPicker().value,286);
 h.ui.onG2Event({menuItemClickEvent:{itemID:19}});assert.equal(h.ui.getReaderPicker().value,276);
 h.ui.onG2Event({textEvent:{eventType:1}});assert.equal(h.ui.getReaderPicker().value,275);
 let selected=0;h.context.jumpReaderAyah=ayah=>{selected=ayah;};
 h.ui.onG2Event({textEvent:{}});assert.equal(selected,275);
 h.ui.setReaderPicker('ayah',1,7);h.ui.onG2Event({textEvent:{eventType:1}});assert.equal(h.ui.getReaderPicker().value,1);
 h.ui.onG2Event({menuItemClickEvent:{itemID:18}});assert.equal(h.ui.getReaderPicker().value,7);
 h.ui.onG2Event({menuItemClickEvent:{itemID:20}});assert.equal(selected,7);
 h.ui.S.settings.readerBookmark={surah:2,ayah:1};h.ui.setReaderPicker(false,1,7);
 assert.equal(h.ui.glassesMenu().menuItems.length,9);
 assert.ok(h.ui.glassesMenu().menuItems.some(item=>item.itemID===21&&item.itemName==='Show translation'));
 assert.equal(validateEvenHubPageContainer(modeHomePage(h.ui.glassesMenu())).valid,true);
 await h.flush();
});

test('idle swipes select a mode without verse navigation; tapping Read Quran opens the reader',async()=>{
 const h=harness();h.ui.S.isRecording=false;h.ui.showModeHome();await h.flush();
 let opened=0;h.context.openQuranReader=async()=>{opened++;};
 h.ui.onG2Event({textEvent:{eventType:2}});assert.equal(h.ui.getHome().index,1);
 await new Promise(resolve=>setTimeout(resolve,190));
 h.ui.onG2Event({textEvent:{eventType:2}});assert.equal(h.ui.getHome().index,2);
 h.ui.onG2Event({textEvent:{eventType:0}});await h.flush();
 assert.equal(opened,1);assert.equal(h.ui.getHome().active,false);
 assert.ok(h.messages.every(m=>m.type!=='manual_advance'));
});
test('rejected text upgrade rebuilds a visible complete frame',async()=>{
 const h=harness();h.ui.S.displayRebuilt=true;
 h.ui.S.bridge.textContainerUpgrade=async()=>false;
 await h.ui._writeGlasses({hdr:'An-Nas',body:'Visible translation'});
 assert.equal(h.writes.at(-1).type,'rebuild');
 assert.equal(h.writes.at(-1).page.textObject.find(c=>c.containerName==='body').content,'Visible translation');
});

test('switching an installed language repaints the same verse on glasses',async()=>{
 const h=harness();const pack=text=>Array.from({length:114},()=>[text]);
 h.ui.setPack('fr',pack('French text'));h.ui.setPack('uzc',pack('Мен инсонларнинг Парвардигоридан'));
 h.ui.S.settings.lang='fr';
 h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:114,ayah:1,translation:'English',translationLang:'en',timerMs:60000}});await h.flush();
 h.context.document.getElementById('settingLang').value='uz';h.context.onTranslationLangChange();await h.flush();
 const frame=h.writes.filter(w=>w.page).at(-1).page;
 assert.match(frame.textObject.find(c=>c.containerName==='body').content,/Men insonlarning/);
});

test('glasses content option includes or hides pronunciation and repaints immediately',async()=>{
 const h=harness();h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:114,ayah:1,translation:'Selected translation',transliteration:'Qul audhu birabbin nas',timerMs:60000}});await h.flush();
 h.context.setGlassesBottom('translation-only');await h.flush();
 let frame=h.writes.filter(w=>w.page).at(-1).page;
 assert.doesNotMatch(frame.textObject.find(c=>c.containerName==='body').content,/Qul audhu/);
 h.context.setGlassesBottom('transliteration');await h.flush();
 frame=h.writes.filter(w=>w.page).at(-1).page;
 assert.match(frame.textObject.find(c=>c.containerName==='body').content,/Qul audhu/);
});
test('long translation and pronunciation retain all text across bounded glasses pages',()=>{
 const h=harness();h.ui.setMetrics({getTextWidth,pxTruncate});h.ui.S.settings.glassesBottom='transliteration';
 const translation=Array.from({length:120},()=> 'translation').join(' ');
 const pronunciation=Array.from({length:160},()=> 'pronunciation').join(' ');
 const pages=h.ui.buildPages(translation,pronunciation);
 assert.ok(pages.length>2);assert.ok(pages.every(p=>p.split('\n').length<=h.ui.G2_BODY_LINES));
 assert.equal((pages.join(' ').match(/pronunciation/g)||[]).length,160);
 h.ui.S.settings.glassesBottom='translation-only';assert.doesNotMatch(h.ui.buildPages(translation,pronunciation).join(' '),/pronunciation/);
});

test('hold keeps both displays stable while recognition advances; resume catches up', async () => {
  const h = harness();
  const verse = { mode:'LOCKED', surah:114, ayah:1, arabic:'Quran text', translation:'First verse', timerMs:60000 };
  h.ui.handleServerMsg({type:'state',state:verse}); await h.flush();
  h.context.toggleVerseHold(); await h.flush();
  const count = h.writes.length;
  h.ui.handleServerMsg({type:'state',state:{...verse,ayah:2,translation:'Latest verse'}}); await h.flush();
  assert.equal(h.writes.length, count);
  assert.equal(h.nodes.get('holdVerseBtn').textContent, 'Resume verse');
  assert.ok(h.messages.every(msg => msg.type !== 'stop'));
  h.context.toggleVerseHold(); await h.flush();
  const frame = h.writes.filter(w => w.page).at(-1).page;
  assert.equal(frame.textObject.find(c => c.containerName === 'body').content, 'Latest verse');
  assert.equal(h.nodes.get('holdVerseBtn').textContent, 'Hold verse');
});

test('held glasses paginate without sending an ayah navigation command', async () => {
  const h = harness();
  h.ui.setMetrics({getTextWidth,pxTruncate});
  h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:2,ayah:1,arabic:'Quran text',translation:Array(160).fill('translation').join(' '),timerMs:60000}});
  await h.flush(); h.context.toggleVerseHold(); await h.flush();
  const messages = h.messages.length;
  h.ui.onG2Event({textEvent:{eventType:2}}); await h.flush();
  assert.equal(h.messages.length, messages);
  const frame = h.writes.filter(w => w.type === 'text').at(-2);
  assert.match(frame.data.content, /Held.*2\//);
  h.context.setDimSecondary(false); await h.flush();
  const repaint=h.writes.filter(w=>w.page).at(-1).page;
  assert.match(repaint.textObject.find(c=>c.containerName==='hdr').content,/Held.*2\//);
});

test('secondary brightness preserves bright translation and dims pronunciation separately', async () => {
  const h = harness();
  h.ui.S.settings.dimSecondary = true;
  h.ui.S.settings.glassesBottom = 'transliteration';
  const body = h.ui.buildPages('Bright translation', 'Dim pronunciation')[0];
  await h.ui._writeGlasses({hdr:'An-Nas',body});
  const page = h.writes.at(-1).page;
  assert.equal(validateEvenHubPageContainer(page).valid, true);
  assert.equal(page.textObject.find(c=>c.containerName==='body').textColor,4);
  assert.equal(page.textObject.find(c=>c.containerName==='pronunciation').textColor,2);
  assert.equal(page.textObject.find(c=>c.containerName==='hdr').textColor,2);
  h.ui.S.settings.dimSecondary = false;
  await h.ui._writeGlasses({hdr:'An-Nas',body:'Translation only'});
  assert.equal(h.writes.at(-1).page.textObject.length,4);
});

test('Taraweeh exposes Rakat corrections; other modes hide them and keep reading actions', () => {
  const h = harness();
  h.ui.setMode('taraweeh');
  assert.deepEqual(Array.from(h.ui.glassesMenu().menuItems,item=>item.itemName),['Stop listening','Hold verse','Hide pronunciation','Read Quran','Translate','Practice','Taraweeh','Rakat -','Rakat +']);
  h.ui.setMode('practice');
  assert.equal(h.ui.glassesMenu().menuItems.length,7);
});

test('Arabic image uses four bounded tiles and accepts the SDK string success result', async () => {
  const h = harness();
  const canvasContext = {
    measureText: text => ({width:text.length*12}), fillRect(){}, fillText(){}, drawImage(){},
    getImageData: () => ({data:new Uint8Array(288*112*4)}),
  };
  h.context.document.createElement = () => ({getContext:()=>canvasContext});
  h.context.document.fonts = {load:async()=>[{}]};
  h.ui.S.settings.arabicImage = true;
  h.ui.S.bridge.updateImageRawData = async data => { h.writes.push({type:'image',data});return 'success'; };
  await h.ui._writeGlasses({hdr:'An-Nas',arabicImage:'Arabic verse',imagePage:0});
  const page = h.writes.find(w=>w.page).page;
  assert.equal(validateEvenHubPageContainer(page).valid,true);
  assert.equal(page.imageObject.length,4);
  assert.ok(page.imageObject.every(image=>image.width===288 && image.height===112));
  assert.equal(h.writes.filter(w=>w.type==='image').length,4);
  assert.ok(h.writes.filter(w=>w.type==='image').every(w=>w.data.imageData.length===288*112));
});

test('failed Arabic transfer restores a readable translation instead of a blank image', async () => {
  const h = harness();
  const ctx = {measureText:()=>({width:80}),fillRect(){},fillText(){},drawImage(){},getImageData:()=>({data:new Uint8Array(288*112*4)})};
  h.context.document.createElement=()=>({getContext:()=>ctx});
  h.context.document.fonts={load:async()=>[{}]};
  h.ui.S.settings.arabicImage=true;
  h.ui.S._lastGlassesState={mode:'LOCKED',surah:114,ayah:1,translation:'Readable fallback'};
  h.ui.S.bridge.updateImageRawData=async()=>'invalid';
  await h.ui._writeGlasses({hdr:'An-Nas',arabicImage:'Arabic verse',imagePage:0});
  assert.equal(h.ui.S.settings.arabicImage,false);
  const page=h.writes.filter(w=>w.page).at(-1).page;
  assert.equal(page.imageObject,undefined);
  assert.equal(page.textObject.find(c=>c.containerName==='body').content,'Readable fallback');
});


test('pronunciation-only pages exclude translation and retain every pronunciation word', () => {
  const h=harness();h.ui.S.settings.glassesBottom='pronunciation-only';
  const pages=h.ui.buildPages('Translation must be hidden',Array(160).fill('pronunciation').join(' '));
  assert.doesNotMatch(pages.join(' '),/Translation/);
  assert.equal((pages.join(' ').match(/pronunciation/g)||[]).length,160);
  assert.ok(pages.every(p=>p.split('\n').length<=h.ui.G2_BODY_LINES));
});

test('Arabic above translation paginates both texts without losing words and draws translation below Arabic', async () => {
  const h=harness(),draws=[];
  const ctx={measureText:text=>({width:text.length*12}),fillRect(){},fillText(text,x,y){draws.push({text,x,y});}};
  h.context.document.createElement=()=>({getContext:()=>ctx});h.context.document.fonts={load:async()=>[{}]};
  h.ui.S.settings.glassesLayout='arabic-translation';
  const state={arabic:Array(100).fill('Arabic').join(' '),translation:Array(180).fill('Uzbek').join(' ')};
  const layout=h.ui.arabicLayoutPages(state);assert.ok(layout.count>1);
  for(let page=0;page<layout.count;page++) await h.ui.arabicImageCanvas(state.arabic,page,state.translation);
  assert.equal(draws.filter(d=>d.y<88).map(d=>d.text).join(' '),state.arabic);
  assert.equal(layout.translation.join(' '),state.translation);
  assert.ok(draws.every(d=>d.y<88), 'Only Arabic is rasterized');
  assert.ok(draws.every(d=>d.y<=182));
});


test('combined layout sends Arabic tiles above a native translation container', async () => {
 const h=harness();const ctx={measureText:text=>({width:text.length*12}),fillRect(){},fillText(){},drawImage(){},getImageData:()=>({data:new Uint8Array(288*112*4)})};
 h.context.document.createElement=()=>({getContext:()=>ctx});h.context.document.fonts={load:async()=>[{}]};
 h.ui.S.settings.arabicImage=true;h.ui.S.settings.glassesLayout='arabic-translation';
 h.ui.S.bridge.updateImageRawData=async data=>{h.writes.push({type:'image',data});return 'success';};
 await h.ui._writeGlasses({hdr:'An-Nas',arabicImage:'Arabic verse',imageTranslation:'Native Uzbek translation',imagePage:0});
 const page=h.writes.find(w=>w.page).page;
 assert.equal(validateEvenHubPageContainer(page).valid,true);
 assert.equal(page.imageObject.length,2);
 const translation=page.textObject.find(c=>c.containerName==='body');
 assert.equal(translation.content,'Native Uzbek translation');assert.equal(translation.yPosition,152);
 assert.ok(page.imageObject.every(c=>c.yPosition+c.height<=translation.yPosition));
});


test('manual Next and Back preserve the selected verse on both screens in every mode', async () => {
 for(const mode of ['listen','practice','taraweeh']) {
  const h=harness();h.ui.setMode(mode);
  h.ui.handleServerMsg({type:'state',state:{mode:'SEARCHING'}});await h.flush();
  const staleTicks=Array.from(h.intervals.values()).filter(t=>t.ms===400);
  for(const [action,ayah] of [['manualNextAyah',2],['manualPrevAyah',1]]) {
   h.context[action]();
   const translation='Selected '+mode+' verse '+ayah;
   h.ui.handleServerMsg({type:'state',state:{mode:'SEARCHING',userSearching:true,surah:114,ayah,arabic:'Quran verse',translation}});
   await h.flush();
   for(let tick=0;tick<3;tick++) {for(const timer of staleTicks)timer.fn();await h.flush();}
   const frame=h.writes.filter(w=>w.page).at(-1).page;
   assert.match(frame.textObject.find(c=>c.containerName==='body').content,new RegExp(translation));
   assert.equal(h.nodes.get('verseTrans').textContent,translation);
   assert.equal(Array.from(h.intervals.values()).filter(t=>t.ms===400).length,0);
  }
 }
});


test('mode header has room for one firmware text line without a scrollbar', async () => {
 const h=harness();await h.ui._writeGlasses({hdr:'An-Nas',body:'Translation'});
 const box=h.writes.find(w=>w.page).page.textObject.find(c=>c.containerName==='rak');
 assert.ok(box.height-2*(box.paddingLength+box.borderWidth)>=27);
});


test('Arabic retains source recitation marks and gains its numbered ayah ending once', () => {
 const h=harness();const text='قُلْ ۖ أَعُوذُ';
 const marked=h.ui.quranArabicDisplay({arabic:text,ayah:12});
 assert.equal(marked,text+' \u06dd\u0661\u0662');
 assert.equal(h.ui.quranArabicDisplay({arabic:marked,ayah:12}),marked);
});

test('Arabic above transliteration paginates native pronunciation instead of translation', () => {
 const h=harness();h.context.document.createElement=()=>({getContext:()=>({measureText:t=>({width:t.length*12})})});
 h.ui.S.settings.glassesLayout='arabic-pronunciation';
 const layout=h.ui.arabicLayoutPages({arabic:'Arabic',transliteration:'Qul audhu',translation:'Hidden translation'});
 assert.equal(layout.combined,true);assert.equal(layout.translation.join(' '),'Qul audhu');
});


test('tashkeel preference reaches Arabic image text while keeping the ayah ending', () => {
 const h=harness(),state={arabic:'قُلْ أَعُوذُ',ayah:1};
 h.ui.S.settings.showTashkeel=true;assert.match(h.ui.quranArabicDisplay(state),/\u064f/);
 h.ui.S.settings.showTashkeel=false;const text=h.ui.quranArabicDisplay(state);
 assert.doesNotMatch(text,/[\u064b-\u065f]/);assert.match(text,/\u06dd\u0661/);
});


test('phone text sizing applies to all reading text and bounds invalid preferences', () => {
 const h=harness();h.context.setPhoneTextSize(24);
 assert.equal(h.ui.S.settings.phoneTextSize,24);
 assert.equal(h.nodes.get('verseTrans').style.fontSize,'24px');
 assert.equal(h.nodes.get('verseTranslit').style.fontSize,'24px');
 assert.equal(h.nodes.get('verseArabic').style.fontSize,'48px');
 assert.equal(h.nodes.get('phoneTextSizePreview').style.fontSize,'24px');
 h.context.setPhoneTextSize(1000);assert.equal(h.ui.S.settings.phoneTextSize,28);
 h.context.setPhoneTextSize('invalid');assert.equal(h.ui.S.settings.phoneTextSize,16);
});

test('Listen Quran handles omitted zero sys taps and seek menu commands',()=>{
 const h=harness();let taps=0;const seeks=[];
 h.ui.setAudioControls({toggle(){taps++;},seekBy(ms){seeks.push(ms);}});
 h.ui.onG2Event({sysEvent:{eventSource:1}});
 h.ui.onG2Event({textEvent:{eventType:0}});
 assert.equal(taps,2);
 h.ui.onG2Event({sysEvent:{eventType:4}});h.ui.onG2Event({sysEvent:{eventType:5}});assert.equal(taps,2);
 h.ui.onG2Event({menuItemClickEvent:{itemID:36}});h.ui.onG2Event({menuItemClickEvent:{itemID:37}});assert.deepEqual(seeks,[-10000,10000]);
});
