import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {QuranStudy} from './quranStudy.js';
test('installed study content is complete and matches provenance hashes',()=>{
 const q=new QuranStudy(),catalog=q.catalog();assert.equal(catalog.tafsirs.length,17);assert.equal(catalog.hadith.length,74);
 for(const edition of catalog.tafsirs){assert.equal(edition.chapters.length,114);let entries=0;for(const chapter of edition.chapters){const bytes=readFileSync(new URL('./data/study/'+chapter.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),chapter.sha256);const verses=q.read(chapter.file);assert.ok(Array.isArray(verses));entries+=verses.length;}assert.ok(entries>0);}
 for(const edition of catalog.hadith){const bytes=readFileSync(new URL('./data/study/'+edition.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),edition.sha256);assert.equal(q.read(edition.file).hadiths.length,edition.count);}
});
test('study works with network disabled and does not fabricate meanings or verse links',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('External network prohibited');};try{const q=new QuranStudy();assert.match((await q.tafsir('1:2')).text,/الحمد|الْحَمْد/);const word=(await q.words('1:2'));assert.equal(word.meaningAvailable,false);assert.equal(word.words[3].root,'علم');const h=await q.hadithText('eng-bukhari',1);assert.match(h.text,/intentions/);assert.equal((await q.hadith('1:2')).available,false);await assert.rejects(q.tafsir('1:2',999));await assert.rejects(q.hadithText('../../secrets',1));}finally{globalThis.fetch=original;}
});
