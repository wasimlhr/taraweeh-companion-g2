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
  'window.__uiAudit={S,loadSettings,handleServerMsg,stopPageFlip,stopCountdown,glassesMenu,onG2Event,ensureLangPack,glassesStartup,ensureArabicFont,arabicImageCanvas,stopListening,buildGlassesText,getHeld:function(){return _readingHeld;},getHeldPage:function(){return _heldPage;}}; __uiAudit.imageResults=[]; __uiAudit.originalImage=S.bridge.updateImageRawData.bind(S.bridge); S.bridge.updateImageRawData=async function(data){var result=await __uiAudit.originalImage(data);__uiAudit.imageResults.push({id:data.containerID,length:data.imageData.length,result:result});return result;};'});
if(injection.exceptionDetails)throw Error(JSON.stringify(injection.exceptionDetails));
await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await phone.send('Debugger.resume'); await call; await phone.send('Debugger.disable');


const store=new URL('../screenshots/even-g2-3.4.32/',import.meta.url);mkdirSync(store,{recursive:true});
await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
async function screenshot(name,client,clip){await new Promise(r=>setTimeout(r,900));const shot=await client.send('Page.captureScreenshot',{format:'png',...(clip?{clip}:{})});writeFileSync(new URL(name+'.png',store),Buffer.from(shot.data,'base64'));}
const clip={x:0,y:0,width:576,height:288,scale:1};
for(const [mode,id] of [['listen',10],['practice',11],['taraweeh',12]]){
 await evaluate(`__uiAudit.onG2Event({menuItemClickEvent:{itemID:${id}}})`);
 assert.equal(await evaluate('document.documentElement.getAttribute("data-recitation-mode")'),mode);
 const verse={...getVerseData(1,3,'en'),mode:'SEARCHING',userSearching:true,confidence:1,timerMs:60000};
 await evaluate(`(async()=>{setMainLang('en');setReadingPreset('arabic-translation');__uiAudit.glassesStartup();await __uiAudit.S.bridgeCallQueue;__uiAudit.S.isRecording=false;manualNextAyah();__uiAudit.handleServerMsg({type:'state',state:${JSON.stringify(verse)}});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();await __uiAudit.S.bridgeCallQueue;window.scrollTo(0,0)})()`);
 const name=mode==='listen'?'translate':mode;
 await screenshot(name+'-phone',phone);await screenshot(name+'-glasses',glasses,clip);
}
await evaluate('__uiAudit.onG2Event({menuItemClickEvent:{itemID:6}})');await new Promise(r=>setTimeout(r,900));await evaluate('setReaderLayout("maximum")');await evaluate('loadReaderSurah(112,0,1)');await evaluate('__uiAudit.S.bridgeCallQueue');
const menu=await evaluate('__uiAudit.glassesMenu().menuItems.map(i=>i.itemName)');for(const name of ['Translate','Practice','Read Quran','Taraweeh'])assert.ok(menu.includes(name));
await screenshot('read-quran-phone',phone);await screenshot('read-quran-glasses',glasses,clip);
await input('context_menu');await screenshot('four-mode-glasses-menu',glasses,clip);await input('click');
console.log('PASS all four modes reachable; captured 9 store screenshots.');phone.close();glasses.close();
