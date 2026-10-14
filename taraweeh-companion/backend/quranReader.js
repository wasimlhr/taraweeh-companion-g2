import {readFileSync} from 'node:fs';
const arabicNames=JSON.parse(readFileSync(new URL('./data/quran-json/quran_en.json',import.meta.url),'utf8')).map(c=>c.name);
import {getVerseData} from './verseData.js';
export function readerChapter(surah,lang='') {
 if(!Number.isInteger(surah)||surah<1||surah>114)return null;
 const first=getVerseData(surah,1,'');if(!first)return null;
 return {surah,name:first.surahName,arabicName:arabicNames[surah-1],translationLang:lang||'en',totalAyahs:first.ayahTotal,
  basmala:surah!==1&&surah!==9?getVerseData(1,1,'').arabic:'',
  verses:Array.from({length:first.ayahTotal},(_,i)=>{const v=getVerseData(surah,i+1,lang);return {ayah:i+1,arabic:v.arabic,translation:v.translation,transliteration:v.transliteration};})};
}
