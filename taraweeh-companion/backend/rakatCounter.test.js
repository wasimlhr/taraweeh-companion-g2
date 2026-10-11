import test from 'node:test';
import assert from 'node:assert/strict';
import {RakatCounter} from './rakatCounter.js';
const verse=(c,s,a,t,confidence=1)=>c.feedVerse({surah:s,ayah:a,locked:true,confidence,now:t});
test('new Fatiha counts once, duplicates and overlapping tails do not',()=>{
 const c=new RakatCounter(); verse(c,1,2,0); verse(c,1,3,1000); verse(c,1,6,5000);
 verse(c,1,2,6000); assert.equal(c.rakat,1);
 verse(c,114,1,10000); verse(c,1,2,60000); verse(c,1,3,61000); assert.equal(c.rakat,2);
 verse(c,1,7,65000); verse(c,1,2,120000); assert.equal(c.rakat,3);
});
test('noise, display predictions, prayer cues and elapsed time cannot count',()=>{
 const c=new RakatCounter();c.feedVerse({surah:1,ayah:2,confidence:1});verse(c,1,2,0,0.2);
 for(let i=0;i<20;i++){c.feedCue({kind:'takbeer'});c.tick({now:999999});}
 assert.equal(c.rakat,1);assert.equal(c.seenFatiha,false);
});
test('manual corrections and reconnect retain count and opening deduplication',()=>{
 const c=new RakatCounter();verse(c,1,2,1000);verse(c,1,7,10000);c.adjustRakat(4);
 const saved=c.toJSON(11000),r=new RakatCounter();assert.equal(r.restore(saved,{now:12000}),true);
 verse(r,1,2,13000);assert.equal(r.rakat,5);verse(r,1,2,60000);assert.equal(r.rakat,6);
 r.adjustRakat(-100);assert.equal(r.rakat,1);
});
