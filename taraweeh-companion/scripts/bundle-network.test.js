import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {undeclaredOrigins} from './check-bundle-network.js';
test('bundle URL audit catches metadata URLs as well as fetch URLs',()=>{
 assert.deepEqual(undeclaredOrigins('const meta={source:"https://unlisted.example/credits"};fetch("https://ok.example/data");',['https://ok.example']),['https://unlisted.example']);
});
test('client translation download URLs only use our backend and local origin',()=>{
 const html=readFileSync(new URL('../app/index.html',import.meta.url),'utf8');
 const body=html.slice(html.indexOf('  function langPackUrls('),html.indexOf('  function setLangPackStatus('));
 assert.doesNotMatch(body,/cdn|snapshot|quranenc|risanb/);
 assert.match(body,/backendBase/);assert.match(body,/translations/);
});
test('all literal client URLs match the network manifest',()=>{
 const html=readFileSync(new URL('../app/index.html',import.meta.url),'utf8');
 const manifest=JSON.parse(readFileSync(new URL('../app.json',import.meta.url),'utf8'));
 assert.deepEqual(undeclaredOrigins(html,manifest.permissions.find(p=>p.name==='network').whitelist),[]);
});
