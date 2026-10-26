import {arabicMetrics} from './glassesTypography.js';
export const READER_TRANSLATION_INSET=24;
export const READER_TRANSLATION_WIDTH=576-2*READER_TRANSLATION_INSET;
const verseReferences=verse=>verse.ayahs||[verse.ayah];

// The phone follows the existing glasses ayah group, showing complete verses.
// This does not alter the glasses page, timing or pagination.
export function readerListeningContent(chapter,page){
 if(!chapter?.verses||!page?.ayahs?.length)return null;
 const refs=new Set(page.ayahs),verses=chapter.verses.filter(v=>verseReferences(v).some(n=>refs.has(n)));
 if(!verses.length)return null;
 const labels=verses.flatMap(v=>v.sourceAyahs?.length?v.sourceAyahs:[v.ayahLabel||v.ayah]);
 const label=labels.length===1?String(labels[0]):labels[0]+'–'+labels.at(-1);
 const arabic=verses.map(v=>v.arabic+(v.numbered===false||v.arabic.includes('۝')?'':' ۝'+String(v.ayah).replace(/[0-9]/g,d=>String.fromCharCode(0x660+Number(d))))).join(' ');
 const text=field=>verses.map(v=>(verses.length>1?(v.ayahLabel||v.ayah)+'. ':'')+(v[field]||'')).join('\n\n');
 return {ayahs:verses.flatMap(verseReferences),label,multiple:labels.length>1,arabic,translation:text('translation'),transliteration:verses.some(v=>v.transliteration)?text('transliteration'):''};
}

function translationLines(text,measure){
 const lines=[];let line='';
 for(const word of String(text||'').trim().split(/\s+/).filter(Boolean)){
  if(line&&measure(line+' '+word)>READER_TRANSLATION_WIDTH){lines.push(line);line='';}
  if(measure(word)>READER_TRANSLATION_WIDTH){for(const ch of word){if(line&&measure(line+ch)>READER_TRANSLATION_WIDTH){lines.push(line);line='';}line+=ch;}}
  else line=line?line+' '+word:word;
 }
 if(line)lines.push(line);return lines;
}

// Native translation fills the area above the audio controls, without Arabic.
export function readerTranslationPages(verses,measure){
 return verses.flatMap(verse=>{
  const lines=translationLines(verse.translation,measure),pages=[];
  for(let start=0;start<Math.max(1,lines.length);){
   const header=verse.ayah===1&&start===0,count=header?6:8;
   pages.push({kind:'translation-only',header,lines:[],translationLines:lines.slice(start,start+count),translationY:header?72:24,ayah:verse.ayah,ayahs:verseReferences(verse)});
   start+=count;
  }
  return pages.map((page,i)=>({...page,part:i+1,parts:pages.length}));
 });
}

// Keep complete, consecutive ayahs on a stable listening screen. Use the same
// measured line budgets as the renderer; oversized ayahs retain timed pages.
export function readerListeningPages(verses,measureArabic,measureTranslation,{translationOnly=false,arabicOnly=false,hasBasmala=false,compactAfterOpening=true,singleAyahPages=false,arabicSize=28}={}){
 const metrics=arabicMetrics(arabicSize),pages=[];let group=[];
 const fallback=verse=>arabicOnly?readerArabicOnlyPages(verse,measureArabic,hasBasmala,arabicSize):translationOnly?readerTranslationPages([verse],measureTranslation):singleAyahPages?readerSinglePages([verse],measureArabic,measureTranslation,520,hasBasmala,0,compactAfterOpening,arabicSize):readerInterleavedPages([verse],measureArabic,measureTranslation,520,hasBasmala,4,compactAfterOpening,arabicSize);
 function packed(items){
  const lines=translationOnly?[]:paginateReader(items,measureArabic,520,1).flatMap(p=>p.lines);
  const translated=arabicOnly?[]:translationLines(items.map(v=>(v.ayahLabel||v.ayah)+'. '+String(v.translation||'').trim()).join('  '),measureTranslation);
  if(lines.length>(arabicOnly?metrics.onlyCompact:compactAfterOpening?metrics.mixedCompact:metrics.mixedHeader)||translated.length>(translationOnly?8:4))return null;
  return {kind:arabicOnly?'arabic-only':translationOnly?'translation-only':'interleaved',header:arabicOnly?false:!compactAfterOpening,lines,translationLines:translated,translationY:translationOnly?24:144,ayah:items[0].ayah,ayahs:items.flatMap(verseReferences),part:1,parts:1,opening:false};
 }
 function flush(){if(group.length){pages.push(packed(group));group=[];}}
 for(const verse of verses){
  // The surah title and Bismillah belong only to the opening screen.
  if(verse.ayah===1){flush();pages.push(...fallback(verse));continue;}
  if(group.length&&(group.length===4||!packed([...group,verse])))flush();
  if(!packed([verse])){flush();pages.push(...fallback(verse));}
  else group.push(verse);
 }
 flush();return pages;
}

