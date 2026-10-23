import {validateEvenHubPageContainer} from '@evenrealities/even_hub_sdk';
import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(t){
 const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
 return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>{paused=r}),close:()=>ws.close()};
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));
await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/mode-home/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const settle=()=>new Promise(r=>setTimeout(r,400));
async function input(action){const r=await fetch('http://127.0.0.1:9898/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});assert.equal(r.ok,true);await settle();}
async function screenshot(name){await evaluate('__homeAudit.S.bridgeCallQueue');await settle();const r=await glasses.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'.png',out),Buffer.from(r.data,'base64'));}
try{
 await phone.send('Page.reload',{ignoreCache:true});
 for(let i=0;i<50;i++){if(await evaluate('typeof window.applyLocalTranslation === "function"'))break;await new Promise(r=>setTimeout(r,100));}
 await settle();await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'});
 const bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId});const paused=phone.pause();
 const call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'});
 const frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__readerLayouts=[];const readerRebuild=S.bridge.rebuildPageContainer.bind(S.bridge);window.__restoreReaderBridge=()=>{S.bridge.rebuildPageContainer=readerRebuild;};S.bridge.rebuildPageContainer=payload=>{if(payload.imageObject?.some(image=>image.containerName.startsWith("reader")))window.__readerLayouts.push(payload);return readerRebuild(payload);};window.__homeAudit={S,showModeHome,glassesTopBarUpdate,refreshGlassesWelcomeText,home:()=>({active:_homeActive,index:_homeIndex,layout:_homeLayout}),reader:()=>_readerActive,picker:()=>({kind:_readerPicking,value:_readerPick,surah:_readerData?.surah,loading:_readerLoading,layout:_readerImageLayout}),recent:()=>_diagLog.slice(-8),glassesMenu};'});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate('__homeAudit.showModeHome();__homeAudit.S.bridgeCallQueue');await settle();
 assert.deepEqual(await evaluate('__homeAudit.home()'),{active:true,index:0,layout:true});
 await screenshot('translate-selected');
 await input('down');assert.equal(await evaluate('__homeAudit.home().index'),1);await screenshot('practice-selected');
 await input('down');assert.equal(await evaluate('__homeAudit.home().index'),2);await screenshot('read-quran-selected');
 await input('down');assert.equal(await evaluate('__homeAudit.home().index'),3);await screenshot('taraweeh-selected');
 await input('up');assert.equal(await evaluate('__homeAudit.home().index'),2);
 await evaluate('__homeAudit.glassesTopBarUpdate();__homeAudit.refreshGlassesWelcomeText();__homeAudit.S.bridgeCallQueue');
 assert.equal(await evaluate('__homeAudit.home().layout'),true);
 await input('click');
 for(let i=0;i<20;i++){if(await evaluate('__homeAudit.reader() && document.querySelectorAll(".reader-verse").length>0'))break;await settle();}
 assert.equal(await evaluate('__homeAudit.reader()'),true);assert.equal(await evaluate('__homeAudit.home().active'),false);
 await evaluate('__homeAudit.S.bridgeCallQueue');await screenshot('reader-opened');
 await evaluate('loadReaderSurah(2,0,59)');await settle();
 await evaluate('__homeAudit.S.settings.readerGlassesTranslation=false;toggleReaderGlassesTranslation()');
 for(let i=0;i<30;i++){if(await evaluate('!__homeAudit.picker().loading'))break;await settle();}
 await evaluate('jumpReaderAyah(59);setReaderAutoSeconds(15);setReaderAutoScroll(true)');
 await screenshot('translation-countdown');
 await new Promise(r=>setTimeout(r,1200));
 assert.ok((await evaluate('__homeAudit.recent()')).some(s=>s.includes('bridge.done readerCountdown')));
 assert.ok(!(await evaluate('__homeAudit.recent()')).some(s=>s.includes('bridge.err')));
 await screenshot('translation-countdown');
 await evaluate('setReaderAutoScroll(false)');
 for(const translated of [true,false,true]){
  await evaluate('closeQuranReader();__homeAudit.S.settings.readerSurah=2;__homeAudit.S.settings.readerAyah=144;__homeAudit.S.settings.readerGlassesTranslation='+translated+';openQuranReader()');await settle();
  assert.equal(await evaluate('__homeAudit.picker().layout'),true,'Reading layout replaces splash');assert.equal(await evaluate('__homeAudit.picker().loading'),false);
  const payload=await evaluate('__readerLayouts.at(-1)');assert.equal(payload.imageObject.length,translated?2:4);assert.equal(payload.textObject.length,translated?2:1);
  const orders=[...payload.imageObject,...payload.textObject].map(c=>c.zOrderIndex);assert.equal(new Set(orders).size,orders.length,'Every layer has a unique order');
  assert.equal(validateEvenHubPageContainer(payload).valid,true);await screenshot(translated?'reader-144-translation':'reader-144-arabic');
 }
 const layouts=await evaluate('__readerLayouts');for(const layout of layouts)assert.equal(validateEvenHubPageContainer(layout).valid,true,JSON.stringify(validateEvenHubPageContainer(layout)));
 console.log('PASS reader splash transition with translation on/off; all real reader payloads pass SDK validation with unique layers; countdown transfers.');
}finally{await evaluate('window.__restoreReaderBridge?.()');phone.close();glasses.close();}


