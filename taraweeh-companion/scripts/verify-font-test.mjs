import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/font-test/',import.meta.url);mkdirSync(out,{recursive:true});
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


let original;
async function attach(){
 await until('typeof window.applyLocalTranslation === "function"');await settle();await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__reciterAudit=window.__fontAudit={S,event:onG2Event,active:()=>_fontTestActive,test:()=>_fontTestUI,save:saveSettings,font:readerFont,audio:()=>_audioVisual,data:()=>_readerData,pages:()=>_readerPages,page:()=>_readerPages[_readerPage],native:()=>_readerNativeText,ready:()=>!_readerLoading&&_audioVisual?.canPlay&&_audioSyncKey===listenSyncKey(_audioVisual),picker:()=>_glassesSettings,openMenu:openGlassesSettings};'});await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
}
async function previewReady(){await until('__fontAudit.active()&&!document.querySelector("[data-font-status]").textContent.includes("Preparing")');await evaluate('__fontAudit.S.bridgeCallQueue');await settle();}
async function sampleHash(){const r=await glasses.send('Runtime.evaluate',{expression:'(()=>{const c=document.createElement("canvas");c.width=576;c.height=288;const x=c.getContext("2d");x.drawImage(document.getElementById("layer-bright"),0,0,576,288);let hash=2166136261,ink=0;for(const byte of x.getImageData(24,68,528,174).data)hash=Math.imul(hash^byte,16777619)>>>0;const d=x.getImageData(24,68,528,174).data;for(let i=0;i<d.length;i+=4)if(d[i+1]>40)ink++;return {hash,ink};})()',returnByValue:true});return r.result.value;}
try{
 await phone.send('Page.reload',{ignoreCache:true});await attach();
 original=await evaluate('Object.fromEntries(["glassesArabicSize","glassesArabicFont","glassesArabicRendering","readerScript","readerSurah","readerAyah","readerPage"].filter(k=>Object.hasOwn(__fontAudit.S.settings,k)).map(k=>[k,__fontAudit.S.settings[k]]))');
 await evaluate('showSettings();selectSettingsSection("reading");');await evaluate('openFontTest()');await previewReady();
 assert.equal(await evaluate('document.querySelectorAll(".font-test-sample").length'),3);
 const hashes=[];
 for(const [font,index]of [['indopak',0],['amiri',1],['duri',2]]){
  await evaluate('document.querySelectorAll(".font-test-sample button")['+index+'].click()');await previewReady();
  const snap=await evaluate('__fontAudit.test().snapshot()');assert.equal(snap.font,font);const pixels=await sampleHash();assert.ok(pixels.ink>400);hashes.push(pixels.hash);await capture(font+'-28');
 }
 assert.equal(new Set(hashes).size,3,'Every font must change the actual glasses sample');
 for(const size of [24,28,32,36]){await evaluate('document.querySelector("[data-font-size]").value="'+size+'";document.querySelector("[data-font-size]").dispatchEvent(new Event("change"))');await previewReady();assert.equal(await evaluate('__fontAudit.test().snapshot().glassesArabicSize'),size);assert.ok((await sampleHash()).ink>400);}
 await evaluate('__fontAudit.event({menuItemClickEvent:{itemID:62}})');await previewReady();assert.equal(await evaluate('__fontAudit.test().snapshot().font'),'amiri');
 await evaluate('__fontAudit.event({menuItemClickEvent:{itemID:64}})');await previewReady();assert.equal(await evaluate('__fontAudit.test().snapshot().glassesArabicSize'),32);
 const renderingHashes=[];
 for(const id of ['standard','bright','supersampled']){await evaluate('document.querySelector("[data-font-rendering]").value="'+id+'";document.querySelector("[data-font-rendering]").dispatchEvent(new Event("change"))');await previewReady();renderingHashes.push((await sampleHash()).hash);await capture('amiri-32-'+id);}
 assert.equal(new Set(renderingHashes).size,3,'Rendering choices must affect the actual frame');
 await evaluate('document.querySelector("[data-font-rendering]").value="bright";document.querySelector("[data-font-rendering]").dispatchEvent(new Event("change"))');await previewReady();await evaluate('__fontAudit.event({menuItemClickEvent:{itemID:66}})');await settle();assert.equal(await evaluate('__fontAudit.S.settings.glassesArabicSize'),32);assert.equal(await evaluate('__fontAudit.S.settings.glassesArabicFont'),'amiri');assert.equal(await evaluate('__fontAudit.S.settings.glassesArabicRendering'),'bright');
 await evaluate('closeFontTest()');assert.equal(await evaluate('document.getElementById("fontTestView").hidden'),true);
 await phone.send('Page.reload',{ignoreCache:true});await attach();assert.equal(await evaluate('__fontAudit.S.settings.glassesArabicSize'),32);assert.equal(await evaluate('__fontAudit.S.settings.glassesArabicRendering'),'bright');
 await evaluate('__fontAudit.S.settings.readerSurah=112;__fontAudit.S.settings.readerAyah=1;openQuranReader()');await until('__fontAudit.data()?.surah===112&&__fontAudit.pages().length>0');await evaluate('__fontAudit.S.bridgeCallQueue');await settle();assert.equal(await evaluate('__fontAudit.font()'),'QuranBitmap');await capture('reader-32-bright');
 await evaluate('showSettings();openFontTest()');await previewReady();await evaluate('__fontAudit.event({menuItemClickEvent:{itemID:67}})');await until('!__fontAudit.active()');assert.equal(await evaluate('__fontAudit.data().surah'),112);
 await evaluate('closeQuranReader();openListenQuran()');await until('__fontAudit.ready()',60);
 await select('reciter','noreen-muhammad-siddiq');await until('__fontAudit.audio()?.reciter==="noreen-muhammad-siddiq"&&__fontAudit.ready()',60);await select('surah','112');await until('__fontAudit.audio()?.surah===112&&__fontAudit.ready()',60);
 for(const px of [24,28,32,36]){await evaluate('setGlassesTypography("glassesArabicSize",'+px+')');assert.equal(await evaluate('__fontAudit.font()'),'QuranDuri');assert.ok((await evaluate('__fontAudit.native()')).length>0);await capture('noreen-112-'+px);}
 await evaluate('setGlassesTypography("glassesArabicRendering","supersampled")');await capture('noreen-112-36-smooth');await evaluate('openFontTest()');await previewReady();assert.equal(await evaluate('__fontAudit.test().snapshot().font'),'duri');await evaluate('closeFontTest()');assert.equal(await evaluate('__fontAudit.audio().surah'),112);await evaluate('closeListenQuran()');
 await evaluate('closeQuranReader();showSettings();__fontAudit.openMenu();');await evaluate('__fontAudit.event({textEvent:{eventType:2}});__fontAudit.event({textEvent:{eventType:2}});__fontAudit.event({textEvent:{eventType:2}});__fontAudit.event({textEvent:{eventType:2}});__fontAudit.event({textEvent:{eventType:0}})');await previewReady();await capture('opened-from-glasses-settings');
 for(const width of [390,600]){await phone.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});await evaluate('scrollTo(0,0)');assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await capture('page-'+width);}
 const result={passed:true,fonts:['indopak','amiri','duri'],sizes:[24,28,32,36],renderings:['standard','bright','supersampled'],distinctActualFontFrames:true,distinctActualRenderingFrames:true,savesAcrossReload:true,readerUsesSavedPreferences:true,noreenKeepsDuriAtAllSizes:true,noreenReturnsFromFontTest:true,glassesSettingsEntry:true,nativeMenuControls:true,responsiveWidths:[390,600]};writeFileSync(new URL('runtime.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 await phone.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
 if(original)await evaluate('for(const k of ["glassesArabicSize","glassesArabicFont","glassesArabicRendering","readerScript","readerSurah","readerAyah","readerPage"])delete __fontAudit.S.settings[k];Object.assign(__fontAudit.S.settings,'+JSON.stringify(original)+');__fontAudit.save();__fontAudit.test()?.open(__fontAudit.S.settings,"indopak");').catch(()=>{});
 phone.close();glasses.close();
}
