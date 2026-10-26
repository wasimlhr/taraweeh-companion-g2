import test from 'node:test';
import assert from 'node:assert/strict';
import {readerChapter} from '../backend/quranReader.js';
import {duriUnits} from '../backend/duriReading.js';
import {noreenCues,noreenTimingSource} from '../backend/mp3QuranRecitations.js';
import {paginateReader,readerWindows,readerVerseWindows,readerPackedWindows,readerSinglePages,readerInterleavedPages,readerAudioPage,readerTranslationPages,readerListeningPages,readerReadingPages,READER_TRANSLATION_WIDTH} from '../app/readerPagination.js';
import {ARABIC_SIZES,arabicMetrics,arabicPreferences,edgeBrightness} from '../app/glassesTypography.js';
import {readerListeningContent,readerAudioPageTarget} from '../app/readerPagination.js';

test('Listen page targets skip grouped ayahs and invert long-ayah clock intervals in every display mode',()=>{
 for(const riwaya of ['hafs','ad-duri'])for(const options of [{},{arabicOnly:true},{translationOnly:true}]){
  const data=readerChapter(2,'en',riwaya),measure=t=>t.length*9;
  const pages=readerListeningPages(data.verses,measure,measure,options);
  for(let index=0;index<pages.length;index++){
   const target=readerAudioPageTarget(pages,index);
   assert.ok(target);assert.equal(readerAudioPage(pages,target.ayah,target.progress*60000,60000),index);
  }
  assert.equal(readerAudioPageTarget(pages,-1),null);assert.equal(readerAudioPageTarget(pages,pages.length),null);
 }
 const pages=[{ayahs:[1]},{ayahs:[2,3,4,5]},{ayahs:[6,7,8]}];
 assert.deepEqual(readerAudioPageTarget(pages,2),{ayah:6,progress:0});
 assert.deepEqual(readerAudioPageTarget(pages,1),{ayah:2,progress:0});
});

test('Listen phone text follows the glasses ayah group without altering its page',()=>{
 const chapter=readerChapter(1,'en'),page={ayahs:[6,7]},before=JSON.stringify(page),content=readerListeningContent(chapter,page);
 assert.deepEqual(content.ayahs,[6,7]);assert.equal(content.label,'6–7');assert.equal(content.multiple,true);
 assert.ok(content.arabic.includes(chapter.verses[5].arabic));assert.ok(content.arabic.includes(chapter.verses[6].arabic));
 assert.equal((content.arabic.match(/۝/g)||[]).length,2);assert.equal(content.translation,'6. '+chapter.verses[5].translation+'\n\n7. '+chapter.verses[6].translation);
 assert.equal(JSON.stringify(page),before);assert.equal(readerListeningContent(chapter,{ayahs:[]}),null);
});

test('Listen phone groups retain Al-Duri numbering and merged translations exactly once',()=>{
 const chapter=readerChapter(1,'en','ad-duri'),merged=chapter.verses.at(-1),content=readerListeningContent(chapter,{ayahs:merged.ayahs});
 assert.equal(content.label,'6–7');assert.equal(content.translation,merged.translation);assert.equal(content.arabic,merged.arabic);assert.ok(!content.arabic.includes('۝'));
 const invocation=readerListeningContent(chapter,{ayahs:[1]});assert.equal(invocation.label,'Bismillah');assert.equal(invocation.multiple,false);
});

test('all selectable Arabic sizes preserve long ayahs and keep marks above translation and player',()=>{
 for(const size of ARABIC_SIZES)for(const riwaya of ['hafs','ad-duri']){
  const verse=readerChapter(2,'en',riwaya).verses.find(v=>v.ayah===282),measure=t=>t.length*size/3,metrics=arabicMetrics(size);
  for(const arabicOnly of [false,true]){
   const pages=readerListeningPages([verse],measure,measure,{arabicOnly,arabicSize:size}),chunks=[];
   assert.ok(pages.length>1);
   for(const page of pages){const text=page.lines.join(' ');if(text!==chunks.at(-1))chunks.push(text);const base=page.header?metrics.headerY:metrics.compactY;assert.ok(base+(page.lines.length-1)*metrics.step+metrics.descent<=(arabicOnly?252:144),size+'px must fit before the native text/player');}
   assert.equal(chunks.join(' '),paginateReader([verse],measure,520,1).flatMap(p=>p.lines).join(' '));
   if(!arabicOnly){const translated=[];for(const page of pages){const text=page.translationLines.join(' ').replace(/\s+/g,' ').trim();if(text!==translated.at(-1))translated.push(text);}assert.equal(translated.join(' '),verse.translation);}
  }
  for(const layout of ['single','maximum']){
   const pages=readerReadingPages([verse],measure,measure,{layout,arabicSize:size});
   assert.equal(pages.flatMap(p=>p.translationLines).join(' '),verse.translation);
   for(const page of pages.filter(p=>p.lines.length&&p.kind!=='interleaved')){const base=page.arabicY||96,step=Math.max(44,Math.ceil(size*44/28));assert.ok(base+(page.lines.length-1)*step+metrics.descent<=272);}
  }
 }
});

