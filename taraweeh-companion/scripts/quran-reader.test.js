import test from 'node:test';
import assert from 'node:assert/strict';
import {readerChapter} from '../backend/quranReader.js';
import {paginateReader,readerWindows,readerVerseWindows,readerPackedWindows,readerSinglePages,readerInterleavedPages,readerAudioPage} from '../app/readerPagination.js';

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
