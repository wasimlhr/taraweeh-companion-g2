import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
const target=targets.find(t=>t.url.startsWith('http://localhost:3012/'));
const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0,paused;const pending=new Map();
ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
await new Promise(r=>ws.once('open',r));
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(200);}throw Error('Timed out: '+expression);}
async function attach(){
 await until('typeof window.applyLocalTranslation === "function"');await delay(500);await send('Debugger.enable');
 const fn=await send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),pause=new Promise(r=>paused=r),call=send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await pause).callFrames[0];
 await send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:`window.__providerAudit={S,saveSettings,reinitPipeline,refreshModelChoices};`});
 await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await send('Debugger.resume');await call;await send('Debugger.disable');
 await until(`getComputedStyle(document.getElementById('splashScreen')).display==='none'`);
}
const out=new URL('../language-evidence/jummah/providers/',import.meta.url);mkdirSync(out,{recursive:true});let original;
async function choose(id,value){await evaluate(`{const field=document.getElementById(${JSON.stringify(id)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('change'));}`);await delay(400);}
async function capture(name){const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'.png',out),Buffer.from(r.data,'base64'));}
try{
 await send('Page.reload',{ignoreCache:true});await attach();
 original=await evaluate(`({transcriptionProvider:__providerAudit.S.settings.transcriptionProvider,transcriptionModel:__providerAudit.S.settings.transcriptionModel,modelByProvider:__providerAudit.S.settings.modelByProvider||{}})`);
 await evaluate(`document.getElementById('sPillModel').click()`);
 assert.equal(await evaluate(`document.getElementById('settingsCategory').value`),'live');
 assert.equal(await evaluate(`document.querySelector('#settings-live details').id`),'recognitionSettings');
 assert.equal(await evaluate(`document.getElementById('recognitionSettings').open`),true);
 await evaluate(`window.__providerSent=[];window.__providerSend=__providerAudit.S.ws.send;__providerAudit.S.ws.send=function(raw){try{const m=JSON.parse(raw);if(m.type==='init')__providerSent.push({provider:m.transcriptionProvider,model:m.transcriptionModel});}catch(_){}return __providerSend.call(this,raw);};`);
 await choose('settingTranscribeProvider','groq');await choose('settingTranscribeModel','whisper-large-v3');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate(`window.scrollTo(0,0)`);await delay(200);await capture('groq-390');
 assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,'No horizontal overflow on phone');
 await choose('settingTranscribeProvider','elevenlabs');await choose('settingTranscribeModel','scribe_v2_realtime');
 assert.deepEqual(await evaluate('__providerSent.at(-1)'),{provider:'elevenlabs',model:'scribe_v2_realtime'});
 assert.equal(await evaluate(`getComputedStyle(document.getElementById('elevenlabsKeyRow')).display!=='none'&&getComputedStyle(document.getElementById('groqKeyRow')).display==='none'`),true);
 await capture('elevenlabs-390');await evaluate('__providerAudit.S.bridgeCallQueue');
 await send('Page.reload',{ignoreCache:true});await attach();await evaluate('openRecognitionSettings()');
 assert.equal(await evaluate(`document.getElementById('settingTranscribeProvider').value`),'elevenlabs');assert.equal(await evaluate(`document.getElementById('settingTranscribeModel').value`),'scribe_v2_realtime');
 await choose('settingTranscribeProvider','groq');assert.equal(await evaluate(`document.getElementById('settingTranscribeModel').value`),'whisper-large-v3');
 await send('Emulation.setDeviceMetricsOverride',{width:590,height:900,deviceScaleFactor:1,mobile:false});await evaluate('window.scrollTo(0,0)');await delay(200);await capture('groq-590');
 const result={passed:true,shortcutOpensLiveSettings:true,providerAndModelFirst:true,providerSpecificModels:true,outgoingProviderModelVerified:true,persistsAfterReload:true,modelRememberedPerProvider:true,noHorizontalOverflow390:true};writeFileSync(new URL('result.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
 if(original)await evaluate(`Object.assign(__providerAudit.S.settings,${JSON.stringify(original)});__providerAudit.refreshModelChoices();__providerAudit.saveSettings();__providerAudit.reinitPipeline();`).catch(()=>{});
 await send('Emulation.clearDeviceMetricsOverride').catch(()=>{});ws.close();
}
