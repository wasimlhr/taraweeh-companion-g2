import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getAdvW, getTextWidth, pxTruncate } from '@evenrealities/pretext';
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk';
import { HOME_MODES, modeHomePage } from '../app/glassesHome.js';
import * as typography from '../app/glassesTypography.js';
import * as readerPagination from '../app/readerPagination.js';
import * as readerArtwork from '../app/readerArtwork.js';
import { readerChapter } from '../backend/quranReader.js';

const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the shipped frontend with a fake bridge, DOM, and clock. Do not start its
// DOMContentLoaded bootstrap, network requests, microphone, or real timers.
function harness() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, dataset: {}, options: [], children: [], selectedIndex: 0, textContent: '', innerHTML: '', value: '',
      attributes:{},classList: { values:new Set(),add(...names){names.forEach(n=>this.values.add(n));},remove(...names){names.forEach(n=>this.values.delete(n));},contains(name){return this.values.has(name);},toggle(name,on){on=on===undefined?!this.values.has(name):on;if(on)this.values.add(name);else this.values.delete(name);return on;} },
      addEventListener() {}, setAttribute(name,value) {this.attributes[name]=String(value);},getAttribute(name){return this.attributes[name];}, appendChild(child) {this.children.push(child);}, replaceChildren() {this.children=[];},
      querySelector(selector) { return node(id + selector); },
      querySelectorAll() { return []; },
    });
    return nodes.get(id);
  }
  const timeouts = new Map(), intervals = new Map();
  let timerID = 0;
  const writes = [], messages = [];
  const context = vm.createContext({
    modeHomeNative:modeHomePage,typography,readerPagination,
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
    _homeModule={modeHomePage:modeHomeNative};_typographyModule=typography;
    window.testUI = { S, onG2Event, handleServerMsg, glassesStartup,
      drawFontTest,updatePhoneUI,setFontTest:(active,controls)=>{_fontTestActive=active;_fontTestUI=controls;},
      setAudioControls: controls=>{_audioMode=true;_audioUI=controls;},
      setListenPages:(pages,page,state)=>{_readerModule=readerPagination;_readerPages=pages;_readerPage=page;_audioVisual=state;},
      prepareReader:(data,pages,page,artwork)=>{_readerActive=true;_readerData=data;_readerModule=readerPagination;_readerPages=pages;_readerPage=page;_readerArtworkModule=artwork;_readerAutoEnabled=true;},
      renderReaderPage,readerBookmarkMatches,
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
      sttPayload,migrateModelDefaults,syncMicSourceUI,openGlassesSettings,
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

test('reader renderer removes the opening title, retains the frame and rearms auto-scroll', async () => {
 const h=harness(),draws=[],borders=[];
 const ctx=new Proxy({measureText:t=>({width:t.length*10}),fillText(text,x,y){draws.push({text,x,y});},strokeRect(...args){borders.push(args);},getImageData:()=>({data:new Uint8Array(288*144*4)})},{get:(target,key)=>key in target?target[key]:()=>{}});
 h.context.document.createElement=()=>({getContext:()=>ctx});
 h.context.document.getElementById('readerPaper').style.setProperty=()=>{};
 h.ui.S.bridge.updateImageRawData=async()=> 'success';
 Object.assign(h.ui.S.settings,{readerLayout:'single',readerScript:'indopak'});
 const chapter=readerChapter(1),pages=readerPagination.readerReadingPages(chapter.verses,t=>t.length*10,t=>t.length*10,{layout:'single',showTranslation:false,numberedBasmala:true});
 h.ui.prepareReader(chapter,pages,0,readerArtwork);
 await h.ui.renderReaderPage();await h.flush();
 assert.ok(draws.some(d=>d.text.startsWith('سورة ')));
 assert.ok(draws.some(d=>d.x===288&&d.y===typography.arabicMetrics().headerY),'numbered Bismillah stays centered');
 assert.equal([...h.intervals.values()].filter(t=>t.ms===250).length,1);
 draws.length=0;borders.length=0;
 h.ui.prepareReader(chapter,pages,1,readerArtwork);
 await h.ui.renderReaderPage();await h.flush();
 assert.ok(!draws.some(d=>d.text.startsWith('سورة ')));
 assert.ok(draws.some(d=>d.y===typography.arabicMetrics().compactY),'text moves into reclaimed space');
 assert.equal(borders.length,2,'both manuscript border rectangles remain');
 assert.equal([...h.intervals.values()].filter(t=>t.ms===250).length,1,'exactly one auto-scroll timer stays active');
 h.ui.S.settings.readerBookmark={surah:1,ayah:pages[1].ayahs[0],page:99,layout:'single',script:'indopak',pagination:3};
 assert.equal(h.ui.readerBookmarkMatches(),true,'old bookmarks match by ayah after repagination');
});

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

test('a Listen Quran phone group retains its selected translations when live-mode language differs',()=>{
 const h=harness();h.ui.S.settings.lang='fr';h.ui.setPack('fr',Array.from({length:114},()=>Array(7).fill('French live-mode verse')));
 const state={mode:'LOCKED',surah:1,ayah:6,arabic:'grouped Arabic',translation:'6. Guide us\n\n7. The path',numbered:false,isListeningGroup:true};
 h.ui.updatePhoneUI(state,'');assert.equal(h.nodes.get('verseTrans').textContent,state.translation);
 h.ui.updatePhoneUI({...state,isListeningGroup:false},'');assert.equal(h.nodes.get('verseTrans').textContent,'French live-mode verse');
});

test('OpenAI defaults and old Mini settings migrate to Whisper once without changing Groq',()=>{
 const h=harness();
 h.ui.S.settings=h.ui.migrateModelDefaults({transcriptionProvider:'groq',transcriptionModel:'whisper-large-v3',modelByProvider:{groq:'whisper-large-v3',openai:'gpt-4o-mini-transcribe'}});
 h.context.setProvider('openai',false);assert.equal(h.ui.sttPayload().transcriptionModel,'whisper-1');
 assert.match(h.nodes.get('settingTranscribeModel').innerHTML,/whisper-1 \(default\)/);
 h.context.setProvider('groq',false);assert.equal(h.ui.sttPayload().transcriptionModel,'whisper-large-v3');
 const oldActive=h.ui.migrateModelDefaults({transcriptionProvider:'openai',transcriptionModel:'gpt-4o-mini-transcribe',modelByProvider:{openai:'gpt-4o-mini-transcribe'}});
 assert.equal(oldActive.transcriptionModel,'whisper-1');assert.equal(oldActive.modelByProvider.openai,'whisper-1');
 h.ui.S.settings=h.ui.migrateModelDefaults({transcriptionProvider:'openai',transcriptionModel:'',modelByProvider:{}});
 h.context.setProvider('openai',false);assert.equal(h.ui.sttPayload().transcriptionModel,'whisper-1');
 // A deliberate alternative remains available after the one-time migration.
 h.context.setTranscribeModel('gpt-4o-mini-transcribe');
 h.ui.S.settings=h.ui.migrateModelDefaults(JSON.parse(JSON.stringify(h.ui.S.settings)));
 h.context.setProvider('openai',false);assert.equal(h.ui.sttPayload().transcriptionModel,'gpt-4o-mini-transcribe');
 const other=h.ui.migrateModelDefaults({transcriptionProvider:'openai',transcriptionModel:'gpt-4o-transcribe',modelByProvider:{openai:'gpt-4o-transcribe'}});
 assert.equal(other.transcriptionModel,'gpt-4o-transcribe');assert.equal(other.modelByProvider.openai,'gpt-4o-transcribe');
});

function microphoneHarness(){
 const h=harness(),calls=[],streams=[];h.context.navigator.userAgent='Android';
 h.ui.S.bridge.audioControl=async open=>{calls.push(open?'glasses-open':'glasses-close');return true;};
 const stream=()=>{const track={stopped:false,stop(){this.stopped=true;calls.push('phone-track-stop');}};const value={track,getTracks:()=>[track]};streams.push(value);return value;};
 h.context.navigator.mediaDevices={getUserMedia:async options=>{calls.push(options.audio===true?'phone-permission':'phone-capture');return stream();}};
 h.context.AudioContext=class{sampleRate=16000;state='running';destination={};createMediaStreamSource(){return {connect(){}};}createScriptProcessor(){return {connect(){},disconnect(){}};}createGain(){return {gain:{value:0},connect(){}};}close(){calls.push('phone-context-close');return Promise.resolve();}};
 return {...h,calls,streams,stream};
}

test('home and settings microphone controls persist one selection immediately without opening capture',async()=>{
 const h=microphoneHarness();h.ui.S.isRecording=false;h.ui.syncMicSourceUI();
 assert.equal(h.nodes.get('homeMicLabel').textContent,'Glasses mic');
 await h.context.toggleMicSource();assert.equal(h.ui.S.settings.forcePhoneMic,true);assert.equal(h.nodes.get('homeMicLabel').textContent,'Phone mic');assert.equal(h.nodes.get('btnPhoneMic').getAttribute('aria-pressed'),'true');assert.equal(h.nodes.get('recordBtn').textContent,'Start Listening');
 assert.equal(h.messages.at(-1).source,'browser');assert.deepEqual(h.calls,[]);
 await h.context.setMicSource('g2');assert.equal(h.ui.S.settings.forcePhoneMic,false);assert.equal(h.nodes.get('homeMicLabel').textContent,'Glasses mic');assert.equal(h.messages.at(-1).source,'g2');assert.deepEqual(h.calls,[]);
});

test('active microphone handoff stops the old capture and preserves the existing recognition session',async()=>{
 const h=microphoneHarness();h.ui.S.pcmAccum=[1,2,3];
 await h.context.setMicSource('phone');assert.equal(h.ui.S.isRecording,true);assert.equal(h.calls[0],'glasses-close');assert.equal(h.streams.at(-1).track.stopped,false);assert.equal(h.ui.S.pcmAccum.length,0);
 const split=h.calls.length;await h.context.setMicSource('g2');
 assert.ok(h.calls.indexOf('phone-track-stop',split)<h.calls.indexOf('glasses-open',split));assert.ok(h.streams.every(s=>s.track.stopped));assert.equal(h.calls.at(-1),'glasses-open');assert.equal(h.ui.S.isRecording,true);
 assert.ok(h.messages.every(m=>m.type==='set_audio_source'),'A source handoff must not reset the pipeline or restart the prayer');
});

test('stopping during phone permission or capture acquisition cannot reopen a late microphone stream',async()=>{
 for(const lateCapture of [false,true]){
  const h=microphoneHarness();let release,requests=0;
  h.context.navigator.mediaDevices.getUserMedia=()=>{requests++;if(lateCapture&&requests===1)return Promise.resolve(h.stream());return new Promise(r=>release=r);};
  const switching=h.context.setMicSource('phone');for(let n=0;n<30&&!release;n++)await Promise.resolve();assert.ok(release);
  h.ui.stopListening();const stream=h.stream();release(stream);await switching;await h.flush();
  assert.equal(stream.track.stopped,true);assert.equal(h.ui.S.mediaStream,null);assert.equal(h.ui.S.isRecording,false);assert.equal(h.nodes.get('homeMicToggle').getAttribute('aria-busy'),'false');
 }
});

test('microphone permission denial and rejected bridge requests leave capture stopped with a visible error',async()=>{
 const phone=microphoneHarness();phone.context.navigator.mediaDevices.getUserMedia=async()=>{throw Error('Permission denied');};
 assert.equal(await phone.context.setMicSource('phone'),false);assert.equal(phone.ui.S.isRecording,false);assert.match(phone.nodes.get('status').textContent,/Phone microphone unavailable/);
 const glasses=microphoneHarness();glasses.ui.S.settings.forcePhoneMic=true;glasses.ui.S.bridge.audioControl=async()=>false;
 assert.equal(await glasses.context.setMicSource('g2'),false);assert.equal(glasses.ui.S.isRecording,false);assert.match(glasses.nodes.get('status').textContent,/Glasses microphone unavailable/);
});

test('glasses Settings puts microphone first and toggles the shared source; disconnected glasses stay unavailable',async()=>{
 const h=microphoneHarness();h.ui.S.isRecording=false;h.ui.openGlassesSettings();await h.flush();
 assert.match(h.writes.at(-1).page.textObject[0].content,/> Microphone: Glasses/);h.ui.onG2Event({textEvent:{eventType:0}});await h.flush();
 assert.equal(h.ui.S.settings.forcePhoneMic,true);assert.match(h.writes.at(-1).page.textObject[0].content,/> Microphone: Phone/);assert.equal(h.nodes.get('homeMicLabel').textContent,'Phone mic');assert.deepEqual(h.calls,[]);
 const web=microphoneHarness();web.ui.S.isG2=false;web.ui.S.isRecording=false;web.ui.syncMicSourceUI();assert.equal(web.nodes.get('homeMicToggle').disabled,true);assert.equal(web.nodes.get('btnG2Mic').disabled,true);assert.equal(web.nodes.get('homeMicLabel').textContent,'Phone mic');assert.equal(await web.context.setMicSource('g2'),false);
});

test('glasses PCM is ignored for phone input and still reaches capture while the glasses settings menu is open',()=>{
 const h=microphoneHarness();h.ui.S.lastSend=Date.now();h.ui.S.settings.forcePhoneMic=true;h.ui.S.pcmAccum=[];
 h.ui.onG2Event({audioEvent:{audioPcm:new Uint8Array([1,0,2,0])}});assert.equal(h.ui.S.pcmAccum.length,0);
 h.ui.S.settings.forcePhoneMic=false;h.ui.openGlassesSettings();h.ui.onG2Event({audioEvent:{audioPcm:new Uint8Array([1,0,2,0])}});assert.equal(h.ui.S.pcmAccum.length,2);
});

test('provider settings preserve each model and send the selected provider/model pair',()=>{
 const h=harness();Object.assign(h.ui.S.settings,{keyMode:'byok',transcriptionProvider:'groq',transcriptionModel:'whisper-large-v3',modelByProvider:{}});
 h.context.setProvider('groq',false);
 assert.equal(h.ui.S.settings.transcriptionModel,'whisper-large-v3','Opening settings preserves the active model even without older per-provider memory');
 assert.equal(h.nodes.get('settingTranscribeProvider').value,'groq');
 assert.match(h.nodes.get('recognitionSummary').textContent,/Groq/);
 assert.match(h.nodes.get('sPillModel').title,/Groq.*whisper-large-v3/);
 h.context.setProvider('openai');h.context.setTranscribeModel('whisper-1');
 assert.equal(h.nodes.get('settingTranscribeModel').value,'whisper-1');
 h.context.setProvider('groq');assert.equal(h.ui.S.settings.transcriptionModel,'whisper-large-v3');
 h.context.setProvider('openai');assert.equal(h.ui.S.settings.transcriptionModel,'whisper-1');
 assert.equal(h.nodes.get('groqKeyRow').style.display,'none');assert.equal(h.nodes.get('openaiKeyRow').style.display,'');
 for(const timer of [...h.timeouts.values()].filter(t=>t.ms===300))timer.fn();
 const init=h.messages.filter(m=>m.type==='init').at(-1);
 assert.equal(init.transcriptionProvider,'openai');assert.equal(init.transcriptionModel,'whisper-1');
 assert.equal(h.ui.sttPayload().transcriptionProvider,'openai');
 assert.equal(h.ui.sttPayload().transcriptionModel,'whisper-1');
});

test('provider status distinguishes connecting selection from the backend ready provider',()=>{
 const h=harness();h.ui.S.settings.transcriptionProvider='openai';
 h.ui.handleServerMsg({type:'connected'});
 assert.equal(h.nodes.get('sPillModel.s-label').textContent,'Connecting · OpenAI');
 h.ui.handleServerMsg({type:'sys_status',component:'model',status:'ready',provider:'openai'});
 assert.equal(h.nodes.get('sPillModel.s-label').textContent,'Ready · OpenAI');
 h.ui.handleServerMsg({type:'sys_status',component:'model',status:'ready',provider:'groq'});
 assert.equal(h.nodes.get('sPillModel.s-label').textContent,'Ready · Groq');
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
 assert.match(stop.page.textObject.find(c=>c.containerName==='homeInput').content,/Translate[\s\S]*Practice[\s\S]*Read Quran[\s\S]*Taraweeh/);
 const count=h.writes.length;
 h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:114,ayah:1,translation:'late verse'}});await h.flush();
 assert.equal(h.writes.length,count);assert.equal(h.ui.S.isRecording,false);
});

