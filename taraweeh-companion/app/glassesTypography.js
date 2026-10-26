export const ARABIC_SIZES=Object.freeze([24,28,32,36]);
export const ARABIC_FONTS=Object.freeze([
 {id:'indopak',family:'QuranIndoPak',label:'Indo-Pak'},
 {id:'amiri',family:'QuranBitmap',label:'Amiri Quran'},
 {id:'duri',family:'QuranDuri',label:'Al-Duri',reading:'ad-duri'}
]);
export const ARABIC_RENDERINGS=Object.freeze([
 {id:'standard',label:'Standard'},
 {id:'bright',label:'Brighter edges'},
 {id:'supersampled',label:'Smooth (2×)'}
]);
export function arabicPreferences(settings={}){
 return {size:ARABIC_SIZES.includes(Number(settings.glassesArabicSize))?Number(settings.glassesArabicSize):28,
  rendering:ARABIC_RENDERINGS.some(o=>o.id===settings.glassesArabicRendering)?settings.glassesArabicRendering:'standard',
  font:['indopak','amiri'].includes(settings.glassesArabicFont)?settings.glassesArabicFont:'auto'};
}
export function arabicMetrics(value=28){
 const size=arabicPreferences({glassesArabicSize:value}).size,step=Math.ceil(36*size/28),descent=Math.ceil(size*.43);
 const compactY=54+Math.max(0,Math.ceil((size-28)/2)),headerY=94+Math.max(0,Math.ceil((size-28)/2)),openingY=128;
 const capacity=(base,bottom)=>Math.max(1,Math.floor((bottom-descent-base)/step)+1);
 return {size,step,descent,compactY,headerY,openingY,
  mixedCompact:capacity(compactY,144),mixedHeader:capacity(headerY,144),
  onlyCompact:capacity(compactY,252),onlyHeader:capacity(headerY,252),onlyOpening:capacity(openingY,252),
  legacyCount:Math.min(4,Math.floor((270-descent-96)/Math.ceil(46*size/28))+1)};
}
export function edgeBrightness(value){return Math.round(255*Math.pow(value/255,.7));}
export function createArabicCanvas(width,height,settings={},doc=document){
 const {rendering}=arabicPreferences(settings),scale=rendering==='supersampled'?2:1;
 const canvas=doc.createElement('canvas');canvas.width=width*scale;canvas.height=height*scale;
 canvas.arabicOutput={width,height,rendering};if(scale!==1)canvas.getContext('2d').scale(scale,scale);return canvas;
}
export function finishArabicCanvas(source,doc=document){
 const output=source.arabicOutput;if(!output)return source;
 let canvas=source;
 if(source.width!==output.width){canvas=doc.createElement('canvas');canvas.width=output.width;canvas.height=output.height;canvas.getContext('2d').drawImage(source,0,0,output.width,output.height);}
 if(output.rendering==='bright'){
  const ctx=canvas.getContext('2d'),image=ctx.getImageData(0,0,canvas.width,canvas.height);
  for(let i=0;i<image.data.length;i+=4)for(let c=0;c<3;c++)image.data[i+c]=edgeBrightness(image.data[i+c]);
  ctx.putImageData(image,0,0);
 }
 delete canvas.arabicOutput;return canvas;
}

// Al-Duri samples retain the source reading and its font-specific rosette.
// Source: Quranpedia mushaf 6, dump 2026-10-23 (see bundled data notice).
const hafs=['بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ','أَلَمْ نَشْرَحْ لَكَ صَدْرَكَ ۝١','قُلْ هُوَ اللَّهُ أَحَدٌ ۝١'];
const duri=['بِسۡمِ اِ۬للَّهِ اِ۬لرَّحۡمَٰنِ اِ۬لرَّحِيمِ','أَلَمۡ نَشۡرَحۡ لَكَ صَدۡرَكَ ﰀ','قُلۡ هُوَ اَ۬للَّهُ أَحَدٌ ﰀ'];
export async function fontTestCanvas(font,preferences){
 const {size}=arabicPreferences(preferences),faces=await document.fonts.load(size+'px '+font.family);
 if(!faces.length)throw Error(font.label+' could not load');
 const canvas=createArabicCanvas(576,288,preferences),ctx=canvas.getContext('2d');
 ctx.fillStyle='#000';ctx.fillRect(0,0,576,288);ctx.fillStyle='#fff';ctx.font=size+'px '+font.family;ctx.textAlign='right';ctx.direction='rtl';
 (font.id==='duri'?duri:hafs).forEach((text,i)=>ctx.fillText(text,548,102+i*54));
 return finishArabicCanvas(canvas);
}
