import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLang, PACK_LANGS } from './build-translation-packs.js';
import { getVerseData } from '../backend/verseData.js';
import { loadQuran } from '../backend/keywordMatcher.js';

test('every optional language pack has 6236 ayahs', () => {
  assert.equal(PACK_LANGS.length,81);
  assert.equal(new Set(PACK_LANGS).size,81);
  for (const lang of PACK_LANGS) {
    const pack = compactLang(lang);
    assert.equal(pack.v, 1, lang);
    assert.equal(pack.lang, lang);
    assert.equal(pack.verses.length, 114, lang);
    assert.equal(pack.ayahs, 6236, lang);
    assert.equal(pack.verses.reduce((n, s) => n + s.length, 0), 6236, lang);
  }
});

test('English and Uzbek compact packs match verseData for An-Nas 114:1', () => {
  loadQuran();
  const en = compactLang('en');
  const uzc = compactLang('uzc');
  assert.match(en.verses[113][0], /seek refuge in the Lord of mankind/i);
  assert.equal(en.verses[113][0], getVerseData(114, 1, 'en').translation);
  assert.match(uzc.verses[113][0], /инсонларнинг Парвардигоридан/);
  assert.equal(uzc.verses[113][0], getVerseData(114, 1, 'uzc').translation);
});

import {LANGUAGE_CATALOG} from '../backend/languageCatalog.js';
import {getAdvW} from '@evenrealities/pretext';
import {readFileSync} from 'node:fs';
test('all translations have correct chapter and verse identities, no blank text, and stable existing sources',()=>{
 const baseline=JSON.parse(readFileSync(new URL('../backend/data/quran-json/quran_en.json',import.meta.url),'utf8'));
 for(const e of LANGUAGE_CATALOG.filter(e=>e.code!=='uz')){
  const chapters=JSON.parse(readFileSync(new URL('../backend/data/quran-json/'+e.file,import.meta.url),'utf8'));
  chapters.forEach((ch,i)=>{assert.equal(ch.id,i+1,e.code);assert.equal(ch.verses.length,baseline[i].verses.length,e.code);ch.verses.forEach((v,a)=>{assert.equal(v.id,a+1,e.code);assert.ok(v.translation.trim(),e.code);});});
 }
});
test('each enabled backend language returns its source text and a safe fallback where required',()=>{
 loadQuran();
 for(const e of LANGUAGE_CATALOG){
  const pack=compactLang(e.pack||e.code);
  for(const [s,a] of [[1,1],[2,255],[114,1]]){
   const verse=getVerseData(s,a,e.code);
   assert.equal(verse.translationLang,e.code);
   if(e.code!=='uz')assert.equal(verse.translation,pack.verses[s-1][a-1],e.code);
   if(!e.glasses)assert.equal(verse.translationGlasses,getVerseData(s,a,'').translation,e.code);
  }
 }
});
test('new editions retain credits, version, source and licensing and the font scan agrees with the catalog',()=>{
 const normalize=t=>String(t).replace(/`/g,"'").replace(/[ṣẓṢṡṭḥḤṬ]/g,c=>({'ṣ':'s','ẓ':'z','Ṣ':'S','ṡ':'s','ṭ':'t','ḥ':'h','Ḥ':'H','Ṭ':'T'}[c]));
 for(const e of LANGUAGE_CATALOG.filter(e=>!e.legacy)){
  assert.ok(e.author&&e.version&&e.source&&e.license?.url,e.code);
  const text=compactLang(e.code).verses.flat().map(normalize).join('');
  const missing=[...new Set(text)].filter(c=>!/^\s$/u.test(c)&&getAdvW(c.codePointAt(0))===0);
  assert.deepEqual(missing,e.missingGlyphs,e.code);assert.equal(e.glasses,missing.length===0,e.code);
 }
});
