import test from'node:test';import assert from'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{RecitationStore}from'./recitations.js';import{inspectMp3,recitationSourceUrl}from'./recitationInstaller.js';
import{validateAyahTimings,mp3QuranSourceUrl,inspectMp3File}from'./mp3QuranRecitations.js';
import{writeFileSync,readdirSync}from'node:fs';
import{createHash}from'node:crypto';
function fixture(){const frames=[];for(let i=0;i<12;i++){const f=Buffer.alloc(208);f.writeUInt32BE(0xfffb5000);frames.push(f);}return Buffer.concat(frames);}
test('MP3 header inspection verifies real frame duration/bitrate and rejects corrupt content',()=>{assert.equal(inspectMp3(fixture()).bitrateKbps,64);assert.ok(inspectMp3(fixture()).durationMs>300);assert.throws(()=>inspectMp3(Buffer.from('not mp3')));const bad=fixture();bad.writeUInt32BE(0xfffb9000);assert.throws(()=>inspectMp3(bad),/64kbps/);assert.throws(()=>recitationSourceUrl('https://evil.test',1,1));assert.throws(()=>recitationSourceUrl('alafasy',115,1));assert.match(recitationSourceUrl('alafasy',2,1),/\/8\.mp3$/);});
test('on-demand install deduplicates jobs, writes actual hashes and exposes only owned paths',async()=>{const root=mkdtempSync(join(tmpdir(),'recitation-fetch-'));let calls=0;const store=new RecitationStore(root,{fetcher:async url=>{calls++;assert.match(url,/^https:\/\/cdn\.islamic\.network\/quran\/audio\/64\/ar\.husary\/\d+\.mp3$/);return new Response(fixture());}});try{assert.equal(store.catalog().reciters[1].downloadable,true);assert.equal(store.catalog().reciters[1].availableSurahs.length,114);const [a,b]=await Promise.all([store.ensure('husary',112),store.ensure('husary',112)]);assert.equal(calls,4);assert.equal(a.revision,b.revision);assert.equal(a.tracks.length,4);assert.equal(a.tracks[0].bytes,fixture().length);assert.match(a.tracks[0].url,/^\/audio\/[a-f0-9]{64}\.mp3$/);const installed=JSON.parse(readFileSync(join(root,'husary','112.json')));assert.equal(installed.rights.termsUpdated,'2026-06-14');assert.equal(store.catalog().reciters[1].available,true);await store.ensure('husary',112);assert.equal(calls,4);}finally{rmSync(root,{recursive:true,force:true});}});
test('failed import never publishes incomplete chapter; source fetch can be disabled',async()=>{const root=mkdtempSync(join(tmpdir(),'recitation-fail-'));try{const store=new RecitationStore(root,{fetcher:async()=>new Response('corrupt audio')});await assert.rejects(()=>store.ensure('alafasy',112));assert.equal(existsSync(join(root,'alafasy','112.json')),false);assert.equal(store.publicManifest('alafasy',112),null);const disabled=new RecitationStore(root,{fetchEnabled:false});assert.equal(disabled.catalog().reciters[0].downloadable,false);assert.equal(await disabled.ensure('alafasy',112),null);}finally{rmSync(root,{recursive:true,force:true});}});

