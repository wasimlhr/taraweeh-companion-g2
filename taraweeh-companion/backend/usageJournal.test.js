import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UsageJournal} from './usageJournal.js';
test('session summaries survive restart, retain outcomes, and exclude content and credentials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'quran-usage-'));try {
  let clock=1000;const path=join(dir,'usage.json'),j=new UsageJournal({path,now:()=>clock});
  const id=j.begin({provider:'groq',audioSource:'g2',taraweehMode:false,apiKey:'SECRET'});
  j.event(id,{type:'asr',text:'PRIVATE_RECITATION',latencyMs:300});j.event(id,{type:'asr',text:''});
  j.event(id,{type:'error',status:429,message:'sk-SECRET'});j.match(id,{mode:'LOCKED',surah:36,ayah:1});
  j.match(id,{mode:'LOCKED',surah:36,ayah:1});j.match(id,{mode:'LOCKED',surah:36,ayah:2});
  clock=4000;j.end(id);
  const restored=new UsageJournal({path}),s=restored.snapshot().sessions[0];
  assert.equal(s.mode,'translate');assert.equal(s.durationMs,3000);assert.equal(s.matches,2);
  assert.equal(s.transcripts,2);assert.equal(s.emptyTranscripts,1);assert.equal(s.errors,1);
  assert.deepEqual(s.verses,['36:1','36:2']);assert.doesNotMatch(readFileSync(path,'utf8'),/PRIVATE|SECRET|apiKey/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('retention evicts closed sessions and audio-only activity is not a successful match',()=>{
 const j=new UsageJournal({maxSessions:2});for(let i=0;i<4;i++){const id=j.begin();j.event(id,{type:'audio',voice:false});j.end(id);}
 assert.equal(j.sessions.length,2);assert.equal(j.snapshot().totals.matches,0);
});
