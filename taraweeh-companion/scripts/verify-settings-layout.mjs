import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
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
const out=new URL('../language-evidence/settings-pass/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});await wait(2000);await run('showSettings()');
 const old=execFileSync('git',['show','HEAD:taraweeh-companion/app/index.html'],{encoding:'utf8'}),current=readFileSync(new URL('../app/index.html',import.meta.url),'utf8');
 const inventory=html=>`(()=>{const d=new DOMParser().parseFromString(${JSON.stringify(html)},'text/html');return [...d.querySelectorAll('#settingsView input[id],#settingsView select[id],#settingsView button[id]')].map(e=>({id:e.id,onchange:e.getAttribute('onchange'),oninput:e.getAttribute('oninput'),onclick:e.getAttribute('onclick')})).sort((a,b)=>a.id.localeCompare(b.id));})()`;
 const before=(await run(inventory(old))).filter(e=>e.id!=='settingsCategory'),after=(await run(inventory(current))).filter(e=>e.id!=='settingsCategory');assert.deepEqual(after,before,'Existing controls and handlers retained');
 assert.deepEqual(await run(`[...document.querySelectorAll('[id]')].map(e=>e.id).filter((id,i,a)=>a.indexOf(id)!==i)`),[],'No duplicate control IDs');
 const membership={settingLang:'reading',settingPhoneTextSize:'reading',settingStudyTafsir:'study',settingHadithLanguage:'study',settingGroqKey:'live',settingTranscribeModel:'live',settingMicTest:'live',audioPackLabel:'audio',settingBackendUrl:'support'};
 for(const[id,category]of Object.entries(membership))assert.equal(await run(`document.getElementById('${id}').closest('[data-settings-panel]').dataset.settingsPanel`),category);
 for(const [width,height,theme]of [[320,640,'dark'],[390,844,'dark'],[768,900,'light']]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await run(`document.documentElement.setAttribute('data-theme','${theme}')`);
  for(const category of ['reading','live','audio','study','support']){
   await run(`(()=>{const s=document.getElementById('settingsCategory');s.value='${category}';s.dispatchEvent(new Event('change'));})()`);
   assert.deepEqual(await run(`[...document.querySelectorAll('[data-settings-panel]')].filter(e=>!e.hidden).map(e=>e.dataset.settingsPanel)`),[category]);
   await run(`document.querySelectorAll('[data-settings-panel="${category}"] .settings-group').forEach(d=>d.open=true)`);
   const overflow=await run('document.documentElement.scrollWidth>innerWidth');assert.equal(overflow,false,category+' fits '+width);
   if(width===390){await run(`document.querySelectorAll('[data-settings-panel="${category}"] .settings-group').forEach((d,i)=>d.open=${JSON.stringify(category==='reading'||category==='study')}&&i===0)`);const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(category+'.png',out),Buffer.from(shot.data,'base64'));}
  }
 }
 await run(`document.documentElement.setAttribute('data-theme','dark');selectSettingsSection('reading');`);
 const previous=await run('document.getElementById("settingPhoneTextSize").value');const changed=previous==='18'?'20':'18';
 await run(`(()=>{const input=document.getElementById('settingPhoneTextSize');input.value='${changed}';input.dispatchEvent(new Event('input'));})()`);await run('hideSettings();showSettings()');assert.equal(await run('document.getElementById("settingPhoneTextSize").value'),changed);await run('setPhoneTextSize('+Number(previous)+')');
 await run(`document.querySelector('#settingsView .settings-header button').click()`);assert.equal(await run(`getComputedStyle(document.getElementById('mainView')).display`),'block');
 await run(`showSettings();selectSettingsSection('reading');document.querySelectorAll('[data-settings-panel]').forEach(p=>p.querySelectorAll('.settings-group').forEach((d,i)=>d.open=['reading','study'].includes(p.dataset.settingsPanel)&&i===0));`);
 console.log('PASS: control/handler inventory retained; all five sections; no overflow at 320/390/768; dark/light; phone size saves; Back works.');
}finally{await send('Emulation.clearDeviceMetricsOverride');ws.close();}
