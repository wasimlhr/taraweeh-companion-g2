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
  'window.__uiAudit={S,showReaderSplash,loadSettings,handleServerMsg,stopPageFlip,stopCountdown,glassesMenu,onG2Event,ensureLangPack,glassesStartup,ensureArabicFont,arabicImageCanvas,stopListening,buildGlassesText,getHeld:function(){return _readingHeld;},getHeldPage:function(){return _heldPage;}}; __uiAudit.imageResults=[]; __uiAudit.originalImage=S.bridge.updateImageRawData.bind(S.bridge); S.bridge.updateImageRawData=async function(data){var result=await __uiAudit.originalImage(data);__uiAudit.imageResults.push({id:data.containerID,length:data.imageData.length,result:result});return result;};'});
if(injection.exceptionDetails)throw Error(JSON.stringify(injection.exceptionDetails));
await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await phone.send('Debugger.resume'); await call; await phone.send('Debugger.disable');

await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
const savedBackend=await evaluate('__uiAudit.S.settings.backendUrl');await evaluate('__uiAudit.S.settings.backendUrl="http://localhost:3001";__uiAudit.S.settings.readerSurah=1;__uiAudit.S.settings.readerPage=0;openQuranReader()');await settle();
assert.equal(await evaluate('document.getElementById("readerSurah").options.length'),114);
assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
assert.equal(await evaluate('__uiAudit.S.isRecording'),false);
assert.equal(await evaluate('document.getElementById("readerView").hidden'),false);
console.log(await evaluate('({status:document.getElementById("readerStatus").textContent,results:__uiAudit.imageResults,logs:window.dumpDiag().split(String.fromCharCode(10)).filter(l=>l.includes("reader"))})'));assert.ok(await evaluate('__uiAudit.imageResults.filter(r=>r.id>=20&&r.result==="success").length>=6'));
async function capture(name){await evaluate('__uiAudit.S.bridgeCallQueue');await settle();for(const [suffix,client] of [['phone',phone],['glasses',glasses]]){const shot=await client.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+suffix+'.png',out),Buffer.from(shot.data,'base64'));}}
await capture('read-quran-fatiha');
assert.match(await evaluate('document.getElementById("readerSurahTitle").textContent'),/الفاتحة/);
assert.equal(await evaluate('document.getElementById("readerScript").value'),'indopak');
const initial=await evaluate('document.getElementById("readerPage").dataset.lineIndex');
await evaluate('readerStep(1)');await settle();assert.notEqual(await evaluate('document.getElementById("readerPage").dataset.lineIndex'),initial);
await evaluate('readerStep(-1)');await settle();assert.equal(await evaluate('document.getElementById("readerPage").dataset.lineIndex'),initial);
await evaluate('loadReaderSurah(2)');await evaluate('jumpReaderAyah(255)');await capture('read-quran-baqarah');
assert.equal(await evaluate('document.getElementById("readerSurah").value'),'2');
const before=await evaluate('document.getElementById("readerPage").dataset.lineIndex');await evaluate('__uiAudit.onG2Event({textEvent:{eventType:2}})');await settle();assert.notEqual(await evaluate('document.getElementById("readerPage").dataset.lineIndex'),before);
await evaluate('pickReaderSurah()');await capture('read-quran-surah-picker');
await evaluate('__uiAudit.onG2Event({textEvent:{eventType:2}});__uiAudit.onG2Event({textEvent:{eventType:0}})');await new Promise(r=>setTimeout(r,1200));assert.equal(await evaluate('document.getElementById("readerSurah").value'),'3');
await evaluate('window.__readerFetch=window.fetch;window.fetch=()=>Promise.reject(new Error("offline"))');await evaluate('loadReaderSurah(1)');assert.match(await evaluate('document.getElementById("readerStatus").textContent'),/Al-Fatihah/);
await evaluate('window.fetch=window.__readerFetch;loadReaderSurah(18)');await capture('read-quran-kahf');
await evaluate('setReaderScript("madani")');assert.equal(await evaluate('document.getElementById("readerScript").value'),'madani');
await evaluate('setReaderScript("indopak")');assert.equal(await evaluate('document.getElementById("readerScript").value'),'indopak');
await evaluate('__uiAudit.showReaderSplash()');await capture('quran-medallion-splash');
await evaluate('document.getElementById("splashScreen").style.display="flex";document.getElementById("splashScreen").style.opacity="1"');
const splash=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('quran-artwork-splash-phone.png',out),Buffer.from(splash.data,'base64'));
await evaluate('document.getElementById("splashScreen").style.display="none";closeQuranReader();__uiAudit.S.settings.backendUrl='+JSON.stringify(savedBackend)+';');assert.equal(await evaluate('document.getElementById("readerView").hidden'),true);
console.log('Reader: 114 surahs, six successful full-screen tiles, next/previous, ayah jump, glasses swipe and picker, cached offline chapter, clean exit verified');phone.close();glasses.close();