test('mode launcher uses four non-overlapping native regions with two on the right',()=>{
 for(let selected=0;selected<HOME_MODES.length;selected++){
 const page=modeHomePage({menuItems:[]},selected);
 assert.equal(validateEvenHubPageContainer(page).valid,true);
 assert.equal(page.imageObject,undefined);assert.equal(page.containerTotalNum,4);
 assert.equal(page.textObject.filter(c=>c.isEventCapture===1).length,1);
 assert.match(page.textObject[0].content,new RegExp('> '+HOME_MODES[selected].label));
 const right=page.textObject.filter(c=>c.xPosition>=288);assert.equal(right.length,2);
 assert.ok(right[0].content.startsWith(HOME_MODES[selected].label));
 assert.ok(right[0].yPosition+right[0].height<=right[1].yPosition);
 for(const c of page.textObject){
  assert.ok(c.xPosition+c.width<=576&&c.yPosition+c.height<=288);
  for(const line of c.content.split('\n'))assert.ok(getTextWidth(line)<=c.width,`Clipped line: ${line}`);
  assert.ok(c.content.split('\n').length*28<=c.height,'no firmware overflow scrolling');
  for(const other of page.textObject.filter(o=>o!==c))assert.ok(c.xPosition+c.width<=other.xPosition||other.xPosition+other.width<=c.xPosition||c.yPosition+c.height<=other.yPosition||other.yPosition+other.height<=c.yPosition);
 }
 }
 assert.deepEqual(HOME_MODES.map(m=>m.key),['listen','practice','reader','taraweeh','audio','settings']);
});

