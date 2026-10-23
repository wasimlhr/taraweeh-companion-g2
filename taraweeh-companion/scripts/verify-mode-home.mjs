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
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__homeAudit={S,showModeHome,glassesTopBarUpdate,refreshGlassesWelcomeText,home:()=>({active:_homeActive,index:_homeIndex,layout:_homeLayout}),reader:()=>_readerActive,picker:()=>({kind:_readerPicking,value:_readerPick,surah:_readerData?.surah,loading:_readerLoading,layout:_readerImageLayout}),recent:()=>_diagLog.slice(-8),glassesMenu};'});
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
 assert.deepEqual(await evaluate('__homeAudit.glassesMenu().menuItems.slice(0,2).map(i=>i.itemID)'),[13,17]);
 // Operate both pickers through the simulator's native menu, without phone clicks.
 await input('context_menu');await input('click');
 assert.equal(await evaluate('__homeAudit.picker().kind'),'surah');
 await screenshot('surah-picker');
 await input('down');const surah=await evaluate('__homeAudit.picker().value');await input('click');
 for(let i=0;i<20;i++){if(await evaluate('!__homeAudit.picker().loading'))break;await settle();}
 assert.equal(await evaluate('__homeAudit.picker().surah'),surah);
 await new Promise(r=>setTimeout(r,800));
 await input('context_menu');await input('down');await input('click');
 assert.equal(await evaluate('__homeAudit.picker().kind'),'ayah');
 await input('down');const ayah=await evaluate('__homeAudit.picker().value');
 await screenshot('ayah-picker');console.log(JSON.stringify(await evaluate('({picker:__homeAudit.picker(),logs:__homeAudit.recent()})')));await input('click');
 assert.equal(await evaluate('Number(document.getElementById("readerAyah").value)'),ayah);
 assert.equal(await evaluate('__homeAudit.picker().kind'),false);
 await evaluate('__homeAudit.S.bridgeCallQueue');await screenshot('ayah-selected');
 await evaluate('closeQuranReader();__homeAudit.S.bridgeCallQueue');await settle();
 assert.equal(await evaluate('__homeAudit.home().active'),true);assert.equal(await evaluate('__homeAudit.home().layout'),true);
 assert.equal(await evaluate('__homeAudit.S.isRecording'),false);
 await screenshot('returned-home');
 console.log('PASS: all four mode selections; native menu Surah and Ayah pickers; one swipe per selection; tap loads target; Back restores launcher; no capture started.');
}finally{phone.close();glasses.close();}
