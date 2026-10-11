import WebSocket from '../backend/node_modules/ws/wrapper.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getAdvW } from '@evenrealities/pretext';
import { compactLang } from './build-translation-packs.js';

const out = new URL('../language-evidence/', import.meta.url);
mkdirSync(out, { recursive: true });
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = targets.find(t => t.url.startsWith('http://localhost:3001/'));
if (!target) throw new Error('Run the Even simulator with WebView2 remote debugging port 9222');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.once('open', resolve));
let id = 0;
const pending = new Map();
let paused;
socket.on('message', data => {
  const msg = JSON.parse(data);
  if (msg.id) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  } else if (msg.method === 'Debugger.paused') paused?.(msg.params);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
await evaluate("window.caches ? caches.delete('qc-lang-packs-v1') : Promise.resolve()");
await send('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 1500));
await send('Debugger.enable');
const fn = await send('Runtime.evaluate', { expression: 'window.applyLocalTranslation' });
const bp = await send('Debugger.setBreakpointOnFunctionCall', { objectId: fn.result.objectId });
const stopped = new Promise(resolve => { paused = resolve; });
const call = send('Runtime.evaluate', { expression: 'window.applyLocalTranslation(null)' });
const frame = (await stopped).callFrames[0];
const injected = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
  expression: 'window.__languageTest = { S, ensureLangPack, hasLangPack, lookupPackVerse, handleServerMsg, buildGlassesText, cyrillicToUzbekLatinClient, glassesTranslationText, stopPageFlip, stopCountdown, glassesStartup };' });
if (injected.exceptionDetails) throw new Error(JSON.stringify(injected.exceptionDetails));
await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
await send('Debugger.resume');
await call;
await send('Debugger.disable');
await evaluate('(async () => { window.__languageTest.glassesStartup(); await window.__languageTest.S.bridgeCallQueue; })()');
// Startup queues a welcome repaint after its create/rebuild completes. Let
// that finish before feeding the first verse so evidence cannot show welcome.
await new Promise(resolve => setTimeout(resolve, 500));
await evaluate('window.__languageTest.S._lastGlassesState = null');

