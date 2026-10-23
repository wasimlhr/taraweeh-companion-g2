import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
const target=targets.find(t=>t.url.startsWith('http://localhost:3012/'));
assert(target,'Owned simulator phone must be open');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
let n=0;const pending=new Map();ws.on('message',d=>{const m=JSON.parse(d);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const run=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const click=async(x,y)=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});await wait(100);};
const out=new URL('../language-evidence/integrated-audio/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});await wait(2200);
 await run(`window.__OriginalAudio=window.Audio;window.Audio=function(...args){const audio=new window.__OriginalAudio(...args);audio.muted=true;window.__embeddedAudio=audio;return audio;};document.getElementById('splashScreen')?.remove();`);
 await run('openListenQuran()');await wait(800);
 for(const height of [640,844]){
  await send('Emulation.setDeviceMetricsOverride',{width:390,height,deviceScaleFactor:1,mobile:false});await wait(250);
  const layout=await run(`(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};return {main:getComputedStyle(document.getElementById('mainView')).display,card:rect('verseCard'),text:rect('lockedContent'),primary:rect('recordBtn'),footer:rect('versionEl'),scroll:document.documentElement.scrollHeight,viewport:innerHeight,icons:document.querySelectorAll('#btnModeAudio svg').length}})()`);
  const capture=await send("Page.captureScreenshot",{format:"png"});writeFileSync(new URL("main-"+height+".png",out),Buffer.from(capture.data,"base64"));console.log(JSON.stringify({height,...layout}));assert.notEqual(layout.main,'none');assert.equal(layout.icons,1);assert.ok(layout.primary.bottom<=height);assert.ok(layout.text.height>=48,'Verse stays usable');assert.ok(layout.scroll<=height+3,'Main fits viewport');
  const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('main-'+height+'.png',out),Buffer.from(shot.data,'base64'));
 }
 await run(`document.getElementById('recordBtn').click()`);await wait(700);assert.ok(await run('__embeddedAudio.currentTime>0'));assert.match(await run(`document.getElementById('recordBtn').textContent`),/Pause/);
 await run(`document.getElementById('recordBtn').click()`);const at=await run('__embeddedAudio.currentTime');await wait(200);assert.ok(Math.abs(await run('__embeddedAudio.currentTime')-at)<.1);
 await run(`document.getElementById('btnModePractice').click()`);assert.equal(await run(`document.getElementById('mainView').dataset.audio`),'false');assert.equal(await run('__embeddedAudio.paused'),true);assert.match(await run(`document.getElementById('recordBtn').textContent`),/Start Listening/);
 await run('openListenQuran()');console.log('PASS main screen integration, playback primary, mode switch cleanup');
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}

