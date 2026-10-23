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
const out=new URL('../language-evidence/listen-translation/',import.meta.url);mkdirSync(out,{recursive:true});
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
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__homeAudit={S,prefs:()=>({display:listenGlassesDisplay(),language:listenTranslationLanguage(),global:S.settings.lang,picking:_listenLanguagePicking,dataLanguage:_readerData?.translationLang}),kind:()=>_readerPages[_readerPage]?.kind,page:()=>({index:_readerPage,header:_readerPages[_readerPage]?.header,ayah:_readerPages[_readerPage]?.ayah,parts:_readerPages.filter(p=>p.ayahs.includes(Number(document.getElementById("readerAyah").value))).map(p=>({index:_readerPages.indexOf(p),arabic:p.lines,translation:p.translationLines})),loading:_readerLoading}),pageAt:(ms,duration)=>_readerModule.readerAudioPage(_readerPages,Number(document.getElementById("readerAyah").value),ms,duration),showModeHome,glassesTopBarUpdate,refreshGlassesWelcomeText,audio:()=>({state:_audioVisual,footer:_audioFooterLayout,tiles:_readerLastTiles.map(t=>t?.length)}),home:()=>({active:_homeActive,index:_homeIndex,layout:_homeLayout}),reader:()=>_readerActive,picker:()=>({kind:_readerPicking,value:_readerPick,surah:_readerData?.surah,loading:_readerLoading,layout:_readerImageLayout}),recent:()=>_diagLog.slice(-8),glassesMenu};'});
 await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 await evaluate(`__homeAudit.S.settings.readerGlassesTranslation=true;window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;window.__miniAudio=a;return a;};`);
 await evaluate('openListenQuran()');await settle();
 await evaluate(`{const s=document.querySelector('.lq [data-el="surah"]');s.value='10';s.dispatchEvent(new Event('change'));}`);
 for(let i=0;i<200;i++){if(await evaluate(`!document.querySelector('.lq [data-el="ayah"]').disabled && document.getElementById('versePos').textContent.includes('10:')`))break;await new Promise(r=>setTimeout(r,200));}
 await evaluate(`{const a=document.querySelector('.lq [data-el="ayah"]');a.value='2';a.dispatchEvent(new Event('change'));}`);await settle();
 const original=await evaluate('__homeAudit.prefs()');await evaluate(`document.querySelector('.lq [data-el="play"]').click()`);await settle();
 const media=await evaluate('({src:__miniAudio.src,time:__miniAudio.currentTime})');
 await evaluate('showSettings()');await evaluate(`{const s=document.getElementById('listenGlassesDisplay');s.value='translation';s.dispatchEvent(new Event('change'));}`);await settle();
 await evaluate(`{const l=document.getElementById('listenTranslationLanguage');l.value='nl';l.dispatchEvent(new Event('change'));}`);await settle();
 assert.equal(await evaluate('__homeAudit.kind()'),'translation-only');assert.equal((await evaluate('__homeAudit.prefs()')).dataLanguage,'nl');assert.equal(await evaluate('__miniAudio.paused'),false);assert.equal(await evaluate('__miniAudio.src'),media.src);assert.ok(await evaluate('__miniAudio.currentTime')>media.time);
 await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});const phoneShot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('app-options.png',out),Buffer.from(phoneShot.data,'base64'));await phone.send('Emulation.clearDeviceMetricsOverride');
 await screenshot('dutch-only');await evaluate('hideSettings()');
 async function menu(index){await input('context_menu');for(let n=0;n<index;n++)await input('down');await input('click');await settle();}
 await menu(3);assert.equal((await evaluate('__homeAudit.prefs()')).display,'arabic-translation');assert.equal(await evaluate('__homeAudit.kind()'),'interleaved');await screenshot('arabic-restored');
 await menu(3);assert.equal((await evaluate('__homeAudit.prefs()')).display,'translation');await menu(4);assert.equal((await evaluate('__homeAudit.prefs()')).picking,true);await screenshot('language-picker');
 const options=await evaluate(`[...document.getElementById('listenTranslationLanguage').options].map(o=>o.value)`);const steps=options.indexOf('fr')-options.indexOf('nl');assert.ok(steps>0&&steps<8);for(let n=0;n<steps;n++)await input('down');await input('click');await settle();
 const selected=await evaluate('__homeAudit.prefs()');assert.equal(selected.language,'fr');assert.equal(selected.dataLanguage,'fr');assert.equal(selected.global,original.global);assert.equal(selected.picking,false);assert.equal(await evaluate('__homeAudit.kind()'),'translation-only');assert.equal(await evaluate('__miniAudio.paused'),false);assert.equal(await evaluate(`document.getElementById('listenTranslationLanguage').value`),'fr');await screenshot('french-only');
 await menu(4);await input('context_menu');await input('click');assert.equal((await evaluate('__homeAudit.prefs()')).picking,false);assert.equal(await evaluate('__miniAudio.paused'),false);
 const reconnectAt=await evaluate('__miniAudio.currentTime');await evaluate('__homeAudit.S.ws.close()');for(let i=0;i<50;i++){if(await evaluate('__homeAudit.S.ws?.readyState===1'))break;await new Promise(r=>setTimeout(r,200));}assert.equal(await evaluate('__miniAudio.paused'),false);assert.ok(await evaluate('__miniAudio.currentTime')>reconnectAt);assert.equal((await evaluate('__homeAudit.prefs()')).display,'translation');await evaluate('__miniAudio.pause()');await phone.send('Page.reload',{ignoreCache:true});await new Promise(r=>setTimeout(r,2000));await evaluate('showSettings();selectSettingsSection("audio")');assert.equal(await evaluate('document.getElementById("listenGlassesDisplay").value'),'translation');assert.equal(await evaluate('document.getElementById("listenTranslationLanguage").value'),'fr');
 console.log('PASS app translation-only and Dutch; real glasses menu restores Arabic and selects French; cancel returns to playback; audio survives Settings and backend reconnection; other-mode language unchanged; choices persist after reload.');
}finally{phone.close();glasses.close();}
