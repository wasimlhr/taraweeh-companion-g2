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
const out=new URL('../language-evidence/audio-download-settings/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});await wait(2200);
 await run(`window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;window.__downloadAudio=a;return a;};document.getElementById('splashScreen')?.remove();`);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await run('openListenQuran()');await wait(500);
 assert.equal(await run(`document.querySelectorAll('#verseCard .lq-offline').length`),0);
 const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('clean-player.png',out),Buffer.from(shot.data,'base64'));
 await run(`document.getElementById('recordBtn').click()`);await wait(400);
 await run('showSettings()');await wait(200);
 assert.match(await run(`document.getElementById('audioPackLabel').textContent`),/Al-Fatiha/);
 assert.equal(await run(`getComputedStyle(document.getElementById('settingsView')).display`),'block');
 assert.ok(await run('__downloadAudio.currentTime>0'));assert.equal(await run('__downloadAudio.paused'),false);
 const exists=await run(`!document.querySelector('#listenDownloadControls [data-el="remove"]').hidden`);
 if(exists){await run(`document.querySelector('#listenDownloadControls [data-el="remove"]').click()`);await wait(200);}
 assert.equal(await run(`document.querySelector('#listenDownloadControls [data-el="download"]').hidden`),false);
 await run(`document.querySelector('#listenDownloadControls [data-el="download"]').click()`);
 assert.equal(await run(`document.querySelector('#listenDownloadControls [data-el="confirm"]').hidden`),false);
 await run(`document.querySelector('#listenDownloadControls [data-el="confirmDownload"]').click()`);
 for(let i=0;i<50;i++){if(!await run(`document.querySelector('#listenDownloadControls [data-el="remove"]').hidden`))break;await wait(200);}
 assert.equal(await run(`document.querySelector('#listenDownloadControls [data-el="remove"]').hidden`),false);
 await run(`document.getElementById('audioDownloadTitle').scrollIntoView({block:'center'});`);
 const settings=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('settings-downloads.png',out),Buffer.from(settings.data,'base64'));
 await run('hideSettings()');await wait(200);await run(`document.getElementById('recordBtn').click()`);
 console.log('PASS main free of download row; Settings download/remove; playback continues while Settings open');
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}
