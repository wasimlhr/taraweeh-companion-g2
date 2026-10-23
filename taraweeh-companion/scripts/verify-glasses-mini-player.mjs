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
const out=new URL('../language-evidence/mini-player/',import.meta.url);mkdirSync(out,{recursive:true});
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
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__homeAudit={S,showModeHome,glassesTopBarUpdate,refreshGlassesWelcomeText,audio:()=>({state:_audioVisual,footer:_audioFooterLayout,tiles:_readerLastTiles.map(t=>t?.length)}),home:()=>({active:_homeActive,index:_homeIndex,layout:_homeLayout}),reader:()=>_readerActive,picker:()=>({kind:_readerPicking,value:_readerPick,surah:_readerData?.surah,loading:_readerLoading,layout:_readerImageLayout}),recent:()=>_diagLog.slice(-8),glassesMenu};'});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__homeAudit.S.settings.readerGlassesTranslation=true;__homeAudit.S.settings.listenGlassesDisplay="arabic-translation";__homeAudit.S.settings.listenTranslationLang="en";window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;window.__miniAudio=a;return a;};`);
 await evaluate('openListenQuran()');await settle();
 await evaluate(`const sel=document.querySelector('.lq [data-el="ayah"]');sel.value='7';sel.dispatchEvent(new Event('change'));`);await settle();
 await evaluate(`document.querySelector('.lq [data-el="play"]').click()`);await new Promise(r=>setTimeout(r,1200));
 assert.equal(await evaluate(`document.querySelector('.lq [data-el="status"]').textContent`),'Playing');
 const data=await evaluate('__homeAudit.audio()');assert.equal(data.footer,false);assert.deepEqual(data.tiles,[41472,41472,41472,41472]);
 await screenshot('playing');
 await input('click');console.log(await evaluate('__homeAudit.recent()'));assert.equal(await evaluate(`document.querySelector('.lq [data-el="status"]').textContent`),'Paused');
 await screenshot('paused');
 const before=await evaluate('__miniAudio.currentTime');
 await input('context_menu');await input('down');await input('down');await input('click');
 assert.ok(await evaluate('__miniAudio.currentTime')>before+8,'Native menu seeks forward');
 await input('context_menu');await input('down');await input('click');
 assert.ok(Math.abs(await evaluate('__miniAudio.currentTime')-before)<.5,'Native menu seeks back');
 await screenshot('seeked');
 console.log(JSON.stringify({passed:true,actualPlayback:true,tapPause:true,seekMenu:true,footerTiles:data.tiles}));
}finally{phone.close();glasses.close();}