function readerArabicOnlyPages(verse,measure,hasBasmala,arabicSize=28){
 const metrics=arabicMetrics(arabicSize),lines=paginateReader([verse],measure,520,1).flatMap(p=>p.lines),pages=[];
 for(let at=0;at<lines.length;){const header=verse.ayah===1&&at===0,opening=header&&hasBasmala,count=header?(opening?metrics.onlyOpening:metrics.onlyHeader):metrics.onlyCompact;pages.push({kind:'arabic-only',header,opening,lines:lines.slice(at,at+count),translationLines:[],ayah:verse.ayah,ayahs:verseReferences(verse)});at+=count;}
 return pages.map((page,i)=>({...page,part:i+1,parts:pages.length}));
}

// Layout and translation are independent preferences in Read Quran. Showing
// translation must not silently replace the selected multiple-verse layout.
export function readerReadingPages(verses,measureArabic,measureTranslation,{layout='maximum',showTranslation=true,hasBasmala=false,numberedBasmala=false,arabicSize=28}={}){
 const metrics=arabicMetrics(arabicSize),openingCount=hasBasmala?metrics.onlyOpening:metrics.onlyHeader;
 if(layout==='single')return showTranslation?readerSinglePages(verses,measureArabic,measureTranslation,520,hasBasmala,0,true,arabicSize):verses.flatMap(verse=>readerVerseWindows([verse],measureArabic,520,verse.ayah===1?openingCount:metrics.onlyCompact,metrics.onlyCompact).map(page=>({...page,kind:'arabic-only',opening:page.header&&hasBasmala})));
 if(!showTranslation)return readerPackedWindows(verses,measureArabic,520,openingCount+(hasBasmala?1:0),hasBasmala,numberedBasmala,metrics.onlyCompact).map(page=>({...page,kind:'arabic-only'}));
 return readerListeningPages(verses,measureArabic,measureTranslation,{hasBasmala,compactAfterOpening:true,singleAyahPages:true,arabicSize});
}

// Flow complete ayahs into five full-screen lines without dropping words.
export function paginateReader(verses, measure, width=548, linesPerPage=5) {
 const lines=[];let text='',ayahs=new Set();
 function flush(){if(text){lines.push({text,ayahs:[...ayahs]});text='';ayahs=new Set();}}
 for(const verse of verses){
  const number=String(verse.ayah).replace(/[0-9]/g,d=>String.fromCharCode(0x660+Number(d)));
  const words=verse.arabic.trim().split(/\s+/);
  if(verse.ayah&&verse.numbered!==false)words[words.length-1]+=' ۝'+number;
  for(const word of words){const next=text?text+' '+word:word;if(text&&measure(next)>width)flush();text=text?text+' '+word:word;for(const ref of verseReferences(verse))ayahs.add(ref);}
 }
 flush();const pages=[];
 for(let i=0;i<lines.length;i+=linesPerPage){const slice=lines.slice(i,i+linesPerPage);pages.push({lines:slice.map(l=>l.text),ayahs:[...new Set(slice.flatMap(l=>l.ayahs))]});}
 return pages;
}

// Overlapping windows advance one line at a time, retaining reading context.
export function readerWindows(verses,measure,width=520,lineCount=4){
 const lines=paginateReader(verses,measure,width,1).map(p=>({text:p.lines[0],ayahs:p.ayahs}));
 const windows=[];
 for(let start=0;start<Math.max(1,lines.length-lineCount+1);start++){
  const slice=lines.slice(start,start+lineCount);windows.push({lines:slice.map(l=>l.text),ayahs:[...new Set(slice.flatMap(l=>l.ayahs))],startLine:start,totalLines:lines.length});
 }
 return windows;
}

