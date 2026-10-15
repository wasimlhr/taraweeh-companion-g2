// Explicit source references only. This does not infer religious relationships from keywords.
export function createHadithRelationMatcher(chapters){
 const latin=new Map(),arabic=new Map();
 const latinNorm=s=>String(s).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 const arabicNorm=s=>String(s).normalize('NFKD').replace(/\p{M}|ـ/gu,'').replace(/ٱ/g,'ا').replace(/[^\u0621-\u064a]/g,'');
 function alias(map,value,id){if(!value)return;const found=map.get(value);if(found&&found!==id)throw Error('Ambiguous surah name: '+value);map.set(value,id);}
 for(const c of chapters){
  const title=latinNorm(c.transliteration),plain=title.replace(/^(?:al|ash|as|an|at|ath|ad|az|ar)/,'');
  for(const name of [title,plain,latinNorm(c.translation),latinNorm(c.translation.replace(/^the /i,''))]){alias(latin,name,c.id);if(name.length>4&&name.endsWith('h'))alias(latin,name.slice(0,-1),c.id);}
  const ar=arabicNorm(c.name);alias(arabic,ar,c.id);alias(arabic,ar.replace(/^ال/,''),c.id);
 }
 const variants={3:['alimran','aalimran','aliimran'],9:['tauba','taubah','tawba','tawbah','baraa','baraah'],17:['baniisrail','baniisrael'],40:['mumin','ghafir'],76:['dahr','insan'],94:['inshirah','sharh'],111:['lahab','masad']};
 for(const [id,names]of Object.entries(variants))for(const name of names)alias(latin,name,Number(id));
 const quotations=new Map();for(const c of chapters)for(const v of c.verses){if(v.text.trim().split(/\s+/).length<4)continue;const key=arabicNorm(v.text);if(quotations.has(key))quotations.set(key,null);else quotations.set(key,c.id+':'+v.id);}
 function valid(s,a){return Number.isInteger(s)&&s>=1&&s<=chapters.length&&Number.isInteger(a)&&a>=1&&a<=chapters[s-1].total_verses;}
 return function match(text){
  const verses=new Map(),surahs=new Map();
  const evidence=(start,end)=>text.slice(Math.max(0,start-45),Math.min(text.length,end+65)).replace(/\s+/g,' ').trim();
  function verse(s,a,end,basis,start,last){if(end<a||end-a>285)return;for(let n=a;n<=end;n++)if(valid(s,n))verses.set(s+':'+n,{key:s+':'+n,basis,evidence:evidence(start,last)});}
  for(const m of text.matchAll(/\((\d{1,3})\s*[.:]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\)/g))verse(+m[1],+m[2],+(m[3]||m[2]),'Explicit verse citation in source text',m.index,m.index+m[0].length);
  for(const m of text.matchAll(/\b(?:surah|surat|sura|chapter)\s*(?:no\.?\s*)?(\d{1,3})\s*[,;:]?\s*(?:ayats?|ayahs?|verses?)\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi))verse(+m[1],+m[2],+(m[3]||m[2]),'Explicit named chapter and verse citation',m.index,m.index+m[0].length);
  for(const m of text.matchAll(/\b(?:surah|surat|sura|chapter)\s+(\d{1,3})\s*[:.]\s*(\d{1,3})/gi))verse(+m[1],+m[2],+m[2],'Explicit chapter and verse citation',m.index,m.index+m[0].length);
  for(const m of text.matchAll(/\bayat(?:[-\s]*(?:ul|al))?[-\s]*kursi\b/gi))verse(2,255,255,'Names Ayat al-Kursi explicitly',m.index,m.index+m[0].length);
  // Restrict name matching to an explicit chapter marker. Ordinary mentions of
  // Mary, the cow, the sun, etc. are not sufficient to link a surah.
  for(const m of text.matchAll(/\b(?:surah|surat|sura)\s+(?:no\.?\s*)?([^\n.!?;]{1,90})/gi)){
   const tail=m[1],numeric=tail.match(/^(\d{1,3})(?!\d)(.*)/);
   if(numeric){const id=+numeric[1];if(id>=1&&id<=114&&!/^\s*(?:(?:[:.]\s*\d)|(?:[,;:]?\s*)?(?:ayats?|ayahs?|verses?)\b)/i.test(numeric[2]))surahs.set(id,{surah:id,basis:'Names this surah in the source text',evidence:evidence(m.index,m.index+m[0].length)});continue;}
   const tokens=tail.replace(/[’‘`']/g,'').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
   for(let n=Math.min(5,tokens.length);n>0;n--){const id=latin.get(latinNorm(tokens.slice(0,n).join('')));if(id){const after=tokens.slice(n);if(/^(?:ayats?|ayahs?|verses?)$/i.test(after[0]||'')&&/^\d{1,3}$/.test(after[1]||''))verse(id,+after[1],+after[1],'Names this surah and ayah explicitly',m.index,m.index+m[0].length);else surahs.set(id,{surah:id,basis:'Names this surah in the source text',evidence:evidence(m.index,m.index+m[0].length)});break;}}
  }
  // The explicit dual name identifies Al-Falaq and An-Nas together; do not
  // confuse it with the narrator Mu'awwidh or the non-specific plural.
  for(const m of text.matchAll(/\bmu['’` -]?aww[ia]dhat(?:an|ain|ayn)\b/gi))for(const id of [113,114])surahs.set(id,{surah:id,basis:'Names the two refuge surahs (Al-Falaq and An-Nas)',evidence:evidence(m.index,m.index+m[0].length)});
  const arabicText=text.normalize('NFKD').replace(/\p{M}|ـ/gu,'');
  for(const m of arabicText.matchAll(/المعوذ(?:تين|تان)/g))for(const id of [113,114])surahs.set(id,{surah:id,basis:'Names the two refuge surahs (Al-Falaq and An-Nas)',evidence:m[0]});
  for(const m of arabicText.matchAll(/(?:اية|ايه)\s+الكرسي/g))verse(2,255,255,'Names Ayat al-Kursi explicitly',m.index,m.index+m[0].length);
  for(const m of arabicText.matchAll(/(?:سورة|سوره)\s+([^\n.!؟؛]{1,70})/g)){
   const tokens=m[1].split(/\s+/);for(let n=Math.min(3,tokens.length);n>0;n--){const id=arabic.get(arabicNorm(tokens.slice(0,n).join('')));if(id){surahs.set(id,{surah:id,basis:'Names this surah in the Arabic source text',evidence:m[0].slice(0,160)});break;}}
  }
  for(const m of text.matchAll(/[«{“"]([^»}”"]{6,1200})[»}”"]/g)){const key=quotations.get(arabicNorm(m[1]));if(key)verses.set(key,{key,basis:'Quotes this complete ayah in the source text',evidence:m[1].slice(0,180)});}
  return {verses:[...verses.values()],surahs:[...surahs.values()]};
 };
}
