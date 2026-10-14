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
