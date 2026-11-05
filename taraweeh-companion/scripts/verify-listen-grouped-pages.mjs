import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
 return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>{paused=r}),close:()=>ws.close()};
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));
await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/listen-grouped/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const settle=()=>new Promise(r=>setTimeout(r,450));
async function until(expression,seconds=20){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);}
async function screenshot(name){await evaluate('__groupAudit.S.bridgeCallQueue');await settle();const r=await glasses.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'.png',out),Buffer.from(r.data,'base64'));}
try{
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation === "function"');await settle();
 await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'});
 const bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId});const paused=phone.pause();
 const call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'});const frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`window.__groupAudit={S,page:()=>({index:_readerPage,..._readerPages[_readerPage]}),audio:()=>_audioVisual,ready:()=>!_readerLoading&&_audioSyncKey===listenSyncKey(_audioVisual),stats:()=>({pages:_readerPages.length,oldPages:_readerModule.readerInterleavedPages(_readerData.verses,t=>{const c=document.createElement('canvas').getContext('2d');c.font='28px '+readerFont();return c.measureText(displayArabic(t)).width;},t=>_pretext.getTextWidth(t),520,!!_readerData.basmala,4,true).length}),pages:()=>_readerPages,chooseDisplay:setListenGlassesDisplay};`});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__groupAudit.S.settings.listenGlassesDisplay='arabic-translation';__groupAudit.S.settings.listenTranslationLang='en';window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;window.__groupAudio=a;return a;};window.__groupCalls={builds:0,upper:0,lower:0};window.__groupOriginalBuild=__groupAudit.S.bridge.rebuildPageContainer;window.__groupOriginalImage=__groupAudit.S.bridge.updateImageRawData;__groupAudit.S.bridge.rebuildPageContainer=function(...a){__groupCalls.builds++;return __groupOriginalBuild.apply(this,a);};__groupAudit.S.bridge.updateImageRawData=function(p){__groupCalls[p.containerID<22?'upper':'lower']++;return __groupOriginalImage.call(this,p);};`);
 await evaluate(`window.__groupNative=[];window.__groupBuildCounter=__groupAudit.S.bridge.rebuildPageContainer;window.__groupOriginalUpgrade=__groupAudit.S.bridge.textContainerUpgrade;__groupAudit.S.bridge.rebuildPageContainer=function(p){__groupNative.push({kind:'build',texts:p.textObject});return __groupBuildCounter.call(this,p);};__groupAudit.S.bridge.textContainerUpgrade=function(p){__groupNative.push({kind:'text',...p});return __groupOriginalUpgrade.call(this,p);};`);
 await evaluate('openListenQuran()');await settle();
 await evaluate(`{const s=document.querySelector('.lq [data-el="surah"]');s.value='55';s.dispatchEvent(new Event('change'));}`);
 await until(`!document.querySelector('.lq [data-el="ayah"]').disabled&&__groupAudit.audio()?.surah===55&&__groupAudit.ready()`,60);
 await evaluate(`{const s=document.querySelector('.lq [data-el="ayah"]');s.value='2';s.dispatchEvent(new Event('change'));}`);await until('__groupAudit.audio()?.ayah===2&&__groupAudit.ready()');await settle();
 const group=await evaluate('__groupAudit.page()');assert.ok(group.ayahs.length>=3,JSON.stringify(group));
 const stats=await evaluate('__groupAudit.stats()');assert.ok(stats.pages<stats.oldPages);console.log(JSON.stringify({stats,group}));await screenshot('rahman-group');
 // Reach the real media-ended event without waiting for the full recording.
 await evaluate(`document.querySelector('.lq [data-el="play"]').click()`);await until('__groupAudio.duration>0');
 await evaluate('__groupAudio.pause()');await settle();
 const before=await evaluate('({...__groupCalls})');
 await evaluate('__groupAudio.currentTime=__groupAudio.duration-.2;__groupAudio.play()');
 await until('__groupAudit.audio()?.ayah===3&&__groupAudit.ready()');await evaluate('__groupAudio.pause()');await settle();
 assert.equal((await evaluate('__groupAudit.page()')).index,group.index);
 const after=await evaluate('({...__groupCalls})');assert.equal(after.builds,before.builds,'No page rebuild between grouped ayahs');assert.equal(after.upper,before.upper,'No Arabic tile transfer between grouped ayahs');
 assert.equal(await evaluate(`__groupNative.reduce((content,call)=>{const text=call.kind==='build'?call.texts?.find(t=>t.containerID===1):call;return text?.containerID===1?text.content:content;},'')`),group.translationLines.join('\n'),'Grouped translations remain unchanged after native text upgrades');
 await screenshot('same-page-next-recording');
 async function select(ayah){await evaluate(`{const s=document.querySelector('.lq [data-el="ayah"]');s.value='${ayah}';s.dispatchEvent(new Event('change'));}`);await until(`__groupAudit.audio()?.ayah===${ayah}&&__groupAudit.ready()`);await settle();}
 await select(group.ayahs.at(-1)+1);assert.ok((await evaluate('__groupAudit.page()')).index>group.index,'Next group changes page');
 await select(2);assert.equal((await evaluate('__groupAudit.page()')).index,group.index,'Previous ayah restores group');
 await evaluate(`__groupAudit.chooseDisplay('translation')`);await settle();
 const translation=await evaluate('__groupAudit.page()');assert.equal(translation.kind,'translation-only');assert.ok(translation.ayahs.length>1);assert.equal(translation.lines.length,0);await screenshot('translation-only-group');
 await evaluate(`__groupAudit.chooseDisplay('arabic-translation')`);await settle();
 writeFileSync(new URL('result.json',out),JSON.stringify({passed:true,stats,group,before,after,translation},null,2));
 console.log('PASS: grouped ayahs play sequentially with zero page rebuilds or Arabic tile transfers; group boundary/backwards navigation and translation-only grouping work.');
}finally{
 await evaluate(`if(window.__groupOriginalBuild){__groupAudit.S.bridge.rebuildPageContainer=__groupOriginalBuild;__groupAudit.S.bridge.updateImageRawData=__groupOriginalImage;__groupAudit.S.bridge.textContainerUpgrade=__groupOriginalUpgrade;}`).catch(()=>{});
 phone.close();glasses.close();
}
