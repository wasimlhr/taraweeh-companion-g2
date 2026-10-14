/** UI acceptance through the real EvenHub simulator. Controlled verse states,
 * not audio-recognition or physical-hardware certification. */
import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { getVerseData } from '../backend/verseData.js';

const out = new URL('../language-evidence/ui-improvements/', import.meta.url);
mkdirSync(out, {recursive:true});
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let next=0, pending=new Map(), paused;
  socket.on('message',data=>{
    const msg=JSON.parse(data);
    if (msg.id) { const p=pending.get(msg.id); pending.delete(msg.id); if(msg.error)p.reject(Error(JSON.stringify(msg.error)));else p.resolve(msg.result); }
    else if(msg.method==='Debugger.paused')paused?.(msg.params);
  });
  return {
    ready:new Promise(resolve=>socket.once('open',resolve)),
    send(method,params={}) {return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});},
    waitPause(){return new Promise(resolve=>{paused=resolve;});}, close(){socket.close();}
  };
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3001/')));
const glasses=connect(targets.find(t=>t.url.includes('glasses.html')));
await Promise.all([phone.ready,glasses.ready]);
async function evaluate(expression) {
  const result=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,350));
async function input(action) {
  const response=await fetch('http://127.0.0.1:9898/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  assert.equal(response.ok,true);await settle();
}
async function selectMenu(index) {
  // The native overlay debounces rapid reopen gestures after dismissal.
  await new Promise(resolve=>setTimeout(resolve,800));
  await input('context_menu');
  for(let i=0;i<index;i++)await input('down');
  await input('click');
}
await phone.send('Page.reload',{ignoreCache:true});
for(let attempt=0;attempt<20;attempt++) {
  await new Promise(resolve=>setTimeout(resolve,500));
  if(await evaluate('typeof window.applyLocalTranslation === "function"'))break;
}
assert.equal(await evaluate('typeof window.applyLocalTranslation'), 'function', 'App must finish loading before inspection');
await new Promise(resolve=>setTimeout(resolve,1200));
await phone.send('Debugger.enable');
const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'});
const bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId});
const paused=phone.waitPause();
const call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'});
const frame=(await paused).callFrames[0];
const injection=await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:
  'window.__uiAudit={S,getReaderWindow:()=>_readerPages[_readerPage],saveSettings,showReaderSplash,loadSettings,handleServerMsg,stopPageFlip,stopCountdown,glassesMenu,onG2Event,ensureLangPack,glassesStartup,ensureArabicFont,arabicImageCanvas,stopListening,buildGlassesText,getHeld:function(){return _readingHeld;},getHeldPage:function(){return _heldPage;}}; __uiAudit.imageResults=[]; __uiAudit.originalImage=S.bridge.updateImageRawData.bind(S.bridge); S.bridge.updateImageRawData=async function(data){var result=await __uiAudit.originalImage(data);__uiAudit.imageResults.push({id:data.containerID,length:data.imageData.length,result:result});return result;};'});
if(injection.exceptionDetails)throw Error(JSON.stringify(injection.exceptionDetails));
await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await phone.send('Debugger.resume'); await call; await phone.send('Debugger.disable');

