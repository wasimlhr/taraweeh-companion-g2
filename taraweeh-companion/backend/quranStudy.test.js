import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {QuranStudy} from './quranStudy.js';
test('installed study content is complete and matches provenance hashes',()=>{
 const q=new QuranStudy(),catalog=q.catalog();assert.equal(catalog.tafsirs.length,18);assert.equal(catalog.hadith.length,74);
 for(const edition of catalog.tafsirs){assert.equal(edition.chapters.length,114);let entries=0;for(const chapter of edition.chapters){const bytes=readFileSync(new URL('./data/study/'+chapter.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),chapter.sha256);const verses=q.read(chapter.file);assert.ok(Array.isArray(verses));entries+=verses.length;}assert.ok(entries>0);}
 for(const edition of catalog.hadith){const bytes=readFileSync(new URL('./data/study/'+edition.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),edition.sha256);assert.equal(q.read(edition.file).hadiths.length,edition.count);}
});
test('study works with network disabled and does not fabricate meanings or verse links',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('External network prohibited');};try{const q=new QuranStudy();assert.match((await q.tafsir('1:2',22)).text,/الحمد|الْحَمْد/);const word=(await q.words('1:2'));assert.equal(word.meaningAvailable,false);assert.equal(word.words[3].root,'علم');const h=await q.hadithText('eng-bukhari',1);assert.match(h.text,/intentions/);assert.ok((await q.hadith('1:2')).references.some(h=>h.hadithnumber===4474));await assert.rejects(q.tafsir('1:2',999));await assert.rejects(q.hadithText('../../secrets',1));}finally{globalThis.fetch=original;}
});

test('English tafsir is the default and keeps publisher attribution',async()=>{const data=await new QuranStudy().tafsir('1:2');assert.equal(data.language,'en');assert.match(data.text,/All praise belongs to Allah/);assert.match(data.source,/Tafsir Center.*CC BY 4.0/);});

test('related Hadith lists all indexed collections without a read step',async()=>{const q=new QuranStudy();const f=await q.hadith('1:2');for(const number of [4474,2276,5006])assert.ok(f.references.some(h=>h.hadithnumber===number));assert.ok(f.references.every(h=>h.text&&h.language==='English'));const cited=await q.hadith('75:16');assert.ok(cited.references.some(h=>h.edition==='eng-bukhari'&&h.hadithnumber===5));});
