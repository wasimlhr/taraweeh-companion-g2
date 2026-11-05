import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json(),target=targets.find(t=>t.url.startsWith('http://localhost:3012/'));
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let id=0,paused;
ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
await new Promise(r=>ws.once('open',r));
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const out=new URL('../language-evidence/missing-key-navigation/',import.meta.url);mkdirSync(out,{recursive:true});
try{
 await send('Page.reload',{ignoreCache:true});for(let n=0;n<100;n++){if(await evaluate('typeof window.applyLocalTranslation==="function"&&!document.getElementById("recordBtn").disabled'))break;await new Promise(r=>setTimeout(r,200));}
 await send('Debugger.enable');const fn=await send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),pause=new Promise(r=>paused=r),call=send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await pause).callFrames[0];
 await send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__keyAudit={S,save:saveSettings};window.__keyOriginal=S.settings;'});await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await send('Debugger.resume');await call;await send('Debugger.disable');
 assert.equal(await evaluate('__keyAudit.S.isRecording'),false);await new Promise(r=>setTimeout(r,1800));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await evaluate('window.__captureCalls=0;window.__oldMedia=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=()=>{__captureCalls++;throw Error("Unexpected capture")};window.__oldAudio=__keyAudit.S.bridge.audioControl;__keyAudit.S.bridge.audioControl=()=>{__captureCalls++;throw Error("Unexpected capture")};');
 const checks=[];
 for(const provider of ['groq','soniox','elevenlabs']){
  await evaluate('document.getElementById("settingsView").style.display="none";document.getElementById("mainView").style.display="block";__keyAudit.S.settings={...__keyOriginal,keyMode:"byok",transcriptionProvider:'+JSON.stringify(provider)+',groqApiKey:"",sonioxApiKey:"",elevenlabsApiKey:""};document.getElementById("settingsCategory").value="reading";document.getElementById("recognitionSettings").open=false;document.getElementById("recordBtn").click();');
  const check=await evaluate('(()=>{const field=document.activeElement,r=field.getBoundingClientRect();return {field:field.id,category:document.getElementById("settingsCategory").value,open:document.getElementById("recognitionSettings").open,visible:r.height>0&&r.top>=0&&r.bottom<=innerHeight,recording:__keyAudit.S.isRecording,captures:__captureCalls};})()');
  assert.equal(check.field,{groq:'settingGroqKey',soniox:'settingSonioxKey',elevenlabs:'settingElevenLabsKey'}[provider]);assert.equal(check.category,'live');assert.equal(check.open,true);assert.equal(check.visible,true);assert.equal(check.recording,false);assert.equal(check.captures,0);checks.push({provider,...check});
  const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(provider+'.png',out),Buffer.from(shot.data,'base64'));
 }
 writeFileSync(new URL('runtime.json',out),JSON.stringify({passed:true,checks},null,2));console.log('PASS: Start with no key opens, scrolls to and focuses the selected provider key; no microphone opens.');
}finally{
 await evaluate('if(window.__keyOriginal){__keyAudit.S.settings=__keyOriginal;__keyAudit.save();}if(window.__oldMedia)navigator.mediaDevices.getUserMedia=__oldMedia;if(window.__oldAudio)__keyAudit.S.bridge.audioControl=__oldAudio;').catch(()=>{});await send('Emulation.clearDeviceMetricsOverride').catch(()=>{});await send('Page.reload',{ignoreCache:true}).catch(()=>{});ws.close();
}
