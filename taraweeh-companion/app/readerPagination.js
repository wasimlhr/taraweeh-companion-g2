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
