export const READER_TRANSLATION_INSET=24;
export const READER_TRANSLATION_WIDTH=576-2*READER_TRANSLATION_INSET;

// Flow complete ayahs into five full-screen lines without dropping words.
export function paginateReader(verses, measure, width=548, linesPerPage=5) {
 const lines=[];let text='',ayahs=new Set();
 function flush(){if(text){lines.push({text,ayahs:[...ayahs]});text='';ayahs=new Set();}}
 for(const verse of verses){
  const number=String(verse.ayah).replace(/[0-9]/g,d=>String.fromCharCode(0x660+Number(d)));
  const words=verse.arabic.trim().split(/\s+/);
  if(verse.ayah)words[words.length-1]+=' ۝'+number;
  for(const word of words){const next=text?text+' '+word:word;if(text&&measure(next)>width)flush();text=text?text+' '+word:word;ayahs.add(verse.ayah);}
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
export function readerVerseWindows(verses,measure,width=520,lineCount=4){
 return verses.flatMap(verse=>{const windows=readerWindows([verse],measure,width,lineCount);return windows.map((window,index)=>({...window,ayah:verse.ayah,part:index+1,parts:windows.length}));});
}

// Dense, non-overlapping windows share exactly the same ayah range on both displays.
export function readerPackedWindows(verses,measure,width=520,lineCount=4,opening=false,numberedBasmala=false){
 const flow=numberedBasmala?[...paginateReader(verses.slice(0,1),measure,width,1),...paginateReader(verses.slice(1),measure,width,1)]:paginateReader(verses,measure,width,1);
 const lines=flow.map(p=>({text:p.lines[0],ayahs:p.ayahs}));
 const pages=[];
 for(let start=0;start<lines.length;){
  const count=start===0&&opening?lineCount-1:lineCount;
  const slice=lines.slice(start,start+count);
  pages.push({lines:slice.map(l=>l.text),ayahs:[...new Set(slice.flatMap(l=>l.ayahs))],startLine:start,totalLines:lines.length,opening:start===0});
  start+=count;
 }
 return pages;
}

// Ayah recordings have no word timestamps: estimate page intervals from content
// length, using the real media clock so pauses and seeks stay in sync.
export function readerAudioPage(pages,ayah,positionMs,durationMs){
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
 if(!candidates.length)return -1;
 if(!Number.isFinite(durationMs)||durationMs<=0||!Number.isFinite(positionMs)||positionMs<=0)return candidates[0].index;
 const progress=Math.min(1,positionMs/durationMs),total=candidates.reduce((sum,p)=>sum+p.weight,0);
 let consumed=0;
 for(const page of candidates){consumed+=page.weight;if(progress<consumed/total)return page.index;}
 return candidates.at(-1).index;
}

// Complete one ayah (Arabic and translation) before advancing to the next.
export function readerInterleavedPages(verses,measureArabic,measureTranslation,width=520,hasBasmala=false,translationLineCount=5,compactAfterOpening=false){
 return verses.flatMap(verse=>{
  const arabic=paginateReader([verse],measureArabic,width,1).flatMap(p=>p.lines);
  const translated=[];let line='';
  for(const word of String(verse.translation||'').trim().split(/\s+/).filter(Boolean)){
   if(line&&measureTranslation(line+' '+word)>READER_TRANSLATION_WIDTH){translated.push(line);line='';}
   for(const character of word){if(line&&measureTranslation(line+character)>READER_TRANSLATION_WIDTH){translated.push(line);line='';}line+=character;}
   line+=' ';
  }
  if(line.trim())translated.push(line.trim());
  const chunks=[];for(let n=0;n<arabic.length;){const header=!compactAfterOpening||verse.ayah===1&&n===0;const count=header?(n===0&&verse.ayah===1&&hasBasmala?1:2):3;chunks.push(arabic.slice(n,n+count));n+=count;}
  const parts=Math.max(chunks.length,Math.ceil(translated.length/translationLineCount),1);
  return Array.from({length:parts},(_,i)=>({kind:'interleaved',header:!compactAfterOpening||verse.ayah===1&&i===0,lines:chunks[Math.min(i,chunks.length-1)]||[],translationLines:translated.slice(Math.min(i,Math.max(0,Math.ceil(translated.length/translationLineCount)-1))*translationLineCount,Math.min(i,Math.max(0,Math.ceil(translated.length/translationLineCount)-1))*translationLineCount+translationLineCount),translationY:164,opening:i===0&&verse.ayah===1&&hasBasmala,ayah:verse.ayah,ayahs:[verse.ayah],part:i+1,parts}));
 });
}

export function readerSinglePages(verses,measureArabic,measureTranslation,width=520,hasBasmala=false,reservedHeight=0,compactAfterOpening=false){
 function wrap(text){const lines=[];let line='';for(const word of String(text||'').trim().split(/\s+/).filter(Boolean)){if(line&&measureTranslation(line+' '+word)>width){lines.push(line);line='';}if(measureTranslation(word)>width){for(const ch of word){if(line&&measureTranslation(line+ch)>width){lines.push(line);line='';}line+=ch;}}else line=line?line+' '+word:word;}if(line)lines.push(line);return lines;}
 return verses.flatMap(verse=>{
  const arabic=paginateReader([verse],measureArabic,width,1).flatMap(p=>p.lines),translation=wrap(verse.translation);
  const opening=verse.ayah===1&&hasBasmala,header=!compactAfterOpening||verse.ayah===1,base=opening?132:header?96:50;
  const capacity=Math.floor((258-reservedHeight-base)/44)+1;
  const translationY=base+(arabic.length-1)*44+44;
  const fits=arabic.length<=capacity&&(!translation.length||translationY+(translation.length-1)*26<=258-reservedHeight);
  const pages=[];
  if(fits)pages.push({kind:'combined',lines:arabic,translationLines:translation,translationY,arabicY:base,opening,startLine:0});
  else {
   for(let start=0;start<arabic.length;){const arabicY=start===0?base:compactAfterOpening?50:96;const count=Math.max(1,Math.floor((258-reservedHeight-arabicY)/44)+1);pages.push({kind:'arabic',lines:arabic.slice(start,start+count),translationLines:[],arabicY,opening:start===0&&opening,startLine:start});start+=count;}
   const translationY=compactAfterOpening?50:92,count=Math.max(1,Math.floor((258-reservedHeight-translationY)/26)+1);
   for(let start=0;start<translation.length;start+=count)pages.push({kind:'translation',lines:[],translationLines:translation.slice(start,start+count),translationY,opening:false,startLine:start});
  }
  return pages.map((p,index)=>({...p,header:!compactAfterOpening||verse.ayah===1&&index===0,ayah:verse.ayah,ayahs:[verse.ayah],part:index+1,parts:pages.length}));
 });
}