test('font defaults and brightness preserve black, white and graduated anti-aliased edges',()=>{
 assert.deepEqual(arabicPreferences({glassesArabicSize:100,glassesArabicFont:'duri',glassesArabicRendering:'invalid'}),{size:28,font:'auto',rendering:'standard'});
 assert.equal(edgeBrightness(0),0);assert.equal(edgeBrightness(255),255);
 let previous=0;const levels=new Set();for(let i=1;i<255;i++){const value=edgeBrightness(i);assert.ok(value>=previous&&value>=i&&value<255);levels.add(value);previous=value;}assert.ok(levels.size>100);
});

test('Arabic-only listening fills six lines below the opening, preserves long verses and omits translation',()=>{
 const measure=t=>t.length*9;
 for(const riwaya of ['hafs','ad-duri'])for(const surah of [1,3,55,112]){
  const chapter=readerChapter(surah,'en',riwaya),pages=readerListeningPages(chapter.verses,measure,()=>{throw Error('Arabic-only must not measure translation');},{arabicOnly:true,hasBasmala:!!chapter.basmala});
  assert.ok(pages.length);assert.ok(pages.every(p=>p.kind==='arabic-only'&&!p.translationLines.length));assert.ok(pages.every(p=>p.lines.length<=(p.header?(p.opening?4:5):6)));
  assert.equal(pages.flatMap(p=>p.lines).join(' '),paginateReader(chapter.verses,measure,520,1).flatMap(p=>p.lines).join(' '));
  for(const verse of chapter.verses)assert.ok(readerAudioPage(pages,verse.ayah,0,10000)>=0);
 }
 const chapter=readerChapter(3),pages=readerListeningPages(chapter.verses,measure,measure,{arabicOnly:true,hasBasmala:true});assert.ok(pages.some(p=>p.lines.length>3));assert.ok(pages.some(p=>p.parts>1));
});

test('Noreen has verified, contiguous automatic cues and complete Al-Duri mappings across all 114 surahs',()=>{
 let nativeVerses=0,references=0;
 for(let surah=1;surah<=114;surah++){
  const timing=noreenTimingSource(surah),chapter=readerChapter(surah,'en','ad-duri'),hafs=readerChapter(surah,'en'),units=duriUnits(surah);
  assert.equal(timing.surah,surah);assert.match(timing.sha256,/^[a-f0-9]{64}$/);
  const cues=noreenCues(timing,{sha256:timing.sha256,durationMs:timing.durationMs});
  assert.equal(cues.length,chapter.verses.length);assert.equal(cues[0].startMs,0);assert.equal(cues.at(-1).endMs,timing.durationMs);
  assert.deepEqual(units.flatMap(v=>v.ayahs),hafs.verses.map(v=>v.ayah));
  const sourceAyahs=units.flatMap(v=>v.sourceAyahs);assert.deepEqual(sourceAyahs,Array.from({length:chapter.totalAyahs},(_,i)=>i+1));
  assert.ok(units.every(u=>!u.arabic.includes('۝')),'The Al-Duri font already supplies each complete numbered rosette');
  for(let i=0;i<cues.length;i++){assert.ok(cues[i].durationMs>0);if(i)assert.equal(cues[i].startMs,cues[i-1].endMs);assert.equal(cues[i].ayahLabel,units[i].ayahLabel);}
  assert.equal(chapter.verses.map(v=>v.translation).join(' '),hafs.verses.map(v=>v.translation).join(' '));
  nativeVerses+=sourceAyahs.length;references+=units.flatMap(v=>v.ayahs).length;
 }
 assert.equal(nativeVerses,6218);assert.equal(references,6236);
 const fatiha=readerChapter(1,'en','ad-duri');
 assert.equal(fatiha.verses[0].ayahLabel,'Bismillah');assert.ok(!fatiha.verses[0].arabic.includes('۝'));
 assert.equal(fatiha.verses.at(-1).ayahLabel,'6–7');assert.equal(fatiha.verses.at(-1).translation,readerChapter(1,'en').verses.at(-1).translation);
 assert.ok(fatiha.verses.find(v=>v.ayahLabel==='3').arabic.startsWith('مَلِكِ'));
 assert.equal(readerChapter(1,'en','invented'),null);
});

