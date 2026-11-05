import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(t){const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),pause:()=>new Promise(r=>paused=r),close:()=>ws.close()};}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
const out=new URL('../language-evidence/reader-navigation/',import.meta.url);mkdirSync(out,{recursive:true});
async function evaluate(expression){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression,seconds=20){for(let i=0;i<seconds*5;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);}
const settle=()=>new Promise(r=>setTimeout(r,600));
async function capture(name){await evaluate('__reciterAudit.S.bridgeCallQueue');await settle();for(const [kind,target]of [['glasses',glasses],['phone',phone]]){const r=await target.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'-'+kind+'.png',out),Buffer.from(r.data,'base64'));}}
async function select(field,value){await evaluate(`{const e=document.querySelector('.lq [data-el="${field}"]');e.value='${value}';e.dispatchEvent(new Event('change'));}`);}
async function download(){await evaluate(`document.querySelector('.lq [data-el="download"]').click();document.querySelector('.lq [data-el="confirmDownload"]').click();`);await until(`document.querySelector('.lq-offline [data-el="downloadStatus"]').textContent==='Available offline'`);}
try{
 await phone.send('Runtime.enable');
 await phone.send('Page.reload',{ignoreCache:true});await until('typeof window.applyLocalTranslation === "function"');await settle();await phone.send('Debugger.enable');
 const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),paused=phone.pause(),call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await paused).callFrames[0];
 await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`window.__reciterAudit={S,audio:()=>_audioVisual,page:()=>_readerPages[_readerPage],data:()=>_readerData,ready:()=>!_readerLoading,reader:()=>_readerActive};`});await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await phone.send('Debugger.resume');await call;await phone.send('Debugger.disable');
 async function audio(){await evaluate('openListenQuran()');await until(`__reciterAudit.audio()?.canPlay&&__reciterAudit.ready()&&!!document.getElementById('verseArabic').textContent`);}
 async function read(){await evaluate(`__reciterAudit.S.settings.readerSurah=3;__reciterAudit.S.settings.readerAyah=13;openQuranReader()`);await until(`__reciterAudit.reader()&&__reciterAudit.ready()&&__reciterAudit.data()?.surah===3&&document.querySelector('#readerText .reader-verse')`);await settle();
  const state=await evaluate(`({hidden:document.getElementById('readerView').hidden,display:getComputedStyle(document.getElementById('readerView')).display,width:document.getElementById('readerView').getBoundingClientRect().width,height:document.getElementById('readerView').getBoundingClientRect().height,main:getComputedStyle(document.getElementById('mainView')).display,settings:getComputedStyle(document.getElementById('settingsView')).display,status:document.getElementById('readerStatus').textContent})`);
  assert.equal(state.hidden,false);assert.notEqual(state.display,'none');assert.ok(state.width>0&&state.height>100);assert.equal(state.main,'none');assert.equal(state.settings,'none');return state;
 }
 await audio();await evaluate('showSettings();hideSettings()');const settingsToReader=await read();await capture('settings-back-to-reader');
 await evaluate('closeQuranReader()');assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('mainView')).display`),'none');
 await audio();const listenToReader=await read();await capture('listen-to-reader');
 await evaluate('closeQuranReader()');await audio();
 // Also recover a DOM left behind by an older running build.
 await evaluate(`document.getElementById('readerView').style.display='none'`);const recoveredLegacyHiddenView=await read();await capture('legacy-hidden-reader-recovered');
 const result={passed:true,version:await evaluate(`document.getElementById('versionEl').textContent`),settingsToReader,listenToReader,recoveredLegacyHiddenView,cycles:3};writeFileSync(new URL('runtime.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{phone.close();glasses.close();}
