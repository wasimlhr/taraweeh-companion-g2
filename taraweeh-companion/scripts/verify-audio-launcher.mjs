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
 await send('Page.reload',{ignoreCache:true});await wait(2500);
 const glasses=targets.find(t=>t.url.includes('glasses.html'));const g=new WebSocket(glasses.webSocketDebuggerUrl);await new Promise(r=>g.once('open',r));
 const shot=new Promise(resolve=>g.once('message',raw=>resolve(JSON.parse(raw))));g.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png'}}));const reply=await shot;writeFileSync(new URL('six-mode-launcher.png',out),Buffer.from(reply.result.data,'base64'));g.close();
 await run('openListenQuran()');await wait(300);
 assert.equal(await run(`document.querySelector('.lq [data-el="status"]').textContent`),'Audio pack not installed yet');
 assert.equal(await run(`document.querySelector('.lq [data-el="reciter"]').options.length`),3);
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
 const empty=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('player-empty.png',out),Buffer.from(empty.data,'base64'));
 await send('Emulation.clearDeviceMetricsOverride');console.log('PASS three reciters; real unavailable state; six-mode launcher captured');
}finally{ws.close();}
