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



await evaluate('window.__singleOld=JSON.parse(JSON.stringify(__uiAudit.S.settings));__uiAudit.S.settings.readerLayout="single";__uiAudit.S.settings.readerRemote=false;__uiAudit.S.settings.readerShowTranslation=true;__uiAudit.S.settings.lang="en";openQuranReader()');await evaluate('loadReaderSurah(1,0,3)');await evaluate('__uiAudit.S.bridgeCallQueue');
let page=await evaluate('__uiAudit.getReaderWindow()');assert.equal(page.kind,'combined');assert.ok(page.translationLines.length);
async function capture(name){await new Promise(r=>setTimeout(r,600));const shot=await glasses.send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:576,height:288,scale:1}});writeFileSync(new URL(name+'.png',out),Buffer.from(shot.data,'base64'));}
await capture('reader-single-arabic-translation');
await evaluate('loadReaderSurah(2,0,255)');await evaluate('__uiAudit.S.bridgeCallQueue');page=await evaluate('__uiAudit.getReaderWindow()');assert.equal(page.ayah,255);assert.equal(page.kind,'arabic');await capture('reader-single-long-arabic');
for(let i=0;i<30&&page.kind!=='translation';i++){await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');page=await evaluate('__uiAudit.getReaderWindow()');assert.equal(page.ayah,255);}
assert.equal(page.kind,'translation');assert.ok(page.translationLines.length);await capture('reader-single-long-translation');
await evaluate('toggleReaderBookmark()');await evaluate('__uiAudit.S.bridgeCallQueue');const translationPage=await evaluate('__uiAudit.getReaderWindow()');await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');await evaluate('resumeReaderBookmark()');await evaluate('__uiAudit.S.bridgeCallQueue');assert.deepEqual(await evaluate('__uiAudit.getReaderWindow().translationLines'),translationPage.translationLines);
page=await evaluate('__uiAudit.getReaderWindow()');for(let i=0;i<30&&page.ayah===255;i++){await evaluate('readerStep(1)');await evaluate('__uiAudit.S.bridgeCallQueue');page=await evaluate('__uiAudit.getReaderWindow()');}assert.equal(page.ayah,256);
await evaluate('closeQuranReader();__uiAudit.S.settings=window.__singleOld;__uiAudit.saveSettings()');
console.log('PASS short combined page, long Arabic then translation, exact translation bookmark, only then next ayah.');phone.close();glasses.close();