// Each glasses window belongs to exactly one numbered ayah.
export function readerVerseWindows(verses,measure,width=520,lineCount=4,compactLineCount=lineCount){
 return verses.flatMap(verse=>{
  const flow=paginateReader([verse],measure,width,1),windows=[];
  for(let start=0;start<flow.length;start++){
   const header=verse.ayah===1&&start===0,count=start===0?lineCount:compactLineCount,slice=flow.slice(start,start+count);
   windows.push({lines:slice.flatMap(p=>p.lines),ayahs:[...new Set(slice.flatMap(p=>p.ayahs))],startLine:start,totalLines:flow.length,header});
   if(start+count>=flow.length)break;
  }
  return windows.map((window,index)=>({...window,ayah:verse.ayah,part:index+1,parts:windows.length}));
 });
}

// Dense, non-overlapping windows share exactly the same ayah range on both displays.
export function readerPackedWindows(verses,measure,width=520,lineCount=4,opening=false,numberedBasmala=false,compactLineCount=lineCount){
 const flow=numberedBasmala?[...paginateReader(verses.slice(0,1),measure,width,1),...paginateReader(verses.slice(1),measure,width,1)]:paginateReader(verses,measure,width,1);
 const lines=flow.map(p=>({text:p.lines[0],ayahs:p.ayahs}));
 const pages=[];
 for(let start=0;start<lines.length;){
  const count=start===0?(opening?lineCount-1:lineCount):compactLineCount;
  const slice=lines.slice(start,start+count);
  pages.push({lines:slice.map(l=>l.text),ayahs:[...new Set(slice.flatMap(l=>l.ayahs))],startLine:start,totalLines:lines.length,opening:start===0,header:start===0});
  start+=count;
 }
 return pages;
}

// Ayah recordings have no word timestamps: estimate page intervals from content
// length, using the real media clock so pauses and seeks stay in sync.
function readerAudioCandidates(pages,ayah){
 const candidates=[];const seenArabic=new Set(),seenTranslation=new Set();
 const words=text=>String(text).trim().split(/\s+/).filter(Boolean).length;
 pages.forEach((page,index)=>{
  if(!page.ayahs?.includes(ayah))return;
  const arabic=(page.lines||[]).join(' '),translation=(page.translationLines||[]).join(' ');
  const arabicWeight=seenArabic.has(arabic)?0:words(arabic);
  const translationWeight=seenTranslation.has(translation)?0:words(translation)/3;
  seenArabic.add(arabic);seenTranslation.add(translation);
  candidates.push({index,weight:Math.max(1,arabicWeight,translationWeight)});
 });
 return candidates;
}

// Swipes address display pages, not individual recordings inside a group.
// Use the same estimated intervals as automatic long-ayah page following.
export function readerAudioPageTarget(pages,index){
 const ayah=pages[index]?.ayahs?.[0];if(!ayah)return null;
 const candidates=readerAudioCandidates(pages,ayah),total=candidates.reduce((sum,p)=>sum+p.weight,0);
 let consumed=0;
 for(const page of candidates){
  if(page.index===index)return {ayah,progress:consumed?(consumed+page.weight*.001)/total:0};
  consumed+=page.weight;
 }
 return null;
}

export function readerAudioPage(pages,ayah,positionMs,durationMs){
 const candidates=readerAudioCandidates(pages,ayah);
 if(!candidates.length)return -1;
 if(!Number.isFinite(durationMs)||durationMs<=0||!Number.isFinite(positionMs)||positionMs<=0)return candidates[0].index;
 const progress=Math.min(1,positionMs/durationMs),total=candidates.reduce((sum,p)=>sum+p.weight,0);
 let consumed=0;
 for(const page of candidates){consumed+=page.weight;if(progress<consumed/total)return page.index;}
 return candidates.at(-1).index;
}

