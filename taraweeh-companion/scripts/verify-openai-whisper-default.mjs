import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const target=(await(await fetch('http://127.0.0.1:9222/json/list')).json()).find(t=>t.url.startsWith('http://localhost:3012/'));
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let id=0,paused;
ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Debugger.paused')paused(m.params);});
await new Promise(r=>ws.once('open',r));
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const out=new URL('../language-evidence/openai-whisper-default/',import.meta.url);
try{
 for(let n=0;n<40;n++){if(await evaluate('typeof window.applyLocalTranslation==="function"'))break;await new Promise(r=>setTimeout(r,200));}
 await send('Debugger.enable');const fn=await send('Runtime.evaluate',{expression:'window.applyLocalTranslation'}),bp=await send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId}),pause=new Promise(r=>paused=r),call=send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'}),frame=(await pause).callFrames[0];
 await send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:'window.__whisperAudit={S,migrate:migrateModelDefaults,payload:sttPayload,restore:()=>{S.settings=window.__whisperOriginal;saveSettings();refreshModelChoices();}};window.__whisperOriginal=S.settings;'});
 await send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});await send('Debugger.resume');await call;await send('Debugger.disable');
 const checks=await evaluate(`(()=>{
  const audit=__whisperAudit,results={};
  const inspect=()=>({provider:audit.payload().transcriptionProvider,model:audit.payload().transcriptionModel,picker:document.getElementById('settingTranscribeModel').value,hint:document.getElementById('modelHint').textContent});
  audit.S.settings=audit.migrate({...audit.S.settings,transcriptionProvider:'openai',transcriptionModel:'',modelByProvider:{},openaiWhisperDefault:undefined});refreshModelChoices();results.fresh=inspect();
  audit.S.settings=audit.migrate({...audit.S.settings,transcriptionModel:'gpt-4o-mini-transcribe',modelByProvider:{openai:'gpt-4o-mini-transcribe'},openaiWhisperDefault:undefined});refreshModelChoices();results.migrated=inspect();
  results.recording=audit.S.isRecording;showSettings();selectSettingsSection('live');document.getElementById('recognitionSettings').open=true;document.getElementById('settingTranscribeModel').scrollIntoView({block:'center'});const rect=document.getElementById('settingTranscribeModel').getBoundingClientRect();results.pickerVisible=rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight;return results;
 })()`);
 for(const key of ['fresh','migrated']){assert.equal(checks[key].provider,'openai');assert.equal(checks[key].model,'whisper-1');assert.equal(checks[key].picker,'whisper-1');assert.match(checks[key].hint,/Whisper.*word timings/);}
 assert.equal(checks.recording,false);
 assert.equal(checks.pickerVisible,true);
 await new Promise(r=>setTimeout(r,400));const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('settings-whisper-default.png',out),Buffer.from(shot.data,'base64'));
 writeFileSync(new URL('runtime.json',out),JSON.stringify({passed:true,...checks,paidTranscriptionRequests:0},null,2));console.log('PASS: actual app picker and outgoing payload use whisper-1 for fresh and migrated settings; microphone stayed off.');
}finally{await evaluate('if(window.__whisperOriginal)__whisperAudit.restore()').catch(()=>{});ws.close();}
