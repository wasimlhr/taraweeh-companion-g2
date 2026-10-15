import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {QuranStudy} from './quranStudy.js';
import {gunzipSync} from 'node:zlib';
import {createHadithRelationMatcher} from './hadithRelations.js';
test('installed study content is complete and matches provenance hashes',()=>{
 const q=new QuranStudy(),catalog=q.catalog();assert.equal(catalog.tafsirs.length,18);assert.equal(catalog.hadith.length,74);
 for(const edition of catalog.tafsirs){assert.equal(edition.chapters.length,114);let entries=0;for(const chapter of edition.chapters){const bytes=readFileSync(new URL('./data/study/'+chapter.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),chapter.sha256);const verses=q.read(chapter.file);assert.ok(Array.isArray(verses));entries+=verses.length;}assert.ok(entries>0);}
 for(const edition of catalog.hadith){const bytes=readFileSync(new URL('./data/study/'+edition.file,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),edition.sha256);assert.equal(q.read(edition.file).hadiths.length,edition.count);}
});
test('study works with network disabled and does not fabricate meanings or verse links',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('External network prohibited');};try{const q=new QuranStudy();assert.match((await q.tafsir('1:2',22)).text,/الحمد|الْحَمْد/);const word=(await q.words('1:2'));assert.equal(word.meaningAvailable,true);assert.equal(word.words[3].root,'علم');const h=await q.hadithText('eng-bukhari',1);assert.match(h.text,/intentions/);assert.ok((await q.hadith('1:2')).references.some(h=>h.hadithnumber===4474));await assert.rejects(q.tafsir('1:2',999));await assert.rejects(q.hadithText('../../secrets',1));}finally{globalThis.fetch=original;}
});

test('English tafsir is the default and keeps publisher attribution',async()=>{const data=await new QuranStudy().tafsir('1:2');assert.equal(data.language,'en');assert.match(data.text,/All praise belongs to Allah/);assert.match(data.source,/Tafsir Center.*CC BY 4.0/);});

test('related Hadith lists all indexed collections without a read step',async()=>{const q=new QuranStudy();const f=await q.hadith('1:2');for(const number of [4474,2276,5006])assert.ok(f.references.some(h=>h.hadithnumber===number));assert.ok(f.references.every(h=>h.text&&h.language==='English'));const cited=await q.hadith('75:16');assert.ok(cited.references.some(h=>h.edition==='eng-bukhari'&&h.hadithnumber===5));});


test('every Al-Fatihah ayah includes source-verified chapter Hadith, without duplicates',async()=>{
 const q=new QuranStudy();for(let ayah=1;ayah<=7;ayah++){const result=await q.hadith('1:'+ayah);assert.ok(result.references.some(h=>h.edition==='eng-muslim'&&String(h.arabicnumber)==='395.01'&&/two halves/.test(h.text)));assert.ok(result.references.some(h=>h.edition==='eng-bukhari'&&h.hadithnumber===4474));assert.equal(new Set(result.references.map(h=>h.edition+':'+h.hadithnumber)).size,result.references.length);assert.ok(result.references.some(h=>h.scope==='surah'));}
 assert.ok(!(await q.hadith('2:1')).references.some(h=>h.edition==='eng-muslim'&&h.hadithnumber===878));
});
test('Al-Fatihah word meanings are real glosses; rootless pronouns are not missing-word errors',async()=>{
 const q=new QuranStudy();for(let ayah=1;ayah<=7;ayah++){const verse=await q.words('1:'+ayah);assert.equal(verse.meaningAvailable,true);assert.ok(verse.words.every(w=>w.meaning&&!w.meaning.startsWith('Arabic root:')));}
 const verse=await q.words('1:5');assert.equal(verse.words[0].meaning,'You Alone');assert.equal(verse.words[0].root,'');assert.match(verse.words[0].rootNote,/No lexical root/);assert.equal(verse.words[1].root,'عبد');
 const tafsir=await q.tafsir('1:5');assert.match(tafsir.text,/associate no one/);assert.notEqual(tafsir.text,(await q.tafsir('1:6')).text);
});

test('English word meanings cover all 6236 ayahs with source hashes and explicit phrase alignment',async()=>{
 const q=new QuranStudy(),morph=JSON.parse(readFileSync(new URL('./data/corpus/quran-words.json',import.meta.url),'utf8'));
 const data=q.read('quran-word-glosses.json.gz');let words=0;
 assert.equal(data.ayahs,6236);assert.equal(data.words,77429);assert.equal(data.groups.length,10);
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(hash(gunzipSync(readFileSync(new URL('./data/study/qac-word-by-word-source.txt.gz',import.meta.url)))),data.sourceSha256);
 assert.equal(hash(gunzipSync(readFileSync(new URL('./data/study/qac-uthmani-alignment-source.xml.gz',import.meta.url)))),data.alignmentSha256);
 for(const key of Object.keys(morph)){const verse=await q.words(key);assert.equal(verse.meaningAvailable,true,key);assert.equal(verse.words.length,morph[key].words.length,key);for(const w of verse.words){assert.ok(w.meaning.trim(),key);assert.ok(w.sourcePositions.length,key);}words+=verse.words.length;}
 assert.equal(words,77429);assert.equal((await q.words('2:255')).words[0].meaning,'Allah -');assert.equal((await q.words('114:6')).words.at(-1).meaning,'and men.');
 const grouped=await q.words('37:130');assert.equal(grouped.words[2].meaningScope,'phrase');assert.equal(grouped.words[2].meaning,grouped.words[3].meaning);
});
test('explicit surah names are recognized across all 114 chapters without keyword guessing',()=>{
 const chapters=JSON.parse(readFileSync(new URL('./data/quran-json/quran_en.json',import.meta.url),'utf8')),match=createHadithRelationMatcher(chapters);
 for(const c of chapters){assert.ok(match('Surat '+c.transliteration+'.').surahs.some(s=>s.surah===c.id),c.transliteration);assert.ok(match('سورة '+c.name).surahs.some(s=>s.surah===c.id),c.name);}
 assert.deepEqual(match('A cow stood in the sun. Mary and Joseph were mentioned.'),{verses:[],surahs:[]});
 const numbered=match('Sura 2 ayat 255');assert.ok(numbered.verses.some(v=>v.key==='2:255'));assert.equal(numbered.surahs.length,0);
 assert.ok(match('Ayat al-Kursi').verses.some(v=>v.key==='2:255'));
});
test('related Hadith extends beyond Fatihah, preserves languages and distinguishes scopes',async()=>{
 const q=new QuranStudy();for(const key of ['2:255','18:10','36:1','112:1','113:1','114:1']){const data=await q.hadith(key);assert.ok(data.references.length,key);assert.ok(data.references.every(h=>h.language==='English'&&h.text&&h.basis&&h.scope));assert.equal(new Set(data.references.map(h=>h.edition+':'+h.hadithnumber)).size,data.references.length);}
 const index=JSON.parse(readFileSync(new URL('./data/study/related-hadith.json',import.meta.url),'utf8'));assert.ok(Object.keys(index.surahs).length>80);assert.ok(Object.keys(index.verses).length>600);
 const arabic=await q.hadith('112:1','Arabic','ara-bukhari');assert.ok(arabic.references.length);assert.ok(arabic.references.every(h=>h.language==='Arabic'));
 assert.ok(!(await q.hadith('112:1')).references.some(h=>h.edition==='eng-bukhari'&&h.hadithnumber===1));
});