test('native mode menu selection and reader pickers transfer no images',async()=>{
 const h=harness();h.ui.S.isRecording=false;let images=0;h.ui.S.bridge.updateImageRawData=async()=>images++;
 h.ui.showModeHome();await h.flush();const builds=h.writes.filter(w=>w.type==='rebuild').length;
 h.ui.onG2Event({textEvent:{eventType:2}});await h.flush();assert.equal(images,0);assert.equal(h.writes.filter(w=>w.type==='rebuild').length,builds);
 const updates=h.writes.filter(w=>w.type==='text');assert.deepEqual(updates.map(w=>w.data.containerName),['homeInput','homeDetail']);
 assert.match(updates[0].data.content,/> Practice/);assert.match(updates[1].data.content,/Practice[\s\S]*Holds the verse/);
 h.ui.leaveModeHome();h.ui.setReaderPicker('ayah',12,286);h.ui.onG2Event({textEvent:{eventType:2}});await h.flush();assert.equal(images,0);const picker=h.writes.at(-1).page;assert.equal(picker.imageObject,undefined);assert.match(picker.textObject[0].content,/> 13/);
 h.ui.onG2Event({textEvent:{eventType:2}});await h.flush();assert.equal(images,0);assert.equal(h.writes.at(-1).type,'text');assert.match(h.writes.at(-1).data.content,/> 14/);
});

