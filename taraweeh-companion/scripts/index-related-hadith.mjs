// Index explicit Quran citations in the installed source texts, not inferred
// keyword matches. Preserve source numbering and relationship provenance.
import {writeFileSync} from 'node:fs';
import {QuranStudy} from '../backend/quranStudy.js';
import {getAyah} from '../backend/keywordMatcher.js';
const study=new QuranStudy(),index={schema:1,verses:{}};
function add(key,edition,number,basis){const list=index.verses[key]||=[];if(!list.some(r=>r.edition===edition&&r.number===number))list.push({edition,number,basis});}
for(const edition of study.catalog().hadith){for(const hadith of study.read(edition.file).hadiths){
 // Parenthesized chapter/verse citations; optional same-chapter verse range.
 for(const match of hadith.text.matchAll(/\((\d{1,3})\s*[.:]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\)/g)){
  const surah=Number(match[1]),first=Number(match[2]),last=Number(match[3]||match[2]);
  if(last<first||last-first>285)continue;
  for(let ayah=first;ayah<=last;ayah++)if(getAyah(surah,ayah))add(surah+':'+ayah,edition.name,hadith.hadithnumber,'Explicit verse citation in source text');
 }
}}
// These narrations explicitly quote 1:2 even though its numeric reference is
// absent. Verify the quoted text before adding the curated association.
for(const number of [4474,2276,5006]){const h=await study.hadithText('eng-bukhari',number);if(!/praise.*Lord of the worlds/i.test(h.text))throw Error('Missing Fatihah quote');add('1:2','eng-bukhari',number,'Quotes Al-Fatihah 1:2');}
writeFileSync(new URL('../backend/data/study/related-hadith.json',import.meta.url),JSON.stringify(index));
console.log(Object.keys(index.verses).length,'ayahs with source-backed Hadith links');
