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
const out=new URL('../language-evidence/stable-audio/',import.meta.url);mkdirSync(out,{recursive:true});
const standalone=process.argv.includes('--standalone');
async function choose(surah,ayah){
 await run(`(()=>{const s=document.querySelector('.lq [data-el="surah"]');s.value='${surah}';s.dispatchEvent(new Event('change'));})()`);
 for(let i=0;i<300;i++){
  if(await run(`!document.querySelector('.lq [data-el="ayah"]').disabled && (${surah}===1 || document.getElementById('versePos').textContent.includes('${surah}:'))`))break;
  await wait(200);
 }
 await run(`(()=>{const a=document.querySelector('.lq [data-el="ayah"]');a.value='${ayah}';a.dispatchEvent(new Event('change'));})()`);await wait(350);
}
try{
 await send('Page.navigate',{url:'http://localhost:3012/'+(standalone?'?standalone=1':'')});await wait(2300);
 await run(`window.__NativeAudio=window.Audio;window.Audio=function(...args){const a=new window.__NativeAudio(...args);a.muted=true;return a;};document.getElementById('splashScreen')?.remove();`);
 await run('openListenQuran()');await wait(600);assert.equal(await run(`document.querySelectorAll('.lq header').length`),0);
 const results=[];
 for(const height of [640,844]){
  await send('Emulation.setDeviceMetricsOverride',{width:390,height,deviceScaleFactor:1,mobile:false});await wait(200);
  let baseline;
  for(const [surah,ayah] of [[1,1],[13,1],[13,17]]){
   await choose(surah,ayah);
   const layout=await run(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};const text=document.getElementById('lockedContent'),primary=document.getElementById('recordBtn'),seek=document.querySelector('.lq-transport');const r=primary.getBoundingClientRect();return {card:box(document.getElementById('verseCard')),primary:box(primary),seek:box(seek),text:box(text),scroll:text.scrollHeight,client:text.clientHeight,pageHeight:document.documentElement.scrollHeight,buttonHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===primary}})()`);
   if(!baseline)baseline=layout;else for(const key of ['card','primary','seek'])for(const dimension of ['top','bottom','height'])assert.ok(Math.abs(layout[key][dimension]-baseline[key][dimension])<=1,JSON.stringify({key,dimension,layout,baseline}));
   console.log(JSON.stringify({height,surah,ayah,...layout}));const inspect=await send("Page.captureScreenshot",{format:"png"});writeFileSync(new URL("inspect.png",out),Buffer.from(inspect.data,"base64"));assert.ok(layout.text.height>=48);assert.equal(layout.buttonHit,true);assert.ok(layout.pageHeight<=height+3);
   if(surah===13&&ayah===17){assert.ok(layout.scroll>layout.client,'Long verse scrolls');await run(`document.getElementById('lockedContent').scrollTop=document.getElementById('lockedContent').scrollHeight;`);assert.ok(await run(`(()=>{const e=document.getElementById('lockedContent'),t=document.getElementById('verseTrans');return t.getBoundingClientRect().bottom<=e.getBoundingClientRect().bottom+2})()`),'Translation reachable without covering controls');await run(`document.getElementById('lockedContent').scrollTop=0`);}
   results.push({height,surah,ayah,...layout});
   const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(`${standalone?'standalone':'g2'}-${height}-${surah}-${ayah}.png`,out),Buffer.from(shot.data,'base64'));
  }
 }
 writeFileSync(new URL(standalone?'standalone-results.json':'g2-results.json',out),JSON.stringify(results,null,2));console.log('PASS stable card/header/primary/seek across short and long ayahs, full translation reachable, '+(standalone?'standalone':'G2'));
}finally{await send('Emulation.clearDeviceMetricsOverride');if(standalone)await send('Page.navigate',{url:'http://localhost:3012/'});ws.close();}

