import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target){const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});return {ready:new Promise(r=>ws.once('open',r)),send:(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));}),close:()=>ws.close()};}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3012/'))),glasses=connect(targets.find(t=>t.url.includes('glasses.html')));await Promise.all([phone.ready,glasses.ready]);
async function evaluate(expression,userGesture=false){const r=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const wait=ms=>new Promise(r=>setTimeout(r,ms)),out=new URL('../language-evidence/audio-probe/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await phone.send('Page.navigate',{url:'http://localhost:3012/audio-playback-test.html'});
 for(let i=0;i<50;i++){if(await evaluate('!!document.getElementById("probeAudio") && document.getElementById("glasses").textContent.startsWith("Glasses connected")'))break;await wait(100);}
 assert.match(await evaluate('document.getElementById("glasses").textContent'),/Glasses connected/);
 await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 // Decode and advance real HTML media while muted on the development PC.
 await evaluate('document.getElementById("probeAudio").muted=true;document.getElementById("play").click()',true);await wait(1800);
 const playing=await evaluate('({paused:document.getElementById("probeAudio").paused,time:document.getElementById("probeAudio").currentTime,duration:document.getElementById("probeAudio").duration})');
 assert.equal(playing.paused,false);assert.ok(playing.time>1);assert.equal(playing.duration,120);
 const g=await glasses.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('glasses-playing.png',out),Buffer.from(g.data,'base64'));
 await evaluate('document.getElementById("play").click()',true);const paused=await evaluate('document.getElementById("probeAudio").currentTime');await wait(700);assert.equal(await evaluate('document.getElementById("probeAudio").currentTime'),paused);
 await evaluate('document.getElementById("stop").click()',true);assert.equal(await evaluate('document.getElementById("probeAudio").currentTime'),0);
 const log=await evaluate('JSON.parse(localStorage.getItem("quran_audio_probe_v1"))');assert.ok(log.events.some(e=>e.event==='playing'));assert.ok(log.events.some(e=>e.event==='pause'));assert.ok(log.events.some(e=>e.event==='stop'));assert.ok(log.events.every(e=>!('audio' in e)));
 const p=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('phone-controls.png',out),Buffer.from(p.data,'base64'));writeFileSync(new URL('local-result.json',out),JSON.stringify({playing,log},null,2));
 console.log('PASS: generated WAV decodes, HTML audio advances, pause holds position, Stop resets, glasses render, and results persist. Bluetooth and Android lock-screen behavior require physical testing.');
}finally{await phone.send('Emulation.clearDeviceMetricsOverride');await phone.send('Page.navigate',{url:'http://localhost:3012/'});phone.close();glasses.close();}