const languages = ['en','fr','es','id','tr','zh','ru','sv','uz','uzc','ur','bn'];
const results = [];
for (const lang of languages) {
  const row = await evaluate(`(async () => {
    const t = window.__languageTest;
    // Exercise the same selector handler users invoke, then await its download.
    document.getElementById('settingLang').value = ${JSON.stringify(lang)};
    window.onTranslationLangChange();
    if (!await t.ensureLangPack(${JSON.stringify(lang)})) throw new Error('pack failed');
    if (${JSON.stringify(lang)} === 'ur' || ${JSON.stringify(lang)} === 'bn') await t.ensureLangPack('en');
    t.S.isRecording = true;
    t.S.settings.glassesBottom = 'translation-only';
    t.handleServerMsg({ type: 'state', state: {
      mode: 'LOCKED', surah: 114, ayah: 1, surahName: 'An-Nas',
      arabic: 'قُلْ أَعُوذُ بِرَبِّ النَّاسِ',
      translation: 'Say, I seek refuge in the Lord of mankind.',
      translationLang: 'en', transliteration: "Qul a'udhu birabbin nas",
      confidence: 1, totalAyahs: 6, timerMs: 60000
    }});
    t.stopPageFlip(); t.stopCountdown();
    await t.S.bridgeCallQueue;
    return { lang: ${JSON.stringify(lang)}, phone: document.getElementById('verseTrans').textContent,
      label: document.getElementById('verseLangLabel').textContent,
      glasses: t.buildGlassesText(t.S._lastGlassesState).pages[0],
      bridge: t.S.isG2, installed: t.hasLangPack(${JSON.stringify(lang)}), selected:document.getElementById('settingLang').value, requested:t.S.settings.lang, lookup:t.lookupPackVerse(${JSON.stringify(lang)},114,1) };
  })()`);
  if (!row.bridge || !row.installed || !row.phone || !row.glasses) throw new Error('Incomplete rendering: ' + lang);
  if (!['en','ur','bn'].includes(lang) && row.glasses.includes('Lord of mankind')) throw new Error('English glasses fallback: ' + JSON.stringify(row));
  // Capture the actual simulator framebuffer and phone WebView, not mock output.
  await new Promise(resolve => setTimeout(resolve, 350));
  const phone = await send('Page.captureScreenshot', {format:'png'});
  writeFileSync(new URL(lang + '-webview.png', out), Buffer.from(phone.data, 'base64'));
  const glassSocket = new WebSocket(targets.find(t=>t.url.includes('glasses.html')).webSocketDebuggerUrl);
  await new Promise(resolve=>glassSocket.once('open',resolve));
  const glasses = await new Promise(resolve=> {
    glassSocket.once('message',data=>resolve(JSON.parse(data).result));
    glassSocket.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png'}}));
  });
  writeFileSync(new URL(lang + '-glasses.png', out), Buffer.from(glasses.data,'base64'));
  glassSocket.close();
  const key = lang === 'uz' ? 'uzc' : lang;
  let verses = compactLang(['ur','bn'].includes(lang) ? 'en' : key).verses.flat();
  if (lang === 'uz' || lang === 'uzc') {
    verses = await evaluate('(' + JSON.stringify(verses) + ').map(window.__languageTest.cyrillicToUzbekLatinClient)');
  }
  verses = await evaluate('(' + JSON.stringify(verses) + ').map(window.__languageTest.glassesTranslationText)');
  const chars = new Set(verses.join(''));
  row.missingGlyphs = [...chars].filter(c => !/\s/.test(c) && getAdvW(c.codePointAt(0)) === 0);
  row.ayahs = verses.length;
  row.nativeMissingGlyphs = [...new Set(compactLang(key).verses.flat().join(''))]
    .filter(c => !/\s/.test(c) && getAdvW(c.codePointAt(0)) === 0);
  if (row.missingGlyphs.length) throw new Error('Missing glasses glyphs for ' + lang);
  results.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(new URL('results.json', out), JSON.stringify(results, null, 2));
}
const escape = text => String(text).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
writeFileSync(new URL('index.html', out), `<!doctype html><meta charset="utf-8"><title>Language simulator evidence</title>
<style>body{font:16px system-ui;background:#f3f4f6;color:#172027;margin:32px;max-width:1200px}section{background:white;padding:24px;margin:24px 0;border-radius:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}img{max-width:100%;border:1px solid #ddd}pre{white-space:pre-wrap}a{color:#164ea6}</style>
<h1>Language verification — EvenHub simulator 0.9.0</h1><p>Actual app WebView and glasses display captures. Tested with a controlled An-Nas 114:1 state through the app's normal state handler and language selector. Fresh language downloads from the pinned public release; every glasses output corpus scanned across 6,236 ayahs for unsupported firmware glyphs. This verifies translation display, not audio recognition or physical hardware.</p>
${results.map(r=>`<section><h2>${escape(r.label)}</h2><p>${r.ayahs} ayahs checked · ${r.missingGlyphs.length} missing glyphs in glasses output${['ur','bn'].includes(r.lang)?' · English on glasses; native script unsupported':r.lang==='uzc'?' · Cyrillic on phone; Latin on glasses':''}</p><div class="pair"><div><h3>Glasses</h3><a href="${r.lang}-glasses.png"><img src="${r.lang}-glasses.png"></a><pre>${escape(r.glasses)}</pre></div><div><h3>Phone WebView</h3><a href="${r.lang}-webview.png"><img src="${r.lang}-webview.png"></a><pre>${escape(r.phone)}</pre></div></div></section>`).join('')}`);
await evaluate(`(async () => {
  const t = window.__languageTest;
  t.S.settings.lang = 'uz';
  document.getElementById('settingLang').value = 'uz';
  t.handleServerMsg({type:'state', state:t.S._lastGlassesState});
  t.stopPageFlip(); t.stopCountdown();
  await t.S.bridgeCallQueue;
  t.S.isRecording = false;
  delete window.__languageTest;
})()`);
socket.close();
console.log('Evidence saved to ' + out.pathname);
