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
const out=new URL('../language-evidence/audio-page-follow/',import.meta.url);mkdirSync(out,{recursive:true});
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
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__homeAudit={S,page:()=>({index:_readerPage,header:_readerPages[_readerPage]?.header,ayah:_readerPages[_readerPage]?.ayah,parts:_readerPages.filter(p=>p.ayahs.includes(Number(document.getElementById("readerAyah").value))).map(p=>({index:_readerPages.indexOf(p),arabic:p.lines,translation:p.translationLines})),loading:_readerLoading}),pageAt:(ms,duration)=>_readerModule.readerAudioPage(_readerPages,Number(document.getElementById("readerAyah").value),ms,duration),showModeHome,glassesTopBarUpdate,refreshGlassesWelcomeText,audio:()=>({state:_audioVisual,footer:_audioFooterLayout,tiles:_readerLastTiles.map(t=>t?.length)}),home:()=>({active:_homeActive,index:_homeIndex,layout:_homeLayout}),reader:()=>_readerActive,picker:()=>({kind:_readerPicking,value:_readerPick,surah:_readerData?.surah,loading:_readerLoading,layout:_readerImageLayout}),recent:()=>_diagLog.slice(-8),glassesMenu};'});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__homeAudit.S.settings.readerGlassesTranslation=true;__homeAudit.S.settings.listenGlassesDisplay="arabic-translation";__homeAudit.S.settings.listenTranslationLang="en";window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;window.__miniAudio=a;return a;};`);
 await evaluate('openListenQuran()');await settle();assert.equal((await evaluate('__homeAudit.page()')).header,true);await screenshot('opening-header');
 await evaluate(`const s=document.querySelector('.lq [data-el="surah"]');s.value='10';s.dispatchEvent(new Event('change'));`);
 for(let i=0;i<300;i++){if(await evaluate(`!document.querySelector('.lq [data-el="ayah"]').disabled && document.getElementById('versePos').textContent.includes('10:')`))break;await new Promise(r=>setTimeout(r,200));}
 await evaluate(`const a=document.querySelector('.lq [data-el="ayah"]');a.value='2';a.dispatchEvent(new Event('change'));`);await settle();
 await evaluate(`document.querySelector('.lq [data-el="play"]').click()`);await new Promise(r=>setTimeout(r,700));
 await evaluate('__miniAudio.pause()');await settle();
 const duration=await evaluate('__miniAudio.duration*1000');assert.ok(duration>10000);
 const page=await evaluate('__homeAudit.page()');assert.ok(page.parts.length>1);assert.equal(page.header,false);assert.equal(page.parts[0].arabic.length,3);console.log(JSON.stringify({durationMs:duration,parts:page.parts.length}));
 async function seek(ms){await evaluate(`(()=>{const s=document.querySelector('.lq [data-el="seek"]');s.value=${ms};s.dispatchEvent(new Event('input'));})()`);await settle();}
 await seek(0);assert.equal((await evaluate('__homeAudit.page()')).index,page.parts[0].index);await screenshot('first-page');
 const boundary=await evaluate(`(()=>{for(let ms=100;ms<${duration};ms+=100)if(__homeAudit.pageAt(ms,${duration})!==${page.parts[0].index})return ms;return 0;})()`);
 assert.ok(boundary>0);await seek(boundary-200);await evaluate('__miniAudio.play()');for(let i=0;i<20;i++){if((await evaluate('__homeAudit.page()')).index>page.parts[0].index)break;await new Promise(r=>setTimeout(r,200));}await evaluate('__miniAudio.pause()');await settle();
 assert.ok((await evaluate('__homeAudit.page()')).index>page.parts[0].index,'Real playback advances within the ayah');await screenshot('automatic-continuation');
 await seek(duration*.95);assert.equal((await evaluate('__homeAudit.page()')).index,page.parts.at(-1).index);await screenshot('last-page');
 const frozen=(await evaluate('__homeAudit.page()')).index;await new Promise(r=>setTimeout(r,650));assert.equal((await evaluate('__homeAudit.page()')).index,frozen,'Pause freezes pagination');
 await seek(0);assert.equal((await evaluate('__homeAudit.page()')).index,page.parts[0].index,'Seeking backwards restores first page');
 await seek(duration-250);await evaluate('__miniAudio.play()');for(let i=0;i<50;i++){if(await evaluate(`Number(document.querySelector('.lq [data-el="ayah"]').value)===3 && !__homeAudit.page().loading`))break;await new Promise(r=>setTimeout(r,200));}await evaluate('__miniAudio.pause()');await settle();
 assert.equal(await evaluate(`Number(document.querySelector('.lq [data-el="ayah"]').value)`),3);assert.equal((await evaluate('__homeAudit.page()')).ayah,3);await screenshot('next-ayah');
 console.log('PASS: Yunus 10:2 automatically advances during real playback; final Arabic and translation visible; pause freezes; backward seek restores page; ended advances to 10:3.');
}finally{phone.close();glasses.close();}