test('Al-Duri merged and split verses retain all Arabic, translation and timing references on listening pages',()=>{
 const measure=t=>t.length*8;
 for(const surah of [1,2,18,55,107,112]){
  const chapter=readerChapter(surah,'en','ad-duri');
  for(const translationOnly of [false,true]){
   const pages=readerListeningPages(chapter.verses,measure,measure,{translationOnly,hasBasmala:!!chapter.basmala});
   for(const verse of chapter.verses)for(const ayah of verse.ayahs)assert.ok(readerAudioPage(pages,ayah,0,10000)>=0);
   if(!translationOnly){const text=pages.flatMap(p=>p.lines).join(' ');for(const verse of chapter.verses)for(const word of verse.arabic.split(/\s+/))assert.ok(text.includes(word));}
  }
 }
});

test('Read Quran keeps single and multiple verse choices with translation enabled',()=>{
 const verses=readerChapter(55).verses,measure=t=>t.length*9;
 const multiple=readerReadingPages(verses,measure,measure,{showTranslation:true});
 assert.ok(multiple.some(page=>page.ayahs.length>1));
 assert.equal(multiple[0].header,true);assert.ok(multiple.slice(1).every(page=>!page.header));assert.ok(multiple.some(page=>page.translationLines.length));
 for(const page of multiple.filter(p=>p.kind==='interleaved')){assert.ok(page.lines.length<=(page.header?2:3));assert.ok(page.translationLines.length<=4);assert.ok(page.ayahs.length<=4);}
 assert.deepEqual([...new Set(multiple.flatMap(p=>p.ayahs))],verses.map(v=>v.ayah));
 const single=readerReadingPages(verses,measure,measure,{layout:'single',showTranslation:true});
 assert.ok(single.every(page=>page.ayahs.length===1));assert.ok(single.length>multiple.length);
 for(const verse of verses){const pages=single.filter(p=>p.ayah===verse.ayah);assert.equal(pages.flatMap(p=>p.translationLines).join(' '),verse.translation);}
});

test('Read Quran reserves its title and Bismillah only on the opening and reclaims later pages',()=>{
 const measure=t=>t.length*10;
 for(const size of ARABIC_SIZES)for(const layout of ['single','maximum'])for(const showTranslation of [false,true]){
  const source=readerChapter(2),chapter={...source,verses:[...source.verses.slice(0,4),source.verses[281]]},metrics=arabicMetrics(size);
  const pages=readerReadingPages(chapter.verses,measure,measure,{layout,showTranslation,hasBasmala:true,arabicSize:size});
  assert.equal(pages[0].header,true);
  assert.equal(pages[0].opening,true);
  assert.ok(pages.slice(1).every(p=>p.header===false&&!p.opening));
  assert.deepEqual([...new Set(pages.flatMap(p=>p.ayahs))],chapter.verses.map(v=>v.ayah));
  if(!showTranslation){
   assert.ok(pages.slice(1).some(p=>p.lines.length>metrics.onlyOpening),'use the former header space');
   for(const page of pages){const base=page.header?metrics.openingY:metrics.compactY;assert.ok(base+(page.lines.length-1)*metrics.step+metrics.descent<=252);}
  }
 }
});

