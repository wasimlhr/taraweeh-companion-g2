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
async function input(action) {
  const response=await fetch('http://127.0.0.1:9898/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  assert.equal(response.ok,true);await settle();
}
async function selectMenu(index) {
  // The native overlay debounces rapid reopen gestures after dismissal.
  await new Promise(resolve=>setTimeout(resolve,800));
  await input('context_menu');
  for(let i=0;i<index;i++)await input('down');
  await input('click');
}
await phone.send('Page.reload',{ignoreCache:true});
for(let attempt=0;attempt<20;attempt++) {
  await new Promise(resolve=>setTimeout(resolve,500));
  if(await evaluate('typeof window.applyLocalTranslation === "function"'))break;
}
assert.equal(await evaluate('typeof window.applyLocalTranslation'), 'function', 'App must finish loading before inspection');
await new Promise(resolve=>setTimeout(resolve,1200));
await phone.send('Debugger.enable');
const fn=await phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation'});
const bp=await phone.send('Debugger.setBreakpointOnFunctionCall',{objectId:fn.result.objectId});
const paused=phone.waitPause();
const call=phone.send('Runtime.evaluate',{expression:'window.applyLocalTranslation(null)'});
const frame=(await paused).callFrames[0];
const injection=await phone.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:
  'window.__uiAudit={S,loadSettings,handleServerMsg,stopPageFlip,stopCountdown,glassesMenu,onG2Event,ensureLangPack,glassesStartup,ensureArabicFont,arabicImageCanvas,stopListening,buildGlassesText,getHeld:function(){return _readingHeld;},getHeldPage:function(){return _heldPage;}}; __uiAudit.imageResults=[]; __uiAudit.originalImage=S.bridge.updateImageRawData.bind(S.bridge); S.bridge.updateImageRawData=async function(data){var result=await __uiAudit.originalImage(data);__uiAudit.imageResults.push({id:data.containerID,length:data.imageData.length,result:result});return result;};'});
if(injection.exceptionDetails)throw Error(JSON.stringify(injection.exceptionDetails));
await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await phone.send('Debugger.resume'); await call; await phone.send('Debugger.disable');

const savedBackend=await evaluate('__uiAudit.S.settings.backendUrl');
await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await evaluate(`__uiAudit.S.settings.studyTafsir=266;__uiAudit.S.settings.studyHadithLanguage='English';__uiAudit.S.settings.studyHadithEdition='eng-bukhari';__uiAudit.S.settings.backendUrl='http://localhost:18001';__uiAudit.handleServerMsg({type:'state',state:{mode:'LOCKED',surah:1,ayah:2,surahName:'Al-Fatihah',totalAyahs:7,arabic:'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَـٰلَمِينَ',translation:'All praise is for Allah—Lord of all worlds.',transliteration:'Al-hamdu lillahi rabbil-alamin',confidence:1}});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();`);
await evaluate('document.getElementById("verseCard").scrollIntoView({block:"start"})');
await new Promise(r=>setTimeout(r,200));
await evaluate('openWordMeaning(3)');
await new Promise(r=>setTimeout(r,1300));
console.log(await evaluate('document.getElementById("wordMeaningText").textContent'));
assert.equal(await evaluate('document.getElementById("wordMeaning").hidden'),false);
assert.equal(await evaluate('getComputedStyle(document.getElementById("wordMeaning")).position'),'fixed');
let shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('../language-evidence/ui-improvements/word-meaning-phone.png',import.meta.url),Buffer.from(shot.data,'base64'));
await evaluate('expandWordMeaning()');await new Promise(r=>setTimeout(r,400));
shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('../language-evidence/ui-improvements/word-details-phone.png',import.meta.url),Buffer.from(shot.data,'base64'));
await evaluate('loadStudy("tafsir")');await new Promise(r=>setTimeout(r,1300));
console.log(await evaluate('document.getElementById("studyContent").textContent.slice(0,120)'));
await evaluate('document.getElementById("studyPanel").scrollIntoView({block:"start"})');
shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('../language-evidence/ui-improvements/tafsir-phone.png',import.meta.url),Buffer.from(shot.data,'base64'));
await evaluate('loadStudy("hadith")');await new Promise(r=>setTimeout(r,400));
assert.ok(await evaluate('document.querySelectorAll(".hadith-narration").length>=3'));
assert.match(await evaluate('document.getElementById("studyContent").textContent'),/4474/);
assert.equal(await evaluate('Array.from(document.querySelectorAll("#studyPanel button")).some(b=>b.textContent==="Read Hadith")'),false);
assert.equal(await evaluate('document.getElementById("studyTafsir").value'),'266');
shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('../language-evidence/ui-improvements/hadith-access-phone.png',import.meta.url),Buffer.from(shot.data,'base64'));
await evaluate('closeStudy();setReadingPreset("translation-pronunciation")');
assert.equal(await evaluate('document.getElementById("verseArabic").style.display'),'none');
assert.equal(await evaluate('document.getElementById("verseTranslit").style.display'),'');
await evaluate('setCustomReadingLayout("arabic-pronunciation");setReadingPreset("arabic-translation");setReadingPreset("custom")');
assert.equal(await evaluate('__uiAudit.S.settings.glassesLayout'),'arabic-pronunciation');
assert.equal(await evaluate('document.getElementById("verseTrans").style.display'),'none');
await evaluate('setReadingPreset("arabic-translation");showSettings()');await new Promise(r=>setTimeout(r,500));
assert.equal(await evaluate('document.getElementById("settingStudyTafsir").value'),'266');
assert.equal(await evaluate('document.getElementById("settingHadithLanguage").value'),'English');
await evaluate('setStudyPreference("studyHadithEdition","eng-muslim");setStudyPreference("studyTafsir",23)');
assert.equal(await evaluate('__uiAudit.loadSettings().studyTafsir'),23);
await evaluate('setStudyPreference("studyHadithEdition","eng-bukhari");setStudyPreference("studyTafsir",266);document.getElementById("settingStudyTafsir").value="266";document.getElementById("settingHadithEdition").value="eng-bukhari";document.getElementById("settingStudyTafsir").scrollIntoView({block:"start"})');
shot=await phone.send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('../language-evidence/ui-improvements/study-defaults-settings.png',import.meta.url),Buffer.from(shot.data,'base64'));
await evaluate('hideSettings();__uiAudit.S.settings.backendUrl='+JSON.stringify(savedBackend)+';closeStudy();');
phone.close();glasses.close();
