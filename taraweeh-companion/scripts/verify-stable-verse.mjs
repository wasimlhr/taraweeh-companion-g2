/** UI acceptance through the real EvenHub simulator. Controlled verse states,
 * not audio-recognition or physical-hardware certification. */
import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { getVerseData } from '../backend/verseData.js';

const out = new URL('../language-evidence/ui-improvements/', import.meta.url);
mkdirSync(out, {recursive:true});
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let next=0, pending=new Map(), paused;
  socket.on('message',data=>{
    const msg=JSON.parse(data);
    if (msg.id) { const p=pending.get(msg.id); pending.delete(msg.id); if(msg.error)p.reject(Error(JSON.stringify(msg.error)));else p.resolve(msg.result); }
    else if(msg.method==='Debugger.paused')paused?.(msg.params);
  });
  return {
    ready:new Promise(resolve=>socket.once('open',resolve)),
    send(method,params={}) {return new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});},
    waitPause(){return new Promise(resolve=>{paused=resolve;});}, close(){socket.close();}
  };
}
const phone=connect(targets.find(t=>t.url.startsWith('http://localhost:3001/')));
const glasses=connect(targets.find(t=>t.url.includes('glasses.html')));
await Promise.all([phone.ready,glasses.ready]);
async function evaluate(expression) {
  const result=await phone.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,350));

await phone.send('Page.reload',{ignoreCache:true});await new Promise(r=>setTimeout(r,2200));
for(const height of [844,640]){
 await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height,deviceScaleFactor:1,mobile:true});
 await evaluate('document.getElementById("splashScreen")?.remove();document.getElementById("searchingContent").style.display="none";document.getElementById("lockedContent").style.display="block";document.getElementById("verseNavRow").style.display="flex"');
 const states=[];
 for(const [surah,ayah] of [[112,1],[2,282],[112,2]]){
  const verse=getVerseData(surah,ayah,'en');
  await evaluate(`document.getElementById('verseArabic').textContent=${JSON.stringify(verse.arabic)};document.getElementById('verseTrans').textContent=${JSON.stringify(verse.translation)};document.getElementById('verseTranslit').textContent=${JSON.stringify(verse.transliteration)};`);
  await settle();states.push(await evaluate('({card:document.getElementById("verseCard").getBoundingClientRect().height,nav:document.getElementById("verseNavRow").getBoundingClientRect().top,record:document.getElementById("recordBtn").getBoundingClientRect().top})'));
 }
 assert.deepEqual(states[0],states[1]);assert.deepEqual(states[1],states[2]);
 const shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('v3.4.31-stable-'+height+'.png',out),Buffer.from(shot.data,'base64'));
 console.log('PASS stable short/long/short verse layout at 390x'+height,states[0]);
}
phone.close();glasses.close();