function sourceFixture(count=400){const frame=Buffer.alloc(417);frame.writeUInt32BE(0xfffb9000);return Buffer.concat(Array(count).fill(frame));}
const sourceCues=Array.from({length:4},(_,i)=>({ayah:i+1,start_time:i*60,end_time:(i+1)*60}));
test('Saad shares verified source audio with complete official ayah cues; downloads count bytes once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mp3quran-cues-'));const data=sourceFixture();let calls=0;
 const store=new RecitationStore(root,{fetcher:async url=>{calls++;if(url.includes('/ayat_timing?'))return Response.json(sourceCues);assert.equal(url,mp3QuranSourceUrl('saad-al-ghamdi',112));return new Response(data);}});
 try{
  const [a,b]=await Promise.all([store.ensure('saad-al-ghamdi',112),store.ensure('saad-al-ghamdi',112)]);
  assert.equal(calls,2);assert.equal(a.revision,b.revision);assert.equal(a.bitrateKbps,128);assert.equal(a.playbackMode,'ayah');assert.equal(a.syncAvailable,true);assert.equal(a.tracks.length,4);
  assert.equal(new Set(a.tracks.map(t=>t.url)).size,1);assert.equal(a.tracks[1].startMs,60);assert.equal(a.tracks[1].durationMs,60);assert.equal(a.rights,undefined);assert.ok(!JSON.stringify(a).includes('https://'));
  assert.equal(store.catalog().reciters.find(r=>r.id==='saad-al-ghamdi').bytes,data.length);
  assert.equal((await inspectMp3File(join(root,'assets',a.tracks[0].sha256+'.mp3'))).frames,400);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Noreen installs verified automatic timings and rejects a changed recording',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mp3quran-surah-'));let calls=0;
 const data=sourceFixture(),sha256=createHash('sha256').update(data).digest('hex'),durationMs=Math.round(400*1152*1000/44100);
 const timing={surah:112,sha256,durationMs,source:{revision:'a'.repeat(40)},tracks:sourceCues.map((c,i)=>({ayah:c.ayah,startMs:c.start_time,endMs:i===3?durationMs:c.end_time}))};
 const store=new RecitationStore(root,{noreenTimings:()=>timing,fetcher:async url=>{calls++;assert.equal(url,mp3QuranSourceUrl('noreen-muhammad-siddiq',112));return new Response(data);}});
 try{const m=await store.ensure('noreen-muhammad-siddiq',112);assert.equal(calls,1);assert.equal(m.playbackMode,'ayah');assert.equal(m.riwaya,'ad-duri');assert.equal(m.syncAvailable,true);assert.equal(m.timingVersion,1);assert.equal(m.tracks.length,4);assert.equal(m.tracks[0].ayah,1);assert.equal(m.tracks[0].startMs,0);assert.match(m.reciterName,/Al-Duri/);
  const changed=new RecitationStore(join(root,'changed'),{noreenTimings:()=>({...timing,sha256:'0'.repeat(64)}),fetcher:async()=>new Response(data)});
  await assert.rejects(()=>changed.ensure('noreen-muhammad-siddiq',112),/does not match/);assert.equal(changed.manifest('noreen-muhammad-siddiq',112),null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid or incomplete official cues and truncated MP3 never publish playable packs',async()=>{
 assert.throws(()=>mp3QuranSourceUrl('alafasy',1));assert.throws(()=>mp3QuranSourceUrl('saad-al-ghamdi',115));
 assert.throws(()=>validateAyahTimings(sourceCues.slice(1),4,1000),/Incomplete/);
 assert.throws(()=>validateAyahTimings([{ayah:1,start_time:0,end_time:2000}],1,1000),/Invalid/);
 assert.throws(()=>validateAyahTimings([{ayah:1,start_time:0,end_time:100},{ayah:2,start_time:50,end_time:200}],2,1000),/Invalid/);
 const root=mkdtempSync(join(tmpdir(),'mp3quran-reject-'));const store=new RecitationStore(root,{fetcher:async url=>url.includes('/ayat_timing?')?Response.json([]):new Response(sourceFixture())});
 try{await assert.rejects(()=>store.ensure('saad-al-ghamdi',112),/Incomplete/);assert.equal(store.publicManifest('saad-al-ghamdi',112),null);assert.deepEqual(readdirSync(join(root,'assets')),[]);const file=join(root,'truncated.mp3');writeFileSync(file,sourceFixture().subarray(0,-10));await assert.rejects(()=>inspectMp3File(file),/truncated/);}finally{rmSync(root,{recursive:true,force:true});}
});
