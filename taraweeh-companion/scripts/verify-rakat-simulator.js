import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getAdvW } from '@evenrealities/pretext';
import { compactLang } from './build-translation-packs.js';

const out = new URL('../language-evidence/', import.meta.url);
mkdirSync(out, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = targets.find(t => t.url.startsWith('http://localhost:3001/'));
if (!target) throw new Error('Run the Even simulator with WebView2 remote debugging port 9222');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let id = 0;
const pending = new Map();
let paused;
socket.on('message', data => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  } else if (msg.method === 'Debugger.paused') paused?.(msg.params);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
await evaluate("window.caches ? caches.delete('qc-lang-packs-v1') : Promise.resolve()");
await send('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 1500));
await send('Debugger.enable');
const fn = await send('Runtime.evaluate', { expression: 'window.applyLocalTranslation' });
const bp = await send('Debugger.setBreakpointOnFunctionCall', { objectId: fn.result.objectId });
const stopped = new Promise(resolve => { paused = resolve; });
const call = send('Runtime.evaluate', { expression: 'window.applyLocalTranslation(null)' });
const frame = (await stopped).callFrames[0];
const injected = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
  expression: 'window.__languageTest = { S, ensureLangPack, hasLangPack, lookupPackVerse, handleServerMsg, buildGlassesText, cyrillicToUzbekLatinClient, glassesTranslationText, stopPageFlip, stopCountdown, glassesStartup, stopListening, startListening };' });
if (injected.exceptionDetails) throw new Error(JSON.stringify(injected.exceptionDetails));
await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
await send('Debugger.resume');
await call;
await send('Debugger.disable');
await evaluate('(async () => { window.__languageTest.glassesStartup(); await window.__languageTest.S.bridgeCallQueue; })()');
// Startup queues a welcome repaint after its create/rebuild completes. Let
// that finish before feeding the first verse so evidence cannot show welcome.
await new Promise(resolve => setTimeout(resolve, 500));
await evaluate('window.__languageTest.S._lastGlassesState = null');

await evaluate('(async()=>{const t=window.__languageTest;window.setReciteMode("taraweeh");t.S.settings.lang="uz";await t.ensureLangPack("uz");document.getElementById("recordBtn").click();})()');
await new Promise(r=>setTimeout(r,1000));
const start=await evaluate('({recording:window.__languageTest.S.isRecording,button:document.getElementById("recordBtn").textContent})');
if(!start.recording || !start.button.includes('Stop Listening'))throw new Error('Start failed '+JSON.stringify(start));
await evaluate('window.adjustRakat(1)');await new Promise(r=>setTimeout(r,500));
const count=await evaluate('document.getElementById("rakatCount").textContent');
if(count!=='Rakat 2')throw new Error('Correction failed '+count);
await evaluate('(async()=>{const t=window.__languageTest;t.handleServerMsg({type:"state",state:{mode:"LOCKED",surah:114,ayah:1,surahName:"An-Nas",arabic:"قُلْ أَعُوذُ بِرَبِّ النَّاسِ",translation:"Say, I seek refuge in the Lord of mankind.",translationLang:"en",timerMs:60000,totalAyahs:6}});t.stopPageFlip();t.stopCountdown();await t.S.bridgeCallQueue;})()');
await new Promise(r=>setTimeout(r,500));
async function capture(name){const phone=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-phone.png',out),Buffer.from(phone.data,'base64'));const gs=new WebSocket(targets.find(t=>t.url.includes('glasses.html')).webSocketDebuggerUrl);await new Promise(r=>gs.once('open',r));const g=await new Promise(r=>{gs.once('message',d=>r(JSON.parse(d).result));gs.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png'}}));});writeFileSync(new URL(name+'-glasses.png',out),Buffer.from(g.data,'base64'));gs.close();}
await capture('rakat2-uz');
await evaluate('window.adjustRakat(-1)');await new Promise(r=>setTimeout(r,500));
const corrected=await evaluate('document.getElementById("rakatCount").textContent');if(corrected!=='Rakat 1')throw new Error('Minus failed');
await evaluate('(async()=>{window.__languageTest.stopListening();await window.__languageTest.S.bridgeCallQueue;})()');await new Promise(r=>setTimeout(r,500));await capture('stopped');
const stop=await evaluate('({recording:window.__languageTest.S.isRecording,button:document.getElementById("recordBtn").textContent})');if(stop.recording || !stop.button.includes('Start Listening'))throw new Error('Stop failed');
writeFileSync(new URL('rakat-simulator.json',out),JSON.stringify({start,count,corrected,stop},null,2));socket.close();console.log('Simulator start, +, Uzbek verse, -, stop PASS');