test('startup opens the native mode menu directly without an intermediate ready screen',async()=>{
 const h=harness();h.ui.S.isRecording=false;h.ui.glassesStartup();await h.flush();
 const pages=h.writes.filter(w=>w.page);assert.equal(pages.length,1);assert.equal(pages[0].page.containerTotalNum,4);assert.match(pages[0].page.textObject.find(c=>c.containerName==='homeTitle').content,/Choose mode/);
 assert.equal(h.ui.getHome().active,true);
});

test('launcher restores all four regions after a rejected text update',async()=>{
 const h=harness();h.ui.S.isRecording=false;h.ui.showModeHome();await h.flush();
 h.ui.S.bridge.textContainerUpgrade=async()=>false;
 h.ui.onG2Event({textEvent:{eventType:2}});await h.flush();
 const page=h.writes.filter(w=>w.page).at(-1).page;
 assert.equal(page.containerTotalNum,4);assert.match(page.textObject[0].content,/> Practice/);
 assert.match(page.textObject.find(c=>c.containerName==='homeDetail').content,/Practice/);
 assert.equal(validateEvenHubPageContainer(page).valid,true);
});

test('reciter pace cycles labels while keeping one fixed-width phone control',()=>{
 const h=harness(),labels=[];
 for(let i=0;i<3;i++){h.context.cyclePaceMode();labels.push(h.nodes.get('homePaceModeBtn').textContent);}
 assert.deepEqual(labels,['Fast reciter ↔','Slow reciter ↔','Normal reciter ↔']);
 const rule=html.match(/#homePaceModeBtn\s*\{([^}]+)\}/)[1];
 assert.match(rule,/flex:0 0 132px/);assert.match(rule,/width:132px/);assert.match(rule,/white-space:nowrap/);
});

test('double-tap keeps reader, audio and live recitation modes open; only launcher requests system exit',async()=>{
 for(const mode of ['listen','practice','taraweeh']){
  const h=harness();let exits=0;h.ui.S.bridge.shutDownPageContainer=async()=>exits++;h.ui.setMode(mode);h.ui.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:114,ayah:1,arabic:'قل اعوذ برب الناس',translation:'Say, I seek refuge',timerMs:60000}});await h.flush();
  h.ui.onG2Event({textEvent:{eventType:3}});await h.flush();assert.equal(h.ui.S.isRecording,true);assert.equal(h.ui.getHome().active,false);assert.equal(exits,0);assert.ok(!h.messages.some(m=>m.type==='stop'));
 }
 const audio=harness();let toggles=0;audio.ui.setAudioControls({toggle(){toggles++;}});audio.ui.onG2Event({textEvent:{eventType:3}});audio.ui.onG2Event({textEvent:{eventType:3}});assert.equal(toggles,1,'Duplicate double-taps are swallowed in audio mode');
 const reader=harness();reader.ui.setReaderPicker(false,1,7);let steps=0;reader.context.readerStep=()=>steps++;reader.ui.onG2Event({textEvent:{eventType:3}});assert.equal(steps,1);
 const root=harness();root.ui.S.isRecording=false;let exits=0;root.ui.S.bridge.shutDownPageContainer=async()=>exits++;root.ui.showModeHome();await root.flush();root.ui.onG2Event({textEvent:{eventType:3}});await root.flush();assert.equal(exits,1);
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
 assert.ok(h.ui.glassesMenu().menuItems.some(item=>item.itemID===21&&item.itemName==='Hide translation'));
 assert.equal(validateEvenHubPageContainer(modeHomePage(h.ui.glassesMenu())).valid,true);
 await h.flush();
});

