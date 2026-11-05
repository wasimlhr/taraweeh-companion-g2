import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let id=0,paused;
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
 return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/listen-page-swipes/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,seconds=30){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);}
async function select(field,value){await evaluate(`{const e=document.querySelector('.lq [data-el="${field}"]');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change'));}`);await until('audit.ready()',60);}
async function capture(name){await evaluate('audit.S.bridgeCallQueue');await new Promise(r=>setTimeout(r,500));for(const [kind,client] of [['phone',phone],['glasses',glasses]]){const r=await client.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+kind+'.png',out),Buffer.from(r.data,'base64'));}}
async function snapshot(){return evaluate('({audio:audit.audio(),page:audit.index(),group:audit.pages()[audit.index()].ayahs,phone:document.getElementById("verseTrans").textContent,native:audit.native(),label:document.getElementById("versePos").textContent})');}
async function swipe(direction){const before=await snapshot();await evaluate(`audit.event({textEvent:{eventType:${direction>0?2:1}}})`);await until(`audit.ready()&&audit.index()===${before.page+direction}`);await evaluate('audit.S.bridgeCallQueue');return snapshot();}
const samples=[];let saved;
try{
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation==="function"');
 await phone.send('Debugger.enable');const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.audit={S,event:onG2Event,audio:()=>_audioVisual,pages:()=>_readerPages,index:()=>_readerPage,native:()=>_readerNativeText,pause:()=>_audioUI.pause(),ready:()=>!_readerLoading&&_audioVisual?.canPlay&&_audioSyncKey===listenSyncKey(_audioVisual)};'});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');await until('audit.S.isG2&&audit.S.startupPageCreated');
 saved=await evaluate('audit.S.settings.listenGlassesDisplay||"arabic-translation"');
 await evaluate('openListenQuran()');await until('audit.ready()',60);await select('surah',55);
 for(const reciter of ['alafasy','noreen-muhammad-siddiq']){
  await select('reciter',reciter);
  for(const display of ['arabic-translation','arabic','translation']){
   await evaluate('setListenGlassesDisplay('+JSON.stringify(display)+')');await until('audit.ready()');
   const group=await evaluate('(()=>{const index=audit.pages().findIndex((p,i)=>i>0&&i<audit.pages().length-1&&p.ayahs.length>=3);return {index,ayahs:audit.pages()[index]?.ayahs};})()');
   assert.ok(group.index>0,'A three/four ayah test group must exist');await select('ayah',group.ayahs[0]);assert.equal((await snapshot()).page,group.index);
   const before=await snapshot(),next=await swipe(1);assert.equal(next.audio.ayah,next.group[0]);assert.equal(next.audio.positionMs,0);assert.notDeepEqual(next.group,before.group);assert.notEqual(next.phone,before.phone);
   const previous=await swipe(-1);assert.equal(previous.page,group.index);assert.equal(previous.audio.ayah,group.ayahs[0]);assert.equal(previous.audio.state,'ready');
   await select('ayah',group.ayahs.at(-1));const fromLast=await swipe(1);assert.equal(fromLast.page,next.page);
   samples.push({reciter,display,before,next,previous,fromLast});if(display==='arabic-translation')await capture(reciter+'-one-swipe');
  }
 }
 await select('reciter','alafasy');await evaluate('setListenGlassesDisplay("arabic-translation")');await select('surah',2);await select('ayah',282);
 const longBefore=await snapshot(),longNext=await swipe(1),longPrevious=await swipe(-1);assert.equal(longNext.audio.ayah,282);assert.ok(longNext.audio.positionMs>0);assert.equal(longPrevious.page,longBefore.page);assert.equal(longPrevious.audio.positionMs,0);await capture('long-ayah-continuation');
 await evaluate('setListenGlassesDisplay('+JSON.stringify(saved)+')');await select('surah',55);await select('ayah',2);await capture('final');
 writeFileSync(new URL('runtime.json',out),JSON.stringify({passed:true,samples,longBefore,longNext,longPrevious,version:await evaluate('document.querySelector(".version-tag")?.textContent||"3.4.38"')},null,2));
 console.log('PASS: one swipe per displayed group, both directions, all three display modes, Alafasy and Noreen, and long-ayah continuation; playback stays stopped.');
}finally{phone.close();glasses.close();}
