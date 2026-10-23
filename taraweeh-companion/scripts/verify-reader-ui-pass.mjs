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
const out=new URL('../language-evidence/reader-ui-pass/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});await wait(1800);
 await run('openQuranReader()');await run('setReaderRemote(false)');await wait(800);
 const results=[];
 for(const size of [{width:390,height:640},{width:590,height:800}]){
  await send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:false});
  await run("document.getElementById('readerDisplaySummary').click()");await wait(100);
  assert(await run("document.getElementById('readerDisplayOptions').open"));
  const bounds=await run("(()=>{const e=document.getElementById('readerOptionsPanel').getBoundingClientRect();return {left:e.left,right:e.right,bottom:e.bottom,height:innerHeight}})()");
  assert(bounds.left>=0&&bounds.right<=size.width&&bounds.bottom<=size.height-50,JSON.stringify(bounds));
  await click(8,180);
  assert.equal(await run("document.getElementById('readerDisplayOptions').open"),false,'Outside tap dismisses');
  assert.equal(await run("document.getElementById('readerDisplaySummary').getAttribute('aria-expanded')"),'false');
  await run("document.getElementById('readerDisplaySummary').click()");await wait(100);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(80);
  assert.equal(await run("document.getElementById('readerDisplayOptions').open"),false);
  assert.equal(await run("document.activeElement.id"),'readerDisplaySummary');
  const nav=await run("(()=>{const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return {prev:box('readerPrev'),next:box('readerNext'),page:box('readerPage')}})()");
  assert(Math.abs(nav.prev.width-nav.next.width)<1,JSON.stringify(nav));assert.equal(nav.prev.y,nav.next.y);assert.equal(nav.prev.height,44);assert(nav.next.right<=size.width);assert(Math.abs((nav.prev.x+nav.next.right)/2-(nav.page.x+nav.page.width/2))<1,'Navigation centered');
  results.push({size,bounds,nav,outsideDismiss:true,escapeDismiss:true,focusRestored:true});
  const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(`reader-${size.width}.png`,out),Buffer.from(shot.data,'base64'));
 }
 await run("document.getElementById('readerDisplaySummary').click();closeQuranReader()");
 assert.equal(await run("document.getElementById('readerDisplayOptions').open"),false,'Close reader dismisses options');
 await send('Emulation.clearDeviceMetricsOverride');await run('openQuranReader()');
 writeFileSync(new URL('results.json',out),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}