test('opening-only Read Quran headers preserve every ayah across all chapters and font sizes',()=>{
 for(let surah=1;surah<=114;surah++){
  const chapter=readerChapter(surah),expected=chapter.verses.map(v=>v.ayah);
  for(const size of ARABIC_SIZES)for(const layout of ['single','maximum'])for(const showTranslation of [false,true]){
   const measure=t=>t.length*size/3;
   const pages=readerReadingPages(chapter.verses,measure,measure,{layout,showTranslation,hasBasmala:!!chapter.basmala,numberedBasmala:surah===1,arabicSize:size});
   assert.ok(pages.length,`${surah} ${size}px ${layout}`);
   assert.equal(pages[0].header,true);
   assert.ok(pages.slice(1).every(p=>p.header===false),'no repeated chapter title');
   assert.deepEqual([...new Set(pages.flatMap(p=>p.ayahs))],expected,'all ayahs remain reachable in order');
  }
 }
});

test('Read Quran multiple verse pages preserve translations, long ayahs and an Arabic-only choice',()=>{
 const chapter=readerChapter(2),measure=t=>t.length*10;
 const verses=chapter.verses.slice(281,283),pages=readerReadingPages(verses,measure,measure,{showTranslation:true});
 for(const verse of verses){const own=pages.filter(p=>p.ayahs.includes(verse.ayah));assert.equal(own.flatMap(p=>p.translationLines).join(' '),verse.translation);assert.equal(own.flatMap(p=>p.lines).join(' '),paginateReader([verse],measure,520,1).flatMap(p=>p.lines).join(' '));}
 const hidden=readerReadingPages(readerChapter(112).verses,measure,measure,{showTranslation:false});
 assert.ok(hidden.some(p=>p.ayahs.length>1));assert.ok(hidden.every(p=>!p.translationLines?.length));
});

test('listening packs up to four complete ayahs and holds their page through playback and seeks',()=>{
 const verses=Array.from({length:10},(_,i)=>({ayah:i+1,arabic:'كلمة',translation:'Verse '+(i+1)})),measure=t=>t.length*9;
 for(const translationOnly of [false,true]){
  const pages=readerListeningPages(verses,measure,measure,{translationOnly,hasBasmala:true});
  assert.equal(pages[0].header,true);assert.deepEqual(pages.map(p=>p.ayahs),[[1],[2,3,4,5],[6,7,8,9],[10]]);
  assert.ok(pages.slice(1).every(p=>!p.header));
  for(const page of pages){
   assert.ok(page.lines.length<=3);assert.ok(page.translationLines.length<=(translationOnly?8:4));
   assert.ok(page.translationLines.every(line=>measure(line)<=READER_TRANSLATION_WIDTH));
   for(const ayah of page.ayahs)for(const ms of [0,5000,10000,100])assert.equal(readerAudioPage(pages,ayah,ms,10000),pages.indexOf(page));
  }
 }
});

test('listening respects both text budgets and preserves oversized ayah continuation',()=>{
 const measure=t=>t.length*10;
 const verses=[{ayah:2,arabic:'كلمة',translation:'Short'}, {ayah:3,arabic:Array.from({length:90},(_,i)=>'كلمة'+i).join(' '),translation:Array.from({length:160},(_,i)=>'word'+i).join(' ')},{ayah:4,arabic:'كلمة',translation:'After'}, {ayah:5,arabic:'كلمة',translation:'Last'}];
 for(const translationOnly of [false,true]){
  const pages=readerListeningPages(verses,measure,measure,{translationOnly});
  const long=pages.filter(p=>p.ayahs.includes(3));assert.ok(long.length>1);
  assert.ok(long.every(p=>p.ayahs.length===1));
  assert.equal(long.flatMap(p=>p.translationLines).join(' ').replace(/\s+/g,' ').trim(),verses[1].translation);
  assert.deepEqual(pages.at(-1).ayahs,[4,5]);
  assert.equal(readerAudioPage(pages,3,0,60000),pages.indexOf(long[0]));
  assert.equal(readerAudioPage(pages,3,60000,60000),pages.indexOf(long.at(-1)));
 }
 const actual=readerChapter(55).verses;
 const pages=readerListeningPages(actual,measure,measure);
 assert.ok(pages.length<actual.length,'Short surah ayahs share screens');
 assert.ok(pages.some(p=>p.ayahs.length>=3));
 assert.deepEqual([...new Set(pages.flatMap(p=>p.ayahs))],actual.map(v=>v.ayah));
 const chunks=[];for(const page of pages){const text=page.lines.join(' ');if(text!==chunks.at(-1))chunks.push(text);}
 assert.equal(chunks.join(' '),paginateReader(actual,measure,520,1).flatMap(p=>p.lines).join(' '));
});

