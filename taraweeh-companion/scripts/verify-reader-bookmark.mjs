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


await evaluate('window.__bookmarkOldSettings=JSON.parse(JSON.stringify(__uiAudit.S.settings));__uiAudit.S.settings.readerLayout="single";openQuranReader()');await evaluate('loadReaderSurah(2,0,282)');await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');
const original=await evaluate('__uiAudit.getReaderWindow()');assert.equal(original.part,2);
await evaluate('__uiAudit.onG2Event({menuItemClickEvent:{itemID:15}})');await evaluate('__uiAudit.S.bridgeCallQueue');
assert.equal(await evaluate('document.getElementById("readerBookmarkStar").textContent'),'★');assert.ok(await evaluate('__uiAudit.glassesMenu().menuItems.some(i=>i.itemID===16)'));
await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');assert.equal(await evaluate('document.getElementById("readerBookmarkStar").textContent'),'☆');
await evaluate('resumeReaderBookmark()');await evaluate('__uiAudit.S.bridgeCallQueue');assert.deepEqual(await evaluate('__uiAudit.getReaderWindow().lines'),original.lines);
await evaluate('closeQuranReader();__uiAudit.onG2Event({menuItemClickEvent:{itemID:16}})');await new Promise(r=>setTimeout(r,1700));await evaluate('__uiAudit.S.bridgeCallQueue');assert.deepEqual(await evaluate('__uiAudit.getReaderWindow().lines'),original.lines);
await evaluate('document.getElementById("readerBookmarkStar").click()');assert.equal(await evaluate('__uiAudit.S.settings.readerBookmark'),undefined);
await evaluate('closeQuranReader();__uiAudit.S.settings=window.__bookmarkOldSettings;__uiAudit.saveSettings()');
console.log('PASS bookmark from glasses, star state, exact long-ayah continuation, resume from main glasses menu, removal.');phone.close();glasses.close();
