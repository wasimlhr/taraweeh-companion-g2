import {getVerseData} from './verseData.js';
export function readerChapter(surah) {
 if(!Number.isInteger(surah)||surah<1||surah>114)return null;
 const first=getVerseData(surah,1,'');if(!first)return null;
 return {surah,name:first.surahName,totalAyahs:first.ayahTotal,
  basmala:surah!==1&&surah!==9?getVerseData(1,1,'').arabic:'',
  verses:Array.from({length:first.ayahTotal},(_,i)=>{const v=getVerseData(surah,i+1,'');return {ayah:i+1,arabic:v.arabic};})};
}