test('translation-only audio pages preserve complete text and fit the native viewport',()=>{
 const verses=[1,2].map(ayah=>({ayah,arabic:'بسم الله',translation:Array.from({length:300},(_,i)=>'word'+i).join(' ')}));
 const measure=t=>t.length*12,pages=readerTranslationPages(verses,measure);
 assert.ok(pages.length>2);assert.equal(pages[0].header,true);assert.ok(pages.slice(1).every(p=>!p.header));
 for(const verse of verses){
  const own=pages.filter(p=>p.ayah===verse.ayah);
  assert.equal(own.flatMap(p=>p.translationLines).join(' '),verse.translation);
  for(const page of own){assert.deepEqual(page.lines,[]);assert.ok(page.translationLines.every(line=>measure(line)<=READER_TRANSLATION_WIDTH));assert.ok(page.translationY+page.translationLines.length*26<=252);}
  assert.equal(readerAudioPage(pages,verse.ayah,0,60000),pages.indexOf(own[0]));
  assert.equal(readerAudioPage(pages,verse.ayah,60000,60000),pages.indexOf(own.at(-1)));
 }
 const continuous='這是一段很長的經文翻譯'.repeat(100);
 assert.equal(readerTranslationPages([{ayah:9,translation:continuous}],measure).flatMap(p=>p.translationLines).join(''),continuous);
});

test('audio pages follow media progress within the current ayah, including backwards seeks',()=>{
 const pages=[{ayahs:[1],lines:['other']},{ayahs:[2],lines:['one two three four five six'],translationLines:['first']},{ayahs:[2],lines:['seven eight nine'],translationLines:['next']},{ayahs:[2],lines:['seven eight nine'],translationLines:['the remaining translation also needs its own page']},{ayahs:[3],lines:['next ayah']}];
 assert.equal(readerAudioPage(pages,2,0,12000),1);
 assert.equal(readerAudioPage(pages,2,7000,12000),2);
 assert.equal(readerAudioPage(pages,2,11000,12000),3);
 assert.equal(readerAudioPage(pages,2,1000,12000),1);
 assert.equal(readerAudioPage(pages,2,15000,12000),3);
 assert.equal(readerAudioPage(pages,2,500,0),1);
 assert.equal(readerAudioPage(pages,2,500,NaN),1);
 assert.equal(readerAudioPage(pages,2,NaN,12000),1);
 assert.equal(readerAudioPage(pages,99,500,12000),-1);
});

test('audio hides the title after the opening and fills the reclaimed space without losing text',()=>{
 const verses=[1,2].map(ayah=>({ayah,arabic:Array.from({length:60},(_,i)=>'كلمة'+i).join(' '),translation:Array.from({length:100},(_,i)=>'word'+i).join(' ')}));
 const measure=t=>t.length*10;
 for(const hasBasmala of [false,true]){
  const pages=readerInterleavedPages(verses,measure,measure,520,hasBasmala,4,true);
  assert.equal(pages[0].header,true);assert.equal(pages[0].opening,hasBasmala);
  assert.ok(pages.slice(1).every(p=>p.header===false&&!p.opening));
  assert.ok(pages.some(p=>p.lines.length===3),'Reclaimed header fits an extra Arabic line');
  for(const verse of verses){
   const own=pages.filter(p=>p.ayah===verse.ayah),chunks=[];
   for(const page of own){const text=page.lines.join(' ');if(text!==chunks.at(-1))chunks.push(text);}
   assert.equal(chunks.join(' '),paginateReader([verse],measure,520,1).flatMap(p=>p.lines).join(' '));
   assert.equal(own.flatMap(p=>p.translationLines).join(' ').replace(/\s+/g,' ').trim(),verse.translation);
  }
  const single=readerSinglePages(verses,measure,measure,520,hasBasmala,32,true);
  assert.equal(single[0].header,true);assert.ok(single.slice(1).every(p=>!p.header));
  assert.ok(single.some(p=>p.lines.length===5));
  for(const page of single){
   if(page.lines.length)assert.ok(page.arabicY+(page.lines.length-1)*44<=226);
   if(page.translationLines.length)assert.ok(page.translationY+(page.translationLines.length-1)*26<=226);
  }
  for(const verse of verses){
   const own=single.filter(p=>p.ayah===verse.ayah);
   assert.equal(own.flatMap(p=>p.lines).join(' '),paginateReader([verse],measure,520,1).flatMap(p=>p.lines).join(' '));
   assert.equal(own.flatMap(p=>p.translationLines).join(' '),verse.translation);
  }
 }
});

