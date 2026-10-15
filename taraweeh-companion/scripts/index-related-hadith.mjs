// Reproducible relations from explicit source citations, names and complete quotations.
import {readFileSync,writeFileSync} from 'node:fs';
import {QuranStudy} from '../backend/quranStudy.js';
import {createHadithRelationMatcher} from '../backend/hadithRelations.js';
const study=new QuranStudy(),catalog=study.catalog(),chapters=JSON.parse(readFileSync(new URL('../backend/data/quran-json/quran_en.json',import.meta.url),'utf8'));
const match=createHadithRelationMatcher(chapters),canonical=new Map();
const index={schema:3,source:catalog.sources.hadith,verses:{},surahs:{}};
function sourceKey(edition,h){if(h.arabicnumber==null||h.reference?.book==null||h.reference?.hadith==null)return null;return [edition.collectionName,h.arabicnumber,h.reference.book,h.reference.hadith].join('|');}
function add(type,key,edition,h,basis,evidence='',seed=true){
 const list=index[type][key]||=[];
 if(!list.some(r=>r.edition===edition.name&&r.number===h.hadithnumber))list.push({edition:edition.name,number:h.hadithnumber,basis,evidence});
 const canonicalKey=sourceKey(edition,h);
 if(seed&&canonicalKey){const relations=canonical.get(canonicalKey)||new Map();relations.set(type+':'+key,{type,key,basis,evidence,edition:edition.name,number:h.hadithnumber});canonical.set(canonicalKey,relations);}
}
for(const edition of catalog.hadith){for(const h of study.read(edition.file).hadiths){
 const result=match(h.text);
 for(const link of result.verses)add('verses',link.key,edition,h,link.basis,link.evidence);
 for(const link of result.surahs)add('surahs',String(link.surah),edition,h,link.basis,link.evidence);
}}
for(const [editionName,number,proof] of [
 ['eng-bukhari',4474,/greatest Sura/i],['eng-bukhari',5006,/seven repeatedly/i],['eng-bukhari',2276,/Lord of the worlds/i],['eng-bukhari',756,/recite Al-Fatiha/i],['eng-muslim',878,/divided the prayer into two halves/i],['eng-qudsi',8,/divided prayer.*two halves/i],
]){
 const edition=catalog.hadith.find(e=>e.name===editionName),h=await study.hadithText(editionName,number);
 if(!proof.test(h.text))throw Error('Al-Fatihah source verification failed');
 add('surahs','1',edition,h,'Discusses Surah Al-Fatihah as a whole',h.text.match(proof)[0]);
 if([4474,5006,2276].includes(number))add('verses','1:2',edition,h,'Quotes Al-Fatihah 1:2','Praise be to Allah, the Lord of the worlds');
}
// Carry associations between translations only when collection, source number,
// book and in-book reference all agree. Never match by narration keywords.
for(const edition of catalog.hadith)for(const h of study.read(edition.file).hadiths){
 if(!h.text?.trim())continue;
 const relations=canonical.get(sourceKey(edition,h));if(!relations)continue;
 for(const r of relations.values())add(r.type,r.key,edition,h,r.edition===edition.name?r.basis:'Same source narration as '+r.edition+' '+r.number+'; '+r.basis,r.evidence,false);
}
for(const type of ['verses','surahs'])for(const list of Object.values(index[type]))list.sort((a,b)=>a.edition.localeCompare(b.edition)||a.number-b.number);
writeFileSync(new URL('../backend/data/study/related-hadith.json',import.meta.url),JSON.stringify(index));
const counts={surahsWithReferences:Object.keys(index.surahs).length,ayahsWithDirectReferences:Object.keys(index.verses).length,surahLinks:Object.values(index.surahs).reduce((n,v)=>n+v.length,0),ayahLinks:Object.values(index.verses).reduce((n,v)=>n+v.length,0)};
console.log(JSON.stringify(counts));
