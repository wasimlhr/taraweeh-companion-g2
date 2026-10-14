import test from 'node:test';
import assert from 'node:assert/strict';
import {readerChapter} from '../backend/quranReader.js';
import {paginateReader,readerWindows} from '../app/readerPagination.js';
import {validateEvenHubPageContainer} from '@evenrealities/even_hub_sdk';
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
 const imageObject=Array.from({length:6},(_,i)=>({containerID:20+i,containerName:'reader'+i,xPosition:i%2*288,yPosition:Math.floor(i/2)*96,width:288,height:96,zOrderIndex:i+1}));
 const payload={containerTotalNum:7,textObject:[{containerID:1,containerName:'readerInput',xPosition:0,yPosition:0,width:1,height:1,content:' ',isEventCapture:1,zOrderIndex:0}],imageObject,menuObject:{menuItems:[{itemID:6,itemName:'Choose surah'},{itemID:9,itemName:'Back to translator'}]}};
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
