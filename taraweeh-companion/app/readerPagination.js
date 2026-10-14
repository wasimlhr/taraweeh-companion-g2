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

// Complete one ayah (Arabic and translation) before advancing to the next.
export function readerSinglePages(verses,measureArabic,measureTranslation,width=520,hasBasmala=false){
 function wrap(text){const lines=[];let line='';for(const word of String(text||'').trim().split(/\s+/).filter(Boolean)){if(line&&measureTranslation(line+' '+word)>width){lines.push(line);line='';}if(measureTranslation(word)>width){for(const ch of word){if(line&&measureTranslation(line+ch)>width){lines.push(line);line='';}line+=ch;}}else line=line?line+' '+word:word;}if(line)lines.push(line);return lines;}
 return verses.flatMap(verse=>{
  const arabic=paginateReader([verse],measureArabic,width,1).flatMap(p=>p.lines),translation=wrap(verse.translation);
  const opening=verse.ayah===1&&hasBasmala,base=opening?132:96;
  const translationY=base+(arabic.length-1)*44+44;
  const fits=arabic.length<=(opening?3:4)&&translationY+(translation.length-1)*26<=258;
  const pages=[];
  if(fits)pages.push({kind:'combined',lines:arabic,translationLines:translation,translationY,opening,startLine:0});
  else {
   for(let start=0;start<arabic.length;){const count=start===0&&opening?3:4;pages.push({kind:'arabic',lines:arabic.slice(start,start+count),translationLines:[],opening:start===0&&opening,startLine:start});start+=count;}
   for(let start=0;start<translation.length;start+=7)pages.push({kind:'translation',lines:[],translationLines:translation.slice(start,start+7),translationY:92,opening:false,startLine:start});
  }
  return pages.map((p,index)=>({...p,ayah:verse.ayah,ayahs:[verse.ayah],part:index+1,parts:pages.length}));
 });
}