// Complete one ayah (Arabic and translation) before advancing to the next.
export function readerInterleavedPages(verses,measureArabic,measureTranslation,width=520,hasBasmala=false,translationLineCount=5,compactAfterOpening=false,arabicSize=28){
 const metrics=arabicMetrics(arabicSize);
 return verses.flatMap(verse=>{
  const arabic=paginateReader([verse],measureArabic,width,1).flatMap(p=>p.lines);
  const translated=[];let line='';
  for(const word of String(verse.translation||'').trim().split(/\s+/).filter(Boolean)){
   if(line&&measureTranslation(line+' '+word)>READER_TRANSLATION_WIDTH){translated.push(line);line='';}
   for(const character of word){if(line&&measureTranslation(line+character)>READER_TRANSLATION_WIDTH){translated.push(line);line='';}line+=character;}
   line+=' ';
  }
  if(line.trim())translated.push(line.trim());
  const chunks=[];for(let n=0;n<arabic.length;){const header=!compactAfterOpening||verse.ayah===1&&n===0;const count=header?(n===0&&verse.ayah===1&&hasBasmala?1:metrics.mixedHeader):metrics.mixedCompact;chunks.push(arabic.slice(n,n+count));n+=count;}
  const parts=Math.max(chunks.length,Math.ceil(translated.length/translationLineCount),1);
  return Array.from({length:parts},(_,i)=>({kind:'interleaved',header:!compactAfterOpening||verse.ayah===1&&i===0,lines:chunks[Math.min(i,chunks.length-1)]||[],translationLines:translated.slice(Math.min(i,Math.max(0,Math.ceil(translated.length/translationLineCount)-1))*translationLineCount,Math.min(i,Math.max(0,Math.ceil(translated.length/translationLineCount)-1))*translationLineCount+translationLineCount),translationY:164,opening:i===0&&verse.ayah===1&&hasBasmala,ayah:verse.ayah,ayahs:verseReferences(verse),part:i+1,parts}));
 });
}

export function readerSinglePages(verses,measureArabic,measureTranslation,width=520,hasBasmala=false,reservedHeight=0,compactAfterOpening=false,arabicSize=28){
 const metrics=arabicMetrics(arabicSize),step=Math.max(44,Math.ceil(metrics.size*44/28)),descent=metrics.size===28?0:metrics.descent;
 function wrap(text){const lines=[];let line='';for(const word of String(text||'').trim().split(/\s+/).filter(Boolean)){if(line&&measureTranslation(line+' '+word)>width){lines.push(line);line='';}if(measureTranslation(word)>width){for(const ch of word){if(line&&measureTranslation(line+ch)>width){lines.push(line);line='';}line+=ch;}}else line=line?line+' '+word:word;}if(line)lines.push(line);return lines;}
 return verses.flatMap(verse=>{
  const arabic=paginateReader([verse],measureArabic,width,1).flatMap(p=>p.lines),translation=wrap(verse.translation);
  const opening=verse.ayah===1&&hasBasmala,header=!compactAfterOpening||verse.ayah===1,base=opening?132:header?96:50;
  const capacity=Math.floor((258-reservedHeight-descent-base)/step)+1;
  const translationY=base+(arabic.length-1)*step+step;
  const fits=arabic.length<=capacity&&(!translation.length||translationY+(translation.length-1)*26<=258-reservedHeight);
  const pages=[];
  if(fits)pages.push({kind:'combined',lines:arabic,translationLines:translation,translationY,arabicY:base,opening,startLine:0});
  else {
   for(let start=0;start<arabic.length;){const arabicY=start===0?base:compactAfterOpening?50:96;const count=Math.max(1,Math.floor((258-reservedHeight-descent-arabicY)/step)+1);pages.push({kind:'arabic',lines:arabic.slice(start,start+count),translationLines:[],arabicY,opening:start===0&&opening,startLine:start});start+=count;}
   const translationY=compactAfterOpening?50:92,count=Math.max(1,Math.floor((258-reservedHeight-translationY)/26)+1);
   for(let start=0;start<translation.length;start+=count)pages.push({kind:'translation',lines:[],translationLines:translation.slice(start,start+count),translationY,opening:false,startLine:start});
  }
  return pages.map((p,index)=>({...p,header:!compactAfterOpening||verse.ayah===1&&index===0,ayah:verse.ayah,ayahs:verseReferences(verse),part:index+1,parts:pages.length}));
 });
}
