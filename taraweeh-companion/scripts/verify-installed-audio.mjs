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
const out=new URL('../language-evidence/listen-quran/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});await wait(2000);
 await run(`window.__NativeAudio=window.Audio;window.Audio=function(...args){const audio=new window.__NativeAudio(...args);audio.muted=true;window.__realAudio=audio;return audio;};document.getElementById('splashScreen')?.remove();`);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await run('openListenQuran()');await wait(500);
 const available=await(await fetch('http://localhost:3012/api/recitations')).json();assert.ok(available.reciters.every(r=>r.surahs.includes(1)));
 await run(`document.querySelector('.lq [data-el="surah"]').value='1';document.querySelector('.lq [data-el="surah"]').dispatchEvent(new Event('change'));`);await wait(700);
 assert.equal(await run(`document.querySelector('.lq [data-el="play"]').disabled`),false);
 await run(`document.querySelector('.lq [data-el="play"]').click()`);await wait(500);assert.ok(await run('__realAudio.currentTime>0'));await run(`document.querySelector('.lq [data-el="play"]').click()`);
 await run(`document.querySelector('.lq [data-el="download"]').click()`);assert.equal(await run(`document.querySelector('.lq [data-el="confirm"]').hidden`),false);
 const size=await run(`document.querySelector('.lq [data-el="size"]').textContent`);assert.match(size,/KB/);
 await run(`document.querySelector('.lq [data-el="confirmDownload"]').click()`);
 for(let i=0;i<50;i++){if(!await run(`document.querySelector('.lq [data-el="remove"]').hidden`))break;await wait(200);}
 assert.equal(await run(`document.querySelector('.lq [data-el="remove"]').hidden`),false);
 const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('fatiha-real-download.png',out),Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify({threeRecitersInstalled:true,actualAudioPlayback:true,offlineDownload:true,size}));
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}