test('interleaved pages retain Arabic above every translation segment',()=>{
 const verse={ayah:39,arabic:Array(50).fill('كلمة').join(' '),translation:Array.from({length:150},(_,i)=>'word'+i).join(' ')};
 const pages=readerInterleavedPages([verse],text=>text.length*10,text=>text.length*12);
 assert.ok(pages.length>1);
 for(const page of pages){assert.equal(page.kind,'interleaved');assert.ok(page.lines.length>0&&page.lines.length<=2);assert.ok(page.translationLines.length>0&&page.translationLines.length<=5);assert.deepEqual(page.ayahs,[39]);}
 const translated=pages.flatMap(page=>page.translationLines).join(' ').replace(/\s+/g,' ').trim();
 assert.equal(translated,verse.translation);
});
import {validateEvenHubPageContainer} from '@evenrealities/even_hub_sdk';
import {audioClock,audioProgress} from '../app/glassesAudioPlayer.js';

test('audio mini player clamps progress and reader pages reserve its height',()=>{
 assert.equal(audioClock(65000),'1:05');assert.equal(audioProgress({positionMs:3000,durationMs:2000}),1);assert.equal(audioProgress({positionMs:-1000,durationMs:2000}),0);assert.equal(audioProgress({positionMs:0,durationMs:0}),0);
 const verse={ayah:1,arabic:'بسم الله الرحمن الرحيم',translation:Array.from({length:140},(_,i)=>'word'+i).join(' ')};
 const pages=readerInterleavedPages([verse],t=>t.length*10,t=>t.length*10,520,false,4);
 assert.ok(pages.length>1);assert.ok(pages.every(p=>p.lines.length&&p.translationLines.length<=4));
 assert.equal(pages.flatMap(p=>p.translationLines).join(' ').replace(/\s+/g,' ').trim(),verse.translation);
});
test('reader contains all 114 surahs and 6236 intact numbered ayahs',()=>{
 let count=0;for(let s=1;s<=114;s++){const c=readerChapter(s);assert.equal(c.surah,s);assert.equal(c.verses.length,c.totalAyahs);c.verses.forEach((v,i)=>{assert.equal(v.ayah,i+1);assert.ok(v.arabic.trim());});count+=c.totalAyahs;}
 assert.equal(count,6236);assert.equal(readerChapter(9).basmala,'');assert.ok(readerChapter(2).basmala);assert.equal(readerChapter(0),null);assert.equal(readerChapter(115),null);assert.equal(readerChapter(1.5),null);
});
test('multi-page reading preserves every word and every ayah marker',()=>{
 const c=readerChapter(2), measure=t=>t.length*9;
 const pages=paginateReader(c.verses,measure,160);
 assert.ok(pages.length>1);assert.ok(pages.every(p=>p.lines.length<=5));
 const actual=pages.flatMap(p=>p.lines).join(' ').split(/\s+/);
 const expected=c.verses.flatMap(v=>(v.arabic+' ۝'+String(v.ayah).replace(/[0-9]/g,d=>String.fromCharCode(0x660+Number(d)))).trim().split(/\s+/));
 assert.deepEqual(actual,expected);for(let a=1;a<=286;a++)assert.ok(pages.some(p=>p.ayahs.includes(a)));
});
test('full-screen image layout is accepted by the Even SDK',()=>{
 const imageObject=Array.from({length:4},(_,i)=>({containerID:20+i,containerName:'reader'+i,xPosition:i%2*288,yPosition:Math.floor(i/2)*144,width:288,height:144,zOrderIndex:i+1}));
 const payload={containerTotalNum:5,textObject:[{containerID:1,containerName:'readerInput',xPosition:0,yPosition:0,width:576,height:288,content:' ',isEventCapture:1,zOrderIndex:0}],imageObject,menuObject:{menuItems:[{itemID:6,itemName:'Choose surah'},{itemID:9,itemName:'Back to translator'}]}};
 assert.equal(payload.imageObject.length,4,'hardware supports at most four image containers');
 assert.equal(payload.imageObject.reduce((area,t)=>area+t.width*t.height,0),576*288);
 const result=validateEvenHubPageContainer(payload);assert.equal(result.valid,true,JSON.stringify(result));
});

