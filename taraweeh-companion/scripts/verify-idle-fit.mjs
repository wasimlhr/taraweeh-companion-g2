import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target=targets.find(t=>t.url.startsWith('http://localhost:3012/'));
assert.ok(target,'Launch the owned simulator at localhost:3012 first');
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
let id=0;const pending=new Map();ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const out=new URL('../language-evidence/idle-fit/',import.meta.url);mkdirSync(out,{recursive:true});
await send('Page.reload',{ignoreCache:true});
for(let i=0;i<50;i++){if(await evaluate("document.readyState==='complete' && !!document.getElementById('mainView')?.dataset.listening"))break;await new Promise(r=>setTimeout(r,100));}
const results=[];
try{
for(const height of [640,844])for(const theme of ['light','dark'])for(const mode of ['listen','practice','taraweeh']){
 await send('Emulation.setDeviceMetricsOverride',{width:390,height,deviceScaleFactor:1,mobile:true});
 await evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});document.getElementById('splashScreen')?.remove();window.setReciteMode(${JSON.stringify(mode)});window.scrollTo(0,0);`);
 await new Promise(r=>setTimeout(r,180));
 const data=await evaluate(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return {top:b.top,bottom:b.bottom,height:b.height}};return {height:innerHeight,scrollHeight:document.documentElement.scrollHeight,card:r(document.getElementById('verseCard')),start:r(document.getElementById('recordBtn')),footer:r(document.getElementById('versionEl')),pace:document.getElementById('paceModeBtn').textContent}})()`);
 results.push({height,theme,mode,...data});
 if(mode==='listen'){const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(`idle-${theme}-${height}.png`,out),Buffer.from(shot.data,'base64'));}
 if(!process.argv.includes('--inspect')){assert.ok(data.scrollHeight<=data.height+2,JSON.stringify(data));assert.ok(data.start.bottom<=data.height,JSON.stringify(data));assert.match(data.pace,/Normal/);}
}
// Exercise yellow candidate/preamble surfaces independently from microphone capture.
const colors=await evaluate(`(()=>{const pre=document.getElementById('matchPreamble');pre.style.display='flex';pre.querySelector('#matchPreambleLabel').textContent='Bismillah';const sample=document.createElement('div');sample.className='match-cand top';sample.innerHTML='<span class="match-cand-ref">Al-Fatihah</span><span class="match-cand-arabic">بسم الله</span><span class="match-cand-score">69%</span>';document.body.appendChild(sample);const result=[pre,pre.querySelector('.ar'),...sample.children].map(el=>({class:el.className,color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));sample.remove();pre.style.display='none';return result})()`);
console.log(JSON.stringify({results,colors},null,2));
if(!process.argv.includes('--inspect'))for(const c of colors)assert.notEqual(c.color,'rgb(255, 255, 255)',JSON.stringify(c));
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}
