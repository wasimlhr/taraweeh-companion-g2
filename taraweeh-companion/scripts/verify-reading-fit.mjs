import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {getVerseData} from '../backend/verseData.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
const target=targets.find(t=>t.url.startsWith('http://localhost:3012/'));
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));let id=0,paused;const pending=new Map();
ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const wait=ms=>new Promise(r=>setTimeout(r,ms)),out=new URL('../language-evidence/reading-fit/',import.meta.url);mkdirSync(out,{recursive:true});
const results=[];
try{
 await send('Page.reload',{ignoreCache:true});for(let i=0;i<50;i++){if(await evaluate('typeof window.applyLocalTranslation==="function"'))break;await wait(100);}await wait(400);
 await send('Debugger.enable');const fn=await send('Runtime.evaluate',{expression:'window.applyLocalTranslation'});const bp=await send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId});const stop=new Promise(r=>paused=r);const call=send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'});const frame=(await stop).callFrames[0];
 await send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__readingFit={S,updatePhoneUI,initWave,updateWave,setupFlexibleVerseRegion};'});await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await send('Debugger.resume');await call;await send('Debugger.disable');
 await evaluate(`document.getElementById('splashScreen')?.remove();__readingFit.S.isRecording=true;__readingFit.S.settings.phoneTextSize=16;document.getElementById('recordBtn').classList.add('recording');document.getElementById('recordBtn').textContent='Stop Listening';document.getElementById('readingOptions').open=false;__readingFit.initWave();__readingFit.updateWave(.02);for(const id of ['sPillHeard','sPillShown','sPillPace'])document.getElementById(id).style.display='';`);
 for(const height of [640,808,844])for(const mode of ['listen','practice','taraweeh']){
  await send('Emulation.setDeviceMetricsOverride',{width:390,height,deviceScaleFactor:1,mobile:true});await evaluate(`setReciteMode('${mode}');document.documentElement.dataset.theme='dark';window.scrollTo(0,0)`);
  const positions=[];
  for(const [surah,ayah] of [[55,4],[106,2],[2,282]]){
   const state={...getVerseData(surah,ayah,'en'),mode:'LOCKED',surah,ayah,confidence:97};
   await evaluate(`__readingFit.updatePhoneUI(${JSON.stringify(state)},'');__readingFit.updateWave(.02)`);await wait(180);
   const boxes=await evaluate(`(()=>{const rect=id=>{const b=document.getElementById(id).getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height}};return {card:rect('verseCard'),text:rect('lockedContent'),study:rect('verseStudyTools'),nav:rect('verseNavRow'),stop:rect('recordBtn'),footer:rect('versionEl'),viewport:innerHeight,scrollHeight:document.documentElement.scrollHeight}})()`);
   assert.ok(boxes.study.height>=40,'Study actions must remain visible');assert.ok(boxes.study.top>=boxes.text.bottom-1,JSON.stringify(boxes));assert.ok(boxes.study.bottom<=boxes.nav.top+1,JSON.stringify(boxes));assert.ok(boxes.nav.bottom<=boxes.card.bottom,JSON.stringify(boxes));assert.ok(boxes.stop.bottom<=height+1,JSON.stringify(boxes));assert.ok(boxes.footer.height<=20);assert.ok(boxes.text.height>=40,JSON.stringify(boxes));
   positions.push({card:boxes.card,study:boxes.study,nav:boxes.nav,stop:boxes.stop});results.push({height,mode,surah,ayah,...boxes});
   if(height===808&&mode==='listen'){const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(`verse-${surah}-${ayah}.png`,out),Buffer.from(shot.data,'base64'));}
  }
  assert.deepEqual(positions[0],positions[1]);assert.deepEqual(positions[1],positions[2]);
 }
 writeFileSync(new URL('results.json',out),JSON.stringify(results,null,2));console.log('PASS: 27 short/long verse cases, all three modes at 390x640/808/844; study/nav buttons visible, stable positions, Stop visible, compact footer.');
}finally{await evaluate('__readingFit.S.isRecording=false');await send('Emulation.clearDeviceMetricsOverride');await send('Page.reload',{ignoreCache:true});ws.close();}