test('line scrolling overlaps three lines and retains every line through the end',()=>{
 const verses=readerChapter(18).verses, measure=t=>t.length*8;
 const windows=readerWindows(verses,measure,200,4);
 const lines=paginateReader(verses,measure,200,1).map(p=>p.lines[0]);
 assert.ok(windows.length>1);
 for(let i=1;i<windows.length;i++)assert.deepEqual(windows[i-1].lines.slice(1),windows[i].lines.slice(0,3));
 assert.deepEqual([...windows[0].lines,...windows.slice(1).map(p=>p.lines.at(-1))],lines);
 assert.ok(windows.at(-1).ayahs.includes(110));
});

test('reader includes selected Uzbek translation and Latin transliteration for every verse',()=>{
 const uz=readerChapter(1,'uz'),en=readerChapter(1,'en');
 assert.equal(uz.translationLang,'uz');assert.equal(uz.verses.length,7);
 for(let i=0;i<7;i++){assert.equal(uz.verses[i].arabic,en.verses[i].arabic);assert.ok(uz.verses[i].translation.trim());assert.ok(uz.verses[i].transliteration.trim());assert.notEqual(uz.verses[i].translation,en.verses[i].translation);}
});

test('glasses windows contain only the selected ayah, including long-ayah continuation',()=>{
 const c=readerChapter(2),v=c.verses[281];const pages=readerVerseWindows([v,c.verses[282]],t=>t.length*8,200,4);
 const long=pages.filter(p=>p.ayah===282);assert.ok(long.length>1);
 long.forEach((p,i)=>{assert.deepEqual(p.ayahs,[282]);assert.equal(p.part,i+1);assert.equal(p.parts,long.length);});
 assert.equal(pages[long.length].ayah,283);
 const actual=[...long[0].lines,...long.slice(1).map(p=>p.lines.at(-1))].join(' ');
 const expected=paginateReader([v],t=>t.length*8,200,1).map(p=>p.lines[0]).join(' ');
 assert.equal(actual,expected);
});

test('maximum-ayah pages preserve all text and reserve a separate opening line',()=>{
 const verses=readerChapter(112).verses,measure=t=>t.length*8;
 const pages=readerPackedWindows(verses,measure,520,4,true);
 assert.ok(pages[0].ayahs.length>1);
 assert.ok(pages[0].lines.length<=3);
 assert.equal(pages[0].opening,true);
 assert.ok(pages.slice(1).every(p=>!p.opening));
 assert.deepEqual(pages.flatMap(p=>p.lines),paginateReader(verses,measure,520,1).flatMap(p=>p.lines));
});

test('single-ayah reading fits short translations and completes long translations before next ayah',()=>{
 const short=readerChapter(112).verses[0],measure=t=>t.length*10;
 const combined=readerSinglePages([short],measure,measure);assert.equal(combined.length,1);assert.equal(combined[0].kind,'combined');assert.ok(combined[0].translationLines.length);
 const long=readerChapter(2).verses[281],next=readerChapter(2).verses[282];const pages=readerSinglePages([long,next],measure,measure);
 const own=pages.filter(p=>p.ayah===282);assert.ok(own.some(p=>p.kind==='translation'));const firstTranslation=own.findIndex(p=>p.kind==='translation');assert.ok(own.slice(0,firstTranslation).every(p=>p.kind==='arabic'));assert.ok(own.slice(firstTranslation).every(p=>p.kind==='translation'));
 assert.equal(own.flatMap(p=>p.translationLines).join(' '),long.translation);assert.equal(pages[own.length].ayah,283);
 assert.equal(own.flatMap(p=>p.lines).join(' '),paginateReader([long],measure,520,1).flatMap(p=>p.lines).join(' '));
 assert.ok(own.every(p=>!p.translationLines.length||p.translationY+(p.translationLines.length-1)*26<=258));
});
