import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/reciter-position/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,seconds=20){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);}
const settle=()=>new Promise(r=>setTimeout(r,600));
async function capture(name){await evaluate('__reciterAudit.S.bridgeCallQueue');await settle();for(const [kind,target]of [['glasses',glasses],['phone',phone]]){const r=await target.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+kind+'.png',out),Buffer.from(r.data,'base64'));}}
async function select(field,value){await evaluate(`{const e=document.querySelector('.lq [data-el="${field}"]');e.value='${value}';e.dispatchEvent(new Event('change'));}`);}
async function download(){await evaluate(`document.querySelector('.lq [data-el="download"]').click();document.querySelector('.lq [data-el="confirmDownload"]').click();`);await until(`document.querySelector('.lq-offline [data-el="downloadStatus"]').textContent==='Available offline'`);}
try{
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation === "function"');await settle();await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`window.__reciterAudit={S,audio:()=>_audioVisual,page:()=>_readerPages[_readerPage],native:()=>_readerNativeText,data:()=>_readerData,ready:()=>!_readerLoading&&_audioSyncKey===listenSyncKey(_audioVisual)};`});await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__reciterAudit.S.settings.listenGlassesDisplay='arabic-translation';__reciterAudit.S.settings.listenTranslationLang='en';window.__OriginalAudio=window.Audio;window.Audio=function(...a){const e=new window.__OriginalAudio(...a);e.muted=true;window.__reciterAudio=e;return e;};`);
 async function ready(id,surah,ayah){await until(`__reciterAudit.audio()?.reciter==='${id}'&&__reciterAudit.audio()?.surah===${surah}&&__reciterAudit.audio()?.ayah===${ayah}&&__reciterAudit.audio()?.canPlay&&__reciterAudit.ready()`,60);await until('__reciterAudio.readyState>=1');}
 async function chooseAyah(ayah){await select('ayah',String(ayah));await until(`__reciterAudit.audio()?.ayah===${ayah}&&__reciterAudit.ready()`);await settle();}
 await evaluate('openListenQuran()');await ready('alafasy',1,1);await select('reciter','husary');await ready('husary',1,1);
 await select('surah','3');await ready('husary',3,1);await chooseAyah(13);
 await select('reciter','saad-al-ghamdi');await ready('saad-al-ghamdi',3,13);assert.equal(await evaluate('__reciterAudio.paused'),true);assert.equal(await evaluate(`document.querySelector('.lq [data-el="ayah"]').value`),'13');
 await evaluate(`document.querySelector('.lq [data-el="play"]').click()`);await until(`__reciterAudit.audio().state==='playing'`);await select('reciter','husary');await ready('husary',3,13);await until(`__reciterAudit.audio().state==='playing'`);await evaluate('__reciterAudio.pause()');
 // Superseded, slow manifest responses cannot reset the verse or restart audio.
 await evaluate(`window.__positionFetch=window.fetch;window.fetch=async function(input,init){if(String(input).includes('/api/recitations/saad-al-ghamdi/3'))await new Promise(r=>setTimeout(r,700));if(String(input).includes('/api/recitations/noreen-muhammad-siddiq/3'))await new Promise(r=>setTimeout(r,150));return __positionFetch.call(this,input,init);};`);
 await select('reciter','saad-al-ghamdi');await select('reciter','noreen-muhammad-siddiq');await select('reciter','husary');await ready('husary',3,13);await new Promise(r=>setTimeout(r,1000));assert.equal(await evaluate('__reciterAudit.audio().reciter'),'husary');assert.equal(await evaluate('__reciterAudit.audio().ayah'),13);assert.equal(await evaluate('__reciterAudio.paused'),true);await evaluate('window.fetch=__positionFetch');
 // Hafs 3:49 lies inside a merged Al-Duri reading unit. Returning must recover
 // reference 49 rather than its containing unit's first reference (48).
 await chooseAyah(49);await select('reciter','noreen-muhammad-siddiq');await ready('noreen-muhammad-siddiq',3,48);assert.equal(await evaluate('__reciterAudit.audio().ayahEnd'),49);await select('reciter','saad-al-ghamdi');await ready('saad-al-ghamdi',3,49);
 await select('reciter','husary');await ready('husary',3,49);await select('surah','112');await ready('husary',112,1);await select('surah','3');await ready('husary',3,1);await chooseAyah(13);await capture('husary-3-13-preserved');
 const result={passed:true,surah:3,ayah:13,pausedSwitch:true,playingSwitch:true,rapidSwitches:true,mergedDuriRoundTrip:true,newSurahStartsAtOne:true};writeFileSync(new URL('runtime.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 await evaluate(`if(window.__positionFetch)window.fetch=__positionFetch;if(window.__OriginalAudio)window.Audio=__OriginalAudio;if(window.__reciterAudio){__reciterAudio.pause();__reciterAudio.muted=false;}`).catch(()=>{});phone.close();glasses.close();
}
