import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
 return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));
await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/jummah/live-arabic/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(expression,seconds=20){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await delay(200);}throw Error('Timed out: '+expression);}
async function drain(){await evaluate('__flickerAudit.S.bridgeCallQueue');await delay(250);}
async function capture(name){const r=await glasses.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'.png',out),Buffer.from(r.data,'base64'));return r.data;}
try{
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation === "function"');await delay(500);await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`window.__flickerAudit={S,handleServerMsg,showModeHome,stopPageFlip,stopCountdown,stopSearchingDots,stopLockingDots,begin(){leaveModeHome();_readerActive=false;_audioMode=false;_glassesSettings=false;_manualBrowse=false;resetVerseHold();clearGlassesPreamble();stopPageFlip();stopCountdown();stopSearchingDots();stopLockingDots();_glassesSessionId++;_reciteMode='listen';_practiceMode=false;_taraweehMode=false;S.isRecording=true;S._lastGlassesState=null;S.displayRebuilt=false;Object.assign(S.settings,{arabicImage:true,glassesLayout:'arabic-translation',lang:'en'});},finish(){stopPageFlip();stopCountdown();stopSearchingDots();stopLockingDots();S.isRecording=false;S._lastGlassesState=null;showModeHome();}};`});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__flickerAudit.begin();__flickerAudit.handleServerMsg({type:'state',state:{mode:'SEARCHING'}})`);await drain();
 await evaluate(`window.__flickerCalls=[];window.__flickerOriginal={};for(const method of ['rebuildPageContainer','textContainerUpgrade','updateImageRawData']){__flickerOriginal[method]=__flickerAudit.S.bridge[method];__flickerAudit.S.bridge[method]=async function(p){__flickerCalls.push({method,p:method==='updateImageRawData'?{containerID:p.containerID}:p});if(method==='updateImageRawData')await new Promise(resolve=>setTimeout(resolve,650));return __flickerOriginal[method].call(this,p);};}window.__flickerCandidate={mode:'SEARCHING',isCandidate:true,surah:114,ayah:1,surahName:'An-Nas',arabic:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',translation:'Say, I seek refuge in the Lord of mankind',candidateScore:70};__flickerAudit.handleServerMsg({type:'state',state:__flickerCandidate});`);
 await until(`__flickerCalls.some(c=>c.method==='updateImageRawData')`);
 // The real 400 ms candidate timer runs while each tile takes 650 ms.
 await delay(2200);await drain();
 let calls=await evaluate('__flickerCalls');
 assert.equal(calls.filter(c=>c.method==='rebuildPageContainer').length,1);
 assert.deepEqual(calls.filter(c=>c.method==='updateImageRawData').map(c=>c.p.containerID),[10,11]);
 const first=await capture('candidate-stable');await delay(850);await drain();const second=await capture('candidate-after-more-ticks');
 assert.equal(second,first,'Actual glasses framebuffer stays identical during candidate timer ticks');
 await evaluate(`__flickerAudit.handleServerMsg({type:'state',state:{...__flickerCandidate,mode:'LOCKED',isCandidate:false,timerMs:6000}})`);await drain();
 calls=await evaluate('__flickerCalls');assert.equal(calls.filter(c=>c.method==='rebuildPageContainer').length,1);assert.equal(calls.filter(c=>c.method==='updateImageRawData').length,2);await capture('locked-same-tiles');
 await evaluate(`__flickerAudit.stopCountdown();__flickerAudit.handleServerMsg({type:'state',state:{...__flickerCandidate,mode:'LOCKED',isCandidate:false,ayah:2,arabic:'مَلِكِ النَّاسِ',translation:'The Sovereign of mankind',timerMs:6000}})`);await drain();
 calls=await evaluate('__flickerCalls');assert.equal(calls.filter(c=>c.method==='rebuildPageContainer').length,1);assert.ok(calls.filter(c=>c.method==='updateImageRawData').length>2);await capture('next-verse-same-layout');
 const lastBuild=calls.find(c=>c.method==='rebuildPageContainer').p;const native=calls.reduce((text,c)=>c.method==='textContainerUpgrade'&&c.p.containerName==='body'?c.p.content:text,lastBuild.textObject.find(c=>c.containerName==='body').content);assert.equal(native,'The Sovereign of mankind');
 const result={passed:true,tileDelayMs:650,candidateTimerMs:400,candidateBuilds:1,candidateImageTransfers:2,identicalCandidateFramebuffers:true,lockAdditionalImageTransfers:0,nextVerseReusesLayout:true};
 writeFileSync(new URL('result.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 await evaluate(`if(window.__flickerOriginal)for(const [method,fn]of Object.entries(__flickerOriginal))__flickerAudit.S.bridge[method]=fn;__flickerAudit?.finish();`).catch(()=>{});phone.close();glasses.close();
}
