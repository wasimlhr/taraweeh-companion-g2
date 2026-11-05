import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/reciter-display-commit/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,seconds=20){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);}
const settle=()=>new Promise(r=>setTimeout(r,600));
async function capture(name){await evaluate('__reciterAudit.S.bridgeCallQueue');await settle();for(const [kind,target]of [['glasses',glasses],['phone',phone]]){const r=await target.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+kind+'.png',out),Buffer.from(r.data,'base64'));}}
async function select(field,value){await evaluate(`{const e=document.querySelector('.lq [data-el="${field}"]');e.value='${value}';e.dispatchEvent(new Event('change'));}`);}
async function download(){await evaluate(`document.querySelector('.lq [data-el="download"]').click();document.querySelector('.lq [data-el="confirmDownload"]').click();`);await until(`document.querySelector('.lq-offline [data-el="downloadStatus"]').textContent==='Available offline'`);}
async function pixels(){const r=await glasses.send('Runtime.evaluate',{expression:`(()=>{const im=document.getElementById('layer-bright'),c=document.createElement('canvas');c.width=576;c.height=288;const ctx=c.getContext('2d');ctx.drawImage(im,0,0,576,288);const d=ctx.getImageData(24,144,528,108).data;let ink=0;for(let i=0;i<d.length;i+=4)if(d[i+1]>40||d[i]>40||d[i+2]>40)ink++;return ink;})()`,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const samples=[];
async function fingerprint(){const r=await glasses.send('Runtime.evaluate',{expression:`(()=>{const c=document.createElement('canvas');c.width=576;c.height=288;const ctx=c.getContext('2d');ctx.drawImage(document.getElementById('layer-bright'),0,0,576,288);let hash=2166136261;for(const byte of ctx.getImageData(24,144,528,108).data)hash=Math.imul(hash^byte,16777619)>>>0;return hash;})()`,returnByValue:true});return r.result.value;}
async function assertCurrentText(){await evaluate('__reciterAudit.S.bridgeCallQueue');await settle();const before=await fingerprint();await evaluate(`__reciterAudit.S.bridge.textContainerUpgrade({containerID:1,containerName:'readerInput',content:__reciterAudit.native()})`);await settle();assert.equal(await fingerprint(),before,'Rendered translation must already match the current page, not an older cached frame');}

try{
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation === "function"');await settle();
 await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__reciterAudit={S,audio:()=>_audioVisual,data:()=>_readerData,page:()=>_readerPages[_readerPage],native:()=>_readerNativeText,ready:()=>!_readerLoading&&_audioSyncKey===listenSyncKey(_audioVisual)&&_audioVisual.canPlay,toggle:()=>_audioUI.toggle()};'});await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate('window.__originalCommitAudio=window.Audio;window.Audio=function(...args){const a=new __originalCommitAudio(...args);a.muted=true;window.__commitAudio=a;return a;};setListenPlaybackSpeed(1);setListenGlassesDisplay("arabic-translation");openListenQuran();');await until('__reciterAudit.ready()');
 await select('surah','55');await until('__reciterAudit.audio()?.surah===55&&__reciterAudit.ready()',90);
 await select('ayah','33');await until('__reciterAudit.audio()?.ayah===33&&__reciterAudit.ready()');
 await assertCurrentText();
 async function holdNextFrame(){await evaluate('window.__blockedCommit=false;window.__commitGate=new Promise(r=>window.__releaseCommit=r);window.__originalCommitImage=__reciterAudit.S.bridge.updateImageRawData;__reciterAudit.S.bridge.updateImageRawData=async function(p){if(p.containerID<22&&!__blockedCommit){__blockedCommit=true;await __commitGate;}return __originalCommitImage.call(this,p);};');}
 async function releaseFrame(){await evaluate('__releaseCommit();__reciterAudit.S.bridge.updateImageRawData=__originalCommitImage;');}
 async function assertPreparing(){
  await until('__blockedCommit');
  assert.equal(await evaluate('__reciterAudit.audio().canPlay'),false);
  assert.equal(await evaluate('__reciterAudit.audio().state'),'loading');
  assert.equal(await evaluate('document.getElementById("recordBtn").disabled'),true);
  assert.equal(await evaluate('__commitAudio.paused'),true);
  await evaluate('__reciterAudit.toggle()');
  assert.equal(await evaluate('__commitAudio.paused'),true,'Tap cannot start the new recording before its display arrives');
 }
 async function assertCoherent(reciter,riwaya,label){
  await until('__reciterAudit.audio()?.reciter==='+JSON.stringify(reciter)+'&&__reciterAudit.ready()',90);
  const state=await evaluate('(()=>{const a=__reciterAudit.audio(),d=__reciterAudit.data(),p=__reciterAudit.page(),verses=d.verses.filter(v=>(v.ayahs||[v.ayah]).some(n=>p.ayahs.includes(n)));return {riwaya:d.riwaya||"hafs",audioAyah:a.ayah,label:document.querySelector(".lq [data-el=ayah]").selectedOptions[0].textContent,phonePos:document.getElementById("versePos").textContent,phoneArabic:document.getElementById("verseArabic").textContent,arabic:verses.map(v=>v.arabic),phoneTranslation:document.getElementById("verseTrans").textContent,translation:verses.map(v=>v.translation),page:p,native:__reciterAudit.native()};})()');
  assert.equal(state.riwaya,riwaya);assert.equal(state.audioAyah,33);assert.equal(state.label,label);
  const phoneArabic=riwaya==='hafs'?state.phoneArabic.replace(/۝[٠-٩]+/g,''):state.phoneArabic;
  for(const text of state.arabic)assert.ok(phoneArabic.replace(/\s/g,'').includes(text.replace(/\s/g,'')));
  for(const text of state.translation)assert.ok(state.phoneTranslation.includes(text));assert.ok(state.page.ayahs.includes(state.audioAyah));
  if(riwaya==='ad-duri'){assert.match(state.phonePos,/Al-Duri.*Ayahs? 31/);assert.ok(!state.native.startsWith('32.'));}
  await assertCurrentText();return state;
 }
 await holdNextFrame();await select('reciter','noreen-muhammad-siddiq');await assertPreparing();
 // Keep the bridge blocked for a full second, longer than the old Ready gap.
 await new Promise(r=>setTimeout(r,1100));assert.equal(await evaluate('__reciterAudit.audio().canPlay'),false);
 await releaseFrame();samples.push(await assertCoherent('noreen-muhammad-siddiq','ad-duri','31'));await capture('noreen-55-native31');
 await evaluate('__reciterAudit.toggle()');await until('__reciterAudit.audio().state==="playing"');
 await holdNextFrame();await select('reciter','alafasy');await assertPreparing();await releaseFrame();
 await until('__reciterAudit.audio().state==="playing"');samples.push(await assertCoherent('alafasy','hafs','33'));
 await evaluate('__reciterAudit.toggle()');await holdNextFrame();await select('reciter','noreen-muhammad-siddiq');await assertPreparing();await select('reciter','alafasy');await releaseFrame();
 samples.push(await assertCoherent('alafasy','hafs','33'));assert.equal(await evaluate('__commitAudio.paused'),true);
 await select('reciter','noreen-muhammad-siddiq');samples.push(await assertCoherent('noreen-muhammad-siddiq','ad-duri','31'));await capture('final-noreen-55-native31');
 writeFileSync(new URL('runtime.json',out),JSON.stringify({passed:true,delayedDisplayBlocksReady:true,delayedDisplayBlocksManualPlay:true,autoplayWaitsForDisplay:true,supersededDisplayCannotResume:true,samples},null,2));
 console.log('PASS: readiness and playback wait for the actual new reading; phone, selector and native glasses text agree');
}finally{
 await evaluate('if(window.__releaseCommit)__releaseCommit();if(window.__originalCommitImage)__reciterAudit.S.bridge.updateImageRawData=__originalCommitImage;if(window.__originalCommitAudio)window.Audio=__originalCommitAudio;if(window.__commitAudio){__commitAudio.pause();__commitAudio.muted=false;}').catch(()=>{});phone.close();glasses.close();
}
