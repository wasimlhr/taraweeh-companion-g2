import {readFileSync,writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {LANGUAGE_CATALOG} from '../backend/languageCatalog.js';
import {compactLang} from './build-translation-packs.js';
const path=new URL('../app/index.html',import.meta.url);
const before=readFileSync(path,'utf8').replace(/\r\n/g,'\n');
const metadata=Object.fromEntries(LANGUAGE_CATALOG.map(e=>[e.code,{label:e.label,glasses:e.glasses,source:e.source,author:e.author,version:e.version}]));
const packKeys=Object.fromEntries(LANGUAGE_CATALOG.map(e=>[e.code,e.pack||e.code]));
const sizes=Object.fromEntries([...new Set(Object.values(packKeys))].map(code=>[code,Math.ceil(gzipSync(JSON.stringify(compactLang(code))).length/1024)]));
const json=data=>JSON.stringify(data).replaceAll('<','\\u003c');
const esc=t=>String(t).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const options=LANGUAGE_CATALOG.map(e=>{
 const credits=e.author?e.author+' · version '+e.version+'. ':'';
 const support=e.code==='uzc'?'Cyrillic on phone; Latin Uzbek on glasses.':e.glasses?'Selected language on phone and glasses.':'Native text on phone; English on glasses because this edition contains unsupported font characters.';
 return '        <option value="'+e.code+'" title="'+esc(credits+support)+'">'+esc(e.label)+(e.glasses?'':' — English on glasses')+'</option>';
}).join('\n');
let after=before.replace(/  const LANGUAGE_CATALOG = [^\n]+;/,'  const LANGUAGE_CATALOG = '+json(metadata)+';')
 .replace(/  var LANG_PACK_KEYS = [^\n]+;/,'  var LANG_PACK_KEYS = '+json(packKeys)+';')
 .replace(/  var LANG_PACK_KB = [^\n]+;/,'  var LANG_PACK_KB = '+json(sizes)+';')
 .replace(/  var GLASSES_ENGLISH_LANGS = [^\n]+;/,'  var GLASSES_ENGLISH_LANGS = '+json(Object.fromEntries(LANGUAGE_CATALOG.filter(e=>!e.glasses).map(e=>[e.code,1])))+';')
 .replace(/(<select id="settingLang"[^>]*>)[\s\S]*?(<\/select>)/,'$1\n        <option value="" title="Built-in English translation on phone and glasses.">English (built-in)</option>\n'+options+'\n      $2');
if(process.argv.includes('--check')){if(after!==before)throw new Error('Language UI does not match catalog; run npm run sync:languages');}
else writeFileSync(path,after);
console.log('Language UI matches '+LANGUAGE_CATALOG.length+' catalog choices.');