await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await evaluate('window.__readerOldSettings=JSON.parse(JSON.stringify(__uiAudit.S.settings));window.__readerOldTheme=document.documentElement.getAttribute("data-theme");document.documentElement.setAttribute("data-theme","dark");__uiAudit.S.settings.backendUrl="http://localhost:3001";__uiAudit.S.settings.readerLayout="single";__uiAudit.S.settings.readerSurah=98;__uiAudit.S.settings.readerAyah=1;__uiAudit.S.settings.readerTheme="light";delete __uiAudit.S.settings.readerThemeExplicit;__uiAudit.S.settings.lang="en";window.__readerRebuilds=0;window.__readerRebuildOriginal=__uiAudit.S.bridge.rebuildPageContainer.bind(__uiAudit.S.bridge);__uiAudit.S.bridge.rebuildPageContainer=async data=>{window.__readerRebuilds++;return __readerRebuildOriginal(data)};openQuranReader()');
await settle();assert.equal(await evaluate('document.getElementById("readerView").dataset.readingTheme'),'dark');
assert.equal(await evaluate('document.getElementById("readerTheme").value'),'app');
const images=await evaluate('__uiAudit.imageResults.length');await evaluate('window.scrollBy(0,650)');await new Promise(r=>setTimeout(r,1300));assert.equal(await evaluate('__uiAudit.imageResults.length'),images);
assert.equal(await evaluate('document.getElementById("readerAyah").value'),'1');
const rebuilds=await evaluate('window.__readerRebuilds');
await evaluate('document.querySelector("#reader-ayah-2 .reader-arabic").click()');await evaluate('__uiAudit.S.bridgeCallQueue');await new Promise(r=>setTimeout(r,1000));
assert.deepEqual(await evaluate('__uiAudit.getReaderWindow().ayahs'),[2]);assert.equal(await evaluate('document.getElementById("readerAyah").value'),'2');assert.equal(await evaluate('window.__readerRebuilds'),rebuilds);
async function capture(name){await settle();for(const [kind,client] of [['phone',phone],['glasses',glasses]]){const shot=await client.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+kind+'.png',out),Buffer.from(shot.data,'base64'));}}
assert.ok(await evaluate('document.getElementById("reader-ayah-2").getBoundingClientRect().top>=60'));
await capture('reader-matched-bayyina-98-2');
const same=await evaluate('__uiAudit.imageResults.length');await evaluate('jumpReaderAyah(2)');await evaluate('__uiAudit.S.bridgeCallQueue');assert.equal(await evaluate('__uiAudit.imageResults.length'),same);
await evaluate('__uiAudit.onG2Event({textEvent:{eventType:2}})');await evaluate('__uiAudit.S.bridgeCallQueue');assert.equal(await evaluate('document.getElementById("readerAyah").value'),'3');assert.deepEqual(await evaluate('__uiAudit.getReaderWindow().ayahs'),[3]);
await evaluate('loadReaderSurah(2,0,282)');const part=await evaluate('__uiAudit.getReaderWindow()');assert.equal(part.ayah,282);assert.ok(part.parts>1);
await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');assert.equal(await evaluate('__uiAudit.getReaderWindow().ayah'),282);assert.equal(await evaluate('__uiAudit.getReaderWindow().part'),2);
await evaluate('setReaderLayout("maximum")');await evaluate('loadReaderSurah(112,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');
assert.equal(await evaluate('document.getElementById("readerLayout").value'),'maximum');
const dense=await evaluate('__uiAudit.getReaderWindow()');assert.ok(dense.ayahs.length>1);
assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".reader-verse")).map(r=>Number(r.dataset.ayah))'),dense.ayahs);
assert.equal(await evaluate('document.querySelectorAll(".reader-basmala").length'),1);
await new Promise(r=>setTimeout(r,700));await capture('reader-maximum-112');
await evaluate('window.scrollTo(0,document.scrollingElement.scrollHeight)');
await evaluate('document.getElementById("readerText").dispatchEvent(new WheelEvent("wheel",{deltaY:120,cancelable:true,bubbles:true}))');await evaluate('__uiAudit.S.bridgeCallQueue');
await new Promise(r=>setTimeout(r,1500));
assert.notDeepEqual(await evaluate('__uiAudit.getReaderWindow().lines'),dense.lines);
assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".reader-verse")).map(r=>Number(r.dataset.ayah))'),await evaluate('__uiAudit.getReaderWindow().ayahs'));
await evaluate('loadReaderSurah(98,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');const beforeSwipe=await evaluate('__uiAudit.getReaderWindow().startLine');await input('down');await evaluate('__uiAudit.S.bridgeCallQueue');assert.notEqual(await evaluate('__uiAudit.getReaderWindow().startLine'),beforeSwipe,'one native swipe advances the reader');
await evaluate('loadReaderSurah(112,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');await capture('reader-range-1-4');
await evaluate('loadReaderSurah(98,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');const timedStart=await evaluate('__uiAudit.getReaderWindow().startLine');await evaluate('setReaderAutoSeconds(5);setReaderAutoScroll(true)');await new Promise(r=>setTimeout(r,5700));await evaluate('__uiAudit.S.bridgeCallQueue');assert.notEqual(await evaluate('__uiAudit.getReaderWindow().startLine'),timedStart,'timer advances shared page');await evaluate('setReaderAutoScroll(false)');const pausedPage=await evaluate('__uiAudit.getReaderWindow().startLine');await new Promise(r=>setTimeout(r,5400));assert.equal(await evaluate('__uiAudit.getReaderWindow().startLine'),pausedPage,'disabled timer stays on page');
await evaluate('loadReaderSurah(112,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');await capture('reader-range-inside-title');
await evaluate('closeQuranReader();__uiAudit.S.bridge.rebuildPageContainer=window.__readerRebuildOriginal;__uiAudit.S.settings=window.__readerOldSettings;__uiAudit.saveSettings();document.documentElement.setAttribute("data-theme",window.__readerOldTheme||"light")');
console.log('PASS: inherited dark theme; phone scrolling generated 0 image updates; repeat selection generated 0 image updates; selection reused the layout; 98:2 matched on both; next selected 98:3; long 2:282 stayed within its ayah');phone.close();glasses.close();
