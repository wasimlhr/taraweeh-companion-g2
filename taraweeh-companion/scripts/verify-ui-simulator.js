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
  'window.__uiAudit={S,handleServerMsg,stopPageFlip,stopCountdown,glassesMenu,onG2Event,ensureLangPack,glassesStartup,ensureArabicFont,arabicImageCanvas,stopListening,buildGlassesText,getHeld:function(){return _readingHeld;},getHeldPage:function(){return _heldPage;}}; __uiAudit.imageResults=[]; __uiAudit.originalImage=S.bridge.updateImageRawData.bind(S.bridge); S.bridge.updateImageRawData=async function(data){var result=await __uiAudit.originalImage(data);__uiAudit.imageResults.push({id:data.containerID,length:data.imageData.length,result:result});return result;};'});
if(injection.exceptionDetails)throw Error(JSON.stringify(injection.exceptionDetails));
await phone.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
await phone.send('Debugger.resume'); await call; await phone.send('Debugger.disable');
await evaluate(`window.__uiAudit.saved={lang:__uiAudit.S.settings.lang,glassesBottom:__uiAudit.S.settings.glassesBottom,dimSecondary:__uiAudit.S.settings.dimSecondary,arabicImage:__uiAudit.S.settings.arabicImage,favoriteLanguages:__uiAudit.S.settings.favoriteLanguages,reciteMode:__uiAudit.S.settings.reciteMode,forcePhoneMic:__uiAudit.S.settings.forcePhoneMic};`);
const results=[];
async function capture(name) {
  await evaluate('(async()=>{await __uiAudit.S.bridgeCallQueue;})()'); await settle();
  const [a,b]=await Promise.all([phone.send('Page.captureScreenshot',{format:'png'}),glasses.send('Page.captureScreenshot',{format:'png'})]);
  writeFileSync(new URL(name+'-phone.png',out),Buffer.from(a.data,'base64'));
  writeFileSync(new URL(name+'-glasses.png',out),Buffer.from(b.data,'base64'));
}
try {
  await phone.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`(async()=>{
    __uiAudit.S.settings.arabicImage=false; __uiAudit.S.settings.dimSecondary=false;
    __uiAudit.glassesStartup(); await __uiAudit.S.bridgeCallQueue;
    setMainLang('uz'); await __uiAudit.ensureLangPack('uz'); setReciteMode('taraweeh');
    setMicSource('g2');
    __uiAudit.verse={mode:'LOCKED',surah:114,ayah:1,surahName:'An-Nas',arabic:'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',translation:'Say, I seek refuge in the Lord of mankind.',translationLang:'en',transliteration:'Qul a‘udhu birabbin nas',confidence:1,timerMs:60000,totalAyahs:6};
    setGlassesBottom('transliteration');
  })()`);
  await selectMenu(0);
  await settle();
  assert.equal(await evaluate('__uiAudit.S.isRecording'),true);
  assert.match(await evaluate('document.getElementById("recordBtn").textContent'),/Stop Listening/);
  // Capture was started through the actual menu. Stop its audio stream and
  // backend recognition before supplying controlled display fixtures.
  await evaluate(`(async()=>{await __uiAudit.S.bridge.audioControl(false);__uiAudit.S.ws.send(JSON.stringify({type:'stop'}));})()`);
  await settle();
  await evaluate('__uiAudit.handleServerMsg({type:"state",state:__uiAudit.verse});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();');
  await capture('01-reading');
  const compact=await evaluate(`({overflow:document.documentElement.scrollWidth>innerWidth,details:document.getElementById('listeningDetails').open,phone:document.getElementById('verseTrans').textContent,summary:document.getElementById('deviceLanguageSummary').textContent})`);
  assert.equal(compact.overflow,false); assert.equal(compact.details,false); assert.match(compact.phone,/inson/); results.push({case:'compact Uzbek reading',...compact});

  await evaluate('showSettings(); document.getElementById("languageSearch").value="uzbek"; filterLanguages();');
  const search=await evaluate(`({options:Array.from(document.getElementById('settingLang').options).map(o=>o.value),selected:document.getElementById('settingLang').value})`);
  assert.deepEqual(search.options,['uzc','uz']);assert.equal(search.selected,'uz');
  await evaluate(`if(!__uiAudit.S.settings.favoriteLanguages.includes('uz'))toggleLanguageFavorite();toggleFavoritesOnly();`);
  const favorites=await evaluate(`({selected:document.getElementById('settingLang').value,saved:__uiAudit.S.settings.favoriteLanguages.includes('uz'),options:Array.from(document.getElementById('settingLang').options).map(o=>o.value)})`);
  assert.equal(favorites.saved,true);assert.equal(favorites.selected,'uz');
  await evaluate('document.getElementById("languageSearch").closest(".s-row").scrollIntoView({block:"start"});');
  await capture('02-language-search');results.push({case:'language search and favourites',search,favorites});
  await evaluate(`document.getElementById('languageSearch').value='no-such-language';filterLanguages();`);
  assert.equal(await evaluate(`document.getElementById('settingLang').value`),'uz');
  await evaluate(`toggleFavoritesOnly();document.getElementById('languageSearch').value='';filterLanguages();setMainLang('fa');`);
  await evaluate(`(async()=>{await __uiAudit.ensureLangPack('fa');await __uiAudit.ensureLangPack('en');await updateGlassesPreview();})()`);
  const fallback=await evaluate(`document.getElementById('deviceLanguageSummary').textContent`);
  assert.match(fallback,/Phone: Persian.*Glasses: English/);results.push({case:'explicit per-device fallback',text:fallback});
  await capture('03-fallback');
  await evaluate(`setMainLang('uz');hideSettings();__uiAudit.handleServerMsg({type:'state',state:__uiAudit.verse});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();toggleVerseHold();`);
  await evaluate(`__uiAudit.handleServerMsg({type:'state',state:{...__uiAudit.verse,ayah:2,arabic:'مَلِكِ النَّاسِ',translation:'The Sovereign of mankind',transliteration:'Malikin nas'}});`);
  assert.equal(await evaluate(`__uiAudit.S._lastGlassesState.ayah`),1);
  assert.equal(await evaluate(`__uiAudit.getHeld()`),true);
  await capture('04-held');
  await evaluate('toggleVerseHold();__uiAudit.stopPageFlip();__uiAudit.stopCountdown();');
  assert.equal(await evaluate(`__uiAudit.S._lastGlassesState.ayah`),2);results.push({case:'hold and resume',heldAyah:1,resumedAyah:2});

  await evaluate('setDimSecondary(true);__uiAudit.handleServerMsg({type:"state",state:__uiAudit.verse});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();');
  await capture('05-dim-pronunciation');
  await fetch('http://127.0.0.1:9898/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'context_menu'})});
  await settle(); await capture('06-context-menu');
  const menu=await evaluate('__uiAudit.glassesMenu().menuItems');assert.equal(menu.length,5);results.push({case:'glasses menu',items:menu});
  // Move through actual simulator menu items: system controls precede app actions.
  await fetch('http://127.0.0.1:9898/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'context_menu'})});
  await selectMenu(1);console.log('Menu action',await evaluate('({held:__uiAudit.getHeld(),recording:__uiAudit.S.isRecording,verse:document.getElementById("verseArabic").textContent,events:dumpDiag().split("\\n").filter(line=>/g2.menu|g2.event|g2.overlay/.test(line)).slice(-12)})'));assert.equal(await evaluate('__uiAudit.getHeld()'),true);
  await selectMenu(1);assert.equal(await evaluate('__uiAudit.getHeld()'),false);
  await selectMenu(2);assert.equal(await evaluate('__uiAudit.S.settings.glassesBottom'),'translation-only');
  await evaluate('setGlassesBottom("transliteration");__uiAudit.stopPageFlip();__uiAudit.stopCountdown();');
  results.push({case:'actual simulator menu selections',start:true,hold:true,resume:true,pronunciationToggle:true});

  await evaluate(`(async()=>{await __uiAudit.ensureArabicFont();document.getElementById('settingArabicImage').checked=true;setArabicImage(true);await __uiAudit.S.bridgeCallQueue;})()`);
  await settle(); await capture('07-arabic-image');
  console.log('Image results', await evaluate('({sends:__uiAudit.imageResults,errors:dumpDiag().split("\\n").filter(line=>/rejected|transfer failed|bridge.*fail/i.test(line))})'));
  const sends=await evaluate('__uiAudit.imageResults');
  assert.equal(sends.length,4);assert.ok(sends.every(send=>send.result==='success'||send.result===0));
  const framebuffer=await glasses.send('Runtime.evaluate',{expression:`(()=>{let image=document.getElementById('layer-bright');let canvas=document.createElement('canvas');canvas.width=576;canvas.height=288;let ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);let data=ctx.getImageData(0,40,576,224).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i+1]>30)count++;return count;})()`,returnByValue:true});
  if(framebuffer.exceptionDetails)throw Error(JSON.stringify(framebuffer.exceptionDetails));
  assert.ok(framebuffer.result.value>200,'Arabic pixels must be present in the actual glasses framebuffer');
  results.push({case:'Arabic on actual simulator framebuffer',litPixels:framebuffer.result.value,imageSends:sends.length});
  const html=await glasses.send('Runtime.evaluate',{expression:'document.body.outerHTML',returnByValue:true});
  writeFileSync(new URL('glasses-dom.html',out),html.result.value);
  const pixels=await evaluate(`(async()=>{let r=await __uiAudit.arabicImageCanvas(__uiAudit.verse.arabic,0);let p=r.canvas.getContext('2d').getImageData(0,0,576,224).data;return {litPixels:Array.from(p).filter((v,i)=>i%4===0&&v>0).length,pages:r.count,fontReady:document.fonts.check('28px QuranBitmap')};})()`);
  assert.ok(pixels.litPixels>200);assert.equal(pixels.fontReady,true);results.push({case:'Arabic bitmap generated with bundled font',...pixels});
  await evaluate('showSettings();');
  await evaluate('document.getElementById("settingArabicImage").closest(".s-row").scrollIntoView({block:"start"});');
  await evaluate('updateGlassesPreview()'); await capture('08-arabic-settings');
  // Wide layout in the same real WebView, alongside the phone-width evidence.
  await phone.send('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate('document.getElementById("settingArabicImage").closest(".s-row").scrollIntoView({block:"start"});');
  await capture('09-wide-settings');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  const long=getVerseData(2,282,'');
  await evaluate(`hideSettings();__uiAudit.handleServerMsg({type:'state',state:{...${JSON.stringify(long)},mode:'LOCKED',timerMs:60000}});__uiAudit.stopPageFlip();__uiAudit.stopCountdown();toggleVerseHold();`);
  const pageCount=await evaluate('__uiAudit.buildGlassesText(__uiAudit.S._lastGlassesState).pages.length');
  assert.ok(pageCount>1);
  await input('down');assert.equal(await evaluate('__uiAudit.getHeldPage()'),1);await capture('11-arabic-long-page');console.log('Page movement',await evaluate('({page:__uiAudit.getHeldPage(),events:dumpDiag().split("\\n").filter(line=>/g2.event|g2.image|bridge.*err/.test(line)).slice(-15)})'));
  results.push({case:'long Arabic verse pagination',surah:2,ayah:282,pages:pageCount});
  await evaluate('setArabicImage(false);');
  await selectMenu(0);
  assert.equal(await evaluate('__uiAudit.S.isRecording'),false);
  await capture('10-stopped');
  results.push({case:'actual menu stop exits image layout',recording:await evaluate('__uiAudit.S.isRecording')});
  writeFileSync(new URL('results.json',out),JSON.stringify(results,null,2));
  writeFileSync(new URL('index.html',out),`<!doctype html><meta charset="utf-8"><title>v3.4.15 UI simulator evidence</title><style>body{font:16px system-ui;margin:24px;background:#f5f5f5;color:#222}.pair{display:flex;gap:20px;flex-wrap:wrap}img{max-width:100%;max-height:850px}section{margin:32px 0}</style><h1>v3.4.15 — phone and glasses simulator</h1><p>Actual EvenHub 0.9.5 WebView and glasses captures. Controlled verse input verifies display and UI; physical hardware and live recognition are separate checks.</p>${['01-reading','02-language-search','03-fallback','04-held','05-dim-pronunciation','06-context-menu','07-arabic-image','08-arabic-settings','09-wide-settings','10-stopped','11-arabic-long-page'].map(n=>`<section><h2>${n}</h2><div class="pair"><img src="${n}-phone.png"><img src="${n}-glasses.png"></div></section>`).join('')}`);
  console.log(JSON.stringify(results,null,2));
} finally {
  await evaluate('__uiAudit.S.bridge.updateImageRawData=__uiAudit.originalImage;');
  await evaluate(`(async()=>{__uiAudit.stopListening();Object.assign(__uiAudit.S.settings,__uiAudit.saved);document.getElementById('settingLang').value=__uiAudit.S.settings.lang;setGlassesBottom(__uiAudit.S.settings.glassesBottom);setDimSecondary(__uiAudit.S.settings.dimSecondary);setReciteMode(__uiAudit.S.settings.reciteMode);document.getElementById('settingsView').style.display='none';document.getElementById('mainView').style.display='block';await __uiAudit.S.bridgeCallQueue;delete window.__uiAudit;})()`);
  await phone.send('Emulation.clearDeviceMetricsOverride');phone.close();glasses.close();
}
