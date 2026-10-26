import {readFileSync} from 'node:fs';

const data=JSON.parse(readFileSync(new URL('./data/duri-reading.json',import.meta.url),'utf8'));
const cache=new Map();

// Translation and published timing references use Hafs numbering. Join the
// connected source verses whenever either reading splits the other's verse.
// Never duplicate a full translation under two partial Al-Duri verses.
export function duriUnits(surah){
 if(cache.has(surah))return cache.get(surah);
 const chapter=data.chapters[surah-1];if(!chapter||chapter.surah!==surah)return null;
 const groups=[];let group=null;
 for(const verse of chapter.verses){
  const first=Math.min(...verse.translationAyahs),last=Math.max(...verse.translationAyahs);
  if(!group||first>group.last){group={first,last,verses:[]};groups.push(group);}
  group.last=Math.max(group.last,last);group.verses.push(verse);
 }
 const units=groups.map(g=>({ayah:g.first,ayahEnd:g.last,ayahs:Array.from({length:g.last-g.first+1},(_,i)=>g.first+i),
  ayahLabel:String(g.verses[0].ayah)+(g.verses.length>1?'–'+g.verses.at(-1).ayah:''),
  sourceAyahs:g.verses.map(v=>v.ayah),numbered:false,
  // The source font provides the complete numbered rosette as one glyph.
  // Adding a Unicode circle and digit would draw two rosettes.
  arabic:g.verses.map(v=>v.arabic+' '+v.marker).join(' ')}));
 // Al-Duri numbers Al-Hamd as verse 1. Bismillah is an unnumbered invocation;
 // the recording's first timing reference nevertheless identifies that audio.
 if(surah===1)units.unshift({ayah:1,ayahEnd:1,ayahs:[1],ayahLabel:'Bismillah',sourceAyahs:[],numbered:false,arabic:data.bismillah});
 cache.set(surah,units);return units;
}

export function duriChapter(surah,lang,getVerseData){
 const units=duriUnits(surah);if(!units)return null;
 const first=getVerseData(surah,1,'');if(!first)return null;
 return {surah,name:first.surahName,arabicName:data.chapters[surah-1].arabicName,riwaya:'ad-duri',translationLang:lang||'en',
  totalAyahs:data.chapters[surah-1].verses.length,basmala:surah===1||surah===9?'':data.bismillah,
  source:{name:'Quranpedia.net',url:data.source,version:data.version,license:data.license},
  verses:units.map(unit=>({...unit,translation:unit.ayahs.map(a=>getVerseData(surah,a,lang)?.translation||'').join(' '),transliteration:''}))};
}