test('Read Quran menu exposes both layouts and its translation toggle stays independent',()=>{
 const h=harness();h.ui.setReaderPicker(false,1,7);h.ui.S.settings.readerLayout='maximum';
 const menu=h.ui.glassesMenu();assert.ok(menu.menuItems.some(m=>m.itemID===22&&m.itemName==='Single verse'));assert.ok(menu.menuItems.some(m=>m.itemID===23&&m.itemName==='Fit multiple verses (selected)'));
 assert.equal(validateEvenHubPageContainer(modeHomePage(menu)).valid,true);
 const layouts=[];h.context.setReaderLayout=value=>layouts.push(value);
 h.ui.onG2Event({menuItemClickEvent:{itemID:22}});h.ui.onG2Event({menuItemClickEvent:{itemID:23}});assert.deepEqual(layouts,['single','maximum']);
 h.ui.S.settings.readerGlassesTranslation=false;assert.equal(h.ui.glassesMenu().menuItems.find(m=>m.itemID===21).itemName,'Show translation');
 h.ui.S.settings.readerGlassesTranslation=true;assert.equal(h.ui.glassesMenu().menuItems.find(m=>m.itemID===21).itemName,'Hide translation');
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

// Synthetic pixels distinguish changed Arabic from unchanged tiles, while the
// production renderer, timer callbacks and serialized bridge queue run normally.
function liveArabicHarness() {
 const h=harness(),create=h.context.document.createElement;
 h.context.document.createElement=tag=>{
  if(tag!=='canvas')return create(tag);
  const canvas={ink:0};
  const ctx={measureText:t=>({width:t.length*12}),fillRect(){canvas.ink=0;},
   fillText(t){for(const c of t)canvas.ink=(canvas.ink+c.codePointAt(0))%251;},
   drawImage(source){canvas.ink=source.ink;},getImageData(){return {data:new Uint8Array(288*112*4).fill(canvas.ink)};}};
  canvas.getContext=()=>ctx;return canvas;
 };
 h.context.document.fonts={load:async()=>[{}]};
 Object.assign(h.ui.S.settings,{arabicImage:true,glassesLayout:'arabic-translation'});
 h.ui.S.bridge.updateImageRawData=async data=>{h.writes.push({type:'image',data});return 'success';};
 return h;
}

test('candidate animation and lock reuse the Arabic page instead of clearing it every 400ms',async()=>{
 const h=liveArabicHarness(),state={mode:'SEARCHING',isCandidate:true,surah:114,ayah:1,arabic:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',translation:'Say, I seek refuge in the Lord of mankind'};
 h.ui.handleServerMsg({type:'state',state});await h.flush();
 const builds=h.writes.filter(w=>w.type==='rebuild').length,images=h.writes.filter(w=>w.type==='image').length;
 assert.equal(builds,1);assert.equal(images,2);
 for(let i=0;i<5;i++){for(const timer of [...h.intervals.values()].filter(t=>t.ms===400))timer.fn();await h.flush();}
 h.ui.handleServerMsg({type:'state',state:{...state,mode:'LOCKED',isCandidate:false}});await h.flush();
 assert.equal(h.writes.filter(w=>w.type==='rebuild').length,builds);
 assert.equal(h.writes.filter(w=>w.type==='image').length,images);
 assert.equal(h.ui.S.settings.arabicImage,true);
});

test('slow Arabic transfers finish both tiles before the latest pending verse without another rebuild',async()=>{
 const h=liveArabicHarness();let release,started;
 const first=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 h.ui.S.bridge.updateImageRawData=async data=>{h.writes.push({type:'image',data});if(h.writes.filter(w=>w.type==='image').length===1){started();await gate;}return 'success';};
 const state={mode:'SEARCHING',isCandidate:true,surah:114,ayah:1,arabic:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',translation:'First candidate'};
 h.ui.handleServerMsg({type:'state',state});await first;
 for(const timer of [...h.intervals.values()].filter(t=>t.ms===400))timer.fn();
 h.ui.handleServerMsg({type:'state',state:{...state,ayah:2,arabic:'مَلِكِ النَّاسِ',translation:'Latest candidate'}});
 release();await h.flush();
 const images=h.writes.filter(w=>w.type==='image');
 assert.deepEqual(images.map(w=>w.data.containerID),[10,11,10,11]);
 assert.equal(images[0].data.imageData[0],images[1].data.imageData[0]);
 assert.notEqual(images[1].data.imageData[0],images[2].data.imageData[0]);
 assert.equal(h.writes.filter(w=>w.type==='rebuild').length,1);
 assert.equal(h.writes.filter(w=>w.type==='text'&&w.data.containerName==='body').at(-1).data.content,'Latest candidate');
});

test('native translation changes retain Arabic tiles and recover a missing text container',async()=>{
 const h=liveArabicHarness(),frame={hdr:'An-Nas',arabicImage:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',imageTranslation:'First translation'};
 await h.ui._writeGlasses(frame);const before=h.writes.length;
 await h.ui._writeGlasses({...frame,imageTranslation:'Updated translation'});
 assert.deepEqual(h.writes.slice(before).map(w=>w.type),['text']);
 assert.equal(h.writes.at(-1).data.content,'Updated translation');
 let reject=true;h.ui.S.bridge.textContainerUpgrade=async data=>{h.writes.push({type:'text',data});if(reject){reject=false;return false;}return true;};
 await h.ui._writeGlasses({...frame,imageTranslation:'Recovered translation'});
 assert.equal(h.writes.filter(w=>w.type==='rebuild').length,2);
 assert.equal(h.writes.filter(w=>w.type==='image').length,4);
 assert.equal(h.writes.filter(w=>w.page).at(-1).page.textObject.find(c=>c.containerName==='body').content,'Recovered translation');
});

test('reused Arabic layout still refreshes contextual controls when the mode changes',async()=>{
 const h=liveArabicHarness(),frame={hdr:'An-Nas',arabicImage:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',imageTranslation:'Translation'};
 await h.ui._writeGlasses(frame);h.ui.setMode('taraweeh');await h.ui._writeGlasses(frame);
 const pages=h.writes.filter(w=>w.page);assert.equal(pages.length,2);
 assert.ok(pages.at(-1).page.menuObject.menuItems.some(item=>item.itemName==='Rakat +'));
});

test('stopping during an Arabic transfer cannot disable Arabic or repaint the new menu',async()=>{
 const h=liveArabicHarness();let release,started;
 const first=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 h.ui.S.bridge.updateImageRawData=async data=>{h.writes.push({type:'image',data});started();await gate;return 'invalid';};
 const write=h.ui._writeGlasses({hdr:'An-Nas',arabicImage:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ'});await first;
 h.ui.stopListening();release();await write;await h.flush();
 assert.equal(h.ui.S.settings.arabicImage,true);
 assert.equal(h.writes.filter(w=>w.type==='image').length,1);
 assert.equal(h.writes.filter(w=>w.page).at(-1).page.textObject[0].containerName,'homeInput');
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

test('Listen Quran swipes move by displayed group while ayah menu commands keep stepping recordings',()=>{
 const h=harness(),selected=[],steps=[];
 h.ui.setAudioControls({selectAyah:(...args)=>selected.push(args),step:d=>steps.push(d)});
 const pages=[{ayahs:[1]},{ayahs:[2,3,4,5]},{ayahs:[6,7,8]},{ayahs:[9]}];
 for(const ayah of [2,3,4,5]){
  h.ui.setListenPages(pages,1,{ayah,canPlay:true});h.ui.onG2Event({textEvent:{eventType:2}});
  assert.deepEqual(selected.at(-1),[6,0]);
 }
 h.ui.setListenPages(pages,2,{ayah:8,canPlay:true});h.ui.onG2Event({listEvent:{eventType:1}});assert.deepEqual(selected.at(-1),[2,0]);
 const count=selected.length;
 h.ui.setListenPages(pages,0,{ayah:1,canPlay:true});h.ui.onG2Event({textEvent:{eventType:1}});
 h.ui.setListenPages(pages,3,{ayah:9,canPlay:true});h.ui.onG2Event({sysEvent:{eventType:2}});assert.equal(selected.length,count);
 h.ui.setListenPages(pages,1,{ayah:2,canPlay:false});h.ui.onG2Event({textEvent:{eventType:2}});assert.equal(selected.length,count);
 h.ui.onG2Event({menuItemClickEvent:{itemID:34}});h.ui.onG2Event({menuItemClickEvent:{itemID:35}});assert.deepEqual(steps,[1,-1]);
 assert.equal(h.writes.length,0,'Navigation uses the existing display path, with no extra container rebuild');
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


test('font test uses an SDK-valid image layout and owns gestures while it is open',async()=>{
 const h=harness(),events=[];h.ui.setFontTest(true,{event:e=>events.push(e)});h.ui.S.bridge.updateImageRawData=async data=>{h.writes.push({type:'image',data});return 'success';};
 const canvas={getContext:()=>({getImageData:()=>({data:new Uint8Array(288*144*4)})})};
 await h.ui.drawFontTest(canvas,typography.ARABIC_FONTS[0],{index:0,glassesArabicSize:32,glassesArabicRendering:'bright'});await h.flush();
 const page=h.writes.find(w=>w.type==='rebuild').page;assert.equal(validateEvenHubPageContainer(page).valid,true);assert.equal(page.imageObject.length,4);assert.equal(h.writes.filter(w=>w.type==='image').length,4);
 h.ui.onG2Event({menuItemClickEvent:{itemID:61}});assert.equal(events.length,1);
 h.ui.setFontTest(false,null);const before=h.writes.length;await h.ui.drawFontTest(canvas,typography.ARABIC_FONTS[1],{index:1,glassesArabicSize:32,glassesArabicRendering:'standard'});assert.equal(h.writes.length,before);
});

test('a rejected font test page reports failure instead of claiming it is showing on glasses',async()=>{
 const h=harness();h.ui.setFontTest(true,null);h.ui.S.bridge.rebuildPageContainer=async()=>false;
 await assert.rejects(h.ui.drawFontTest({},typography.ARABIC_FONTS[0],{index:0,glassesArabicSize:28,glassesArabicRendering:'standard'}),/layout rejected/);
});
