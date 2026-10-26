import test from'node:test';import assert from'node:assert/strict';
import {ReaderPlayback,PLAYBACK_RATES}from'../app/readerPlayback.js';
import {ReaderAudioCache}from'../app/readerAudioCache.js';
import {webcrypto,createHash}from'node:crypto';
globalThis.crypto ||= webcrypto;
class FakeAudio extends EventTarget{currentTime=0;duration=2;paused=true;src='';load(){this.dispatchEvent(new Event('loadedmetadata'));}removeAttribute(){}pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}async play(){this.paused=false;this.dispatchEvent(new Event('playing'));}}
const manifest={reciter:'alafasy',surah:112,revision:'test',tracks:[{ayah:1,url:'/one',durationMs:2000},{ayah:2,url:'/two',durationMs:2000}]};

test('page navigation prepares the target clock position before ready for files and shared surah cues',async()=>{
 for(const segmented of [false,true]){
  const audio=new FakeAudio();audio.load=()=>{};
  const prepared=[],p=new ReaderPlayback({audio,prepareTrack:s=>prepared.push(s)});
  const pack=segmented?{...manifest,tracks:[{ayah:1,url:'/same',startMs:0,endMs:2000},{ayah:2,url:'/same',startMs:2000,endMs:4000}]}:manifest;
  await p.load(pack);audio.dispatchEvent(new Event('loadedmetadata'));await p.play();
  await p.select(1,{autoplay:true,positionMs:1000});
  assert.equal(prepared.at(-1).ayah,2);assert.equal(prepared.at(-1).positionMs,1000);assert.equal(p.state,'playing');
  audio.dispatchEvent(new Event('loadedmetadata'));assert.equal(p.snapshot().positionMs,1000);
  p.pause();await p.select(0,{positionMs:500});assert.equal(prepared.at(-1).positionMs,500);assert.equal(audio.paused,true);
  p.dispose();
 }
});

test('playback defaults to 1x and supported speed changes preserve position, pitch and transport state',async()=>{
 const audio=new FakeAudio(),p=new ReaderPlayback({audio});assert.equal(audio.playbackRate,1);assert.equal(audio.defaultPlaybackRate,1);await p.load(manifest);await p.play();audio.currentTime=.5;
 for(const speed of PLAYBACK_RATES){p.setPlaybackRate(speed);assert.equal(audio.playbackRate,speed);assert.equal(audio.defaultPlaybackRate,speed);assert.equal(p.snapshot().playbackRate,speed);assert.equal(p.snapshot().positionMs,500);assert.equal(p.state,'playing');assert.equal(audio.preservesPitch,true);}
 p.pause();p.setPlaybackRate(1.5);assert.equal(audio.paused,true);await p.select(1);assert.equal(audio.playbackRate,1.5);await p.load({...manifest,reciter:'husary',revision:'another'},{ayah:2});assert.equal(audio.playbackRate,1.5);
 for(const speed of [0,-1,3,'bad',NaN,Infinity]){p.setPlaybackRate(speed);assert.equal(audio.playbackRate,1);}
 p.dispose();
});
test('media ended advances ayah; waiting and time do not invent progress',async()=>{const audio=new FakeAudio(),seen=[];const p=new ReaderPlayback({audio,onChange:s=>seen.push(s)});await p.load(manifest);await p.play();audio.currentTime=.5;audio.dispatchEvent(new Event('timeupdate'));assert.equal(p.snapshot().positionMs,500);audio.dispatchEvent(new Event('waiting'));assert.equal(p.state,'buffering');assert.equal(p.snapshot().ayah,1);audio.dispatchEvent(new Event('ended'));await new Promise(r=>setTimeout(r,0));assert.equal(p.snapshot().ayah,2);assert.equal(p.state,'playing');audio.dispatchEvent(new Event('ended'));assert.equal(p.state,'ended');p.dispose();});
test('latest selection wins async cache lookup and autoplay failures are visible',async()=>{let release;const a=new FakeAudio();const p=new ReaderPlayback({audio:a,resolveTrack:t=>t.ayah===1?new Promise(r=>release=r):Promise.resolve(t.url)});const old=p.load(manifest);await p.select(1);release('/stale');await old;assert.equal(a.src,'/two');a.play=async()=>{throw Object.assign(Error(),{name:'NotAllowedError'});};await p.play();assert.equal(p.snapshot().error,'NotAllowedError');p.dispose();});

test('loading another reciter finds the reading unit containing the current verse',async()=>{
 const audio=new FakeAudio(),p=new ReaderPlayback({audio});
 const pack={reciter:'noreen-muhammad-siddiq',surah:3,revision:'merged',riwaya:'ad-duri',tracks:[{ayah:1,ayahEnd:2,url:'/same',startMs:0,endMs:10000},{ayah:12,ayahEnd:13,ayahLabel:'12',url:'/same',startMs:10000,endMs:25000},{ayah:14,ayahEnd:14,url:'/same',startMs:25000,endMs:30000}]};
 await p.load(pack,{ayah:13});audio.dispatchEvent(new Event('loadedmetadata'));
 assert.equal(p.index,1);assert.equal(p.snapshot().ayah,12);assert.equal(p.snapshot().ayahEnd,13);assert.equal(audio.currentTime,10);assert.equal(audio.paused,true);p.dispose();
});

test('changing reciter cancels a pending old track so it cannot restart playback',async()=>{
 let release;const audio=new FakeAudio(),p=new ReaderPlayback({audio,resolveTrack:t=>t.ayah===2?new Promise(r=>release=r):Promise.resolve(t.url)});
 await p.load(manifest);const pending=p.select(1,{autoplay:true});p.pause({cancelPending:true});release('/stale-reciter');await pending;
 assert.equal(audio.src,'/one');assert.equal(audio.paused,true);assert.equal(p.state,'paused');assert.equal(p.pendingSeek,null);p.dispose();
});

test('a new recording stays loading and cannot play until its text is displayed',async()=>{
 let release;const audio=new FakeAudio(),seen=[];
 const p=new ReaderPlayback({audio,onChange:s=>seen.push(s.state),prepareTrack:()=>new Promise(r=>release=r)});
 const loading=p.load(manifest);await new Promise(r=>setTimeout(r,0));
 audio.dispatchEvent(new Event('waiting'));
 assert.equal(p.state,'loading');await p.play();assert.equal(audio.paused,true);assert.ok(!seen.includes('ready'));
 release();await loading;assert.equal(p.state,'ready');await p.play();assert.equal(audio.paused,false);p.dispose();
});

test('a superseded text update cannot mark the new recording ready or resume old audio',async()=>{
 let release;const audio=new FakeAudio();
 const p=new ReaderPlayback({audio,prepareTrack:s=>s.ayah===1?new Promise(r=>release=r):Promise.resolve()});
 const first=p.load(manifest);await new Promise(r=>setTimeout(r,0));
 p.pause({cancelPending:true});await p.select(1);await p.play();p.pause();
 release();await first;assert.equal(p.snapshot().ayah,2);assert.equal(p.state,'paused');assert.equal(audio.paused,true);p.dispose();
});

test('failed text preparation keeps playback stopped until the recording is loaded again',async()=>{
 const audio=new FakeAudio(),p=new ReaderPlayback({audio,prepareTrack:async()=>{throw Error('Display unavailable');}});
 await p.load(manifest);assert.equal(p.state,'error');await p.play();assert.equal(audio.paused,true);
 p.prepareTrack=async()=>{};await p.load(manifest);await p.play();assert.equal(audio.paused,false);p.dispose();
});

test('opening a paused preview cancels autoplay while the next ayah is still preparing',async()=>{
 let release;const audio=new FakeAudio(),p=new ReaderPlayback({audio});await p.load(manifest);await p.play();
 p.prepareTrack=()=>new Promise(r=>release=r);const pending=p.step(1);await new Promise(r=>setTimeout(r,0));p.pause();release();await pending;
 assert.equal(p.snapshot().ayah,2);assert.equal(audio.paused,true);assert.notEqual(p.state,'playing');p.dispose();
});
test('cache rejects third party URLs and reports unsupported offline storage',async()=>{const cache=new ReaderAudioCache({baseUrl:'https://owned.test',storage:null});assert.throws(()=>cache.url({url:'https://other.test/audio/a.mp3'}));assert.equal(await cache.has(manifest),false);await assert.rejects(()=>cache.download(manifest),/unavailable/);});
test('offline cache verifies bytes/hash, resumes and removes complete chapter',async()=>{const entries=new Map(),store={match:async k=>entries.get(k)?.clone(),put:async(k,v)=>entries.set(k,v),delete:async k=>entries.delete(k)};const data='test recording fixture',hash=createHash('sha256').update(data).digest('hex');let requests=0;const track={ayah:1,url:'/audio/'+hash+'.mp3',bytes:Buffer.byteLength(data),sha256:hash};const m={tracks:[track]};const cache=new ReaderAudioCache({baseUrl:'https://owned.test',storage:{open:async()=>store},fetcher:async()=>{requests++;return new Response(data);}});assert.equal(await cache.has(m),false);await cache.download(m);assert.equal(await cache.has(m),true);await cache.download(m);assert.equal(requests,1);await cache.remove(m);assert.equal(await cache.has(m),false);await assert.rejects(()=>cache.download({tracks:[{...track,sha256:'0'.repeat(64)}]}),/checksum/);assert.equal(entries.size,0);});
test('cancelled offline download does not request assets',async()=>{let fetched=false;const cache=new ReaderAudioCache({baseUrl:'https://owned.test',storage:{open:async()=>({})},fetcher:async()=>{fetched=true;}});const controller=new AbortController();controller.abort();await assert.rejects(()=>cache.download(manifest,{signal:controller.signal}),{name:'AbortError'});assert.equal(fetched,false);});

test('official surah cues advance ayahs on the media clock without reloading or pausing audio',async()=>{
 const audio=new FakeAudio();audio.duration=10;let loads=0,resolves=0;audio.load=()=>loads++;
 const pack={reciter:'saad-al-ghamdi',surah:112,revision:'cue-test',playbackMode:'ayah',tracks:[{ayah:1,url:'/shared',startMs:2000,endMs:5000,durationMs:3000},{ayah:2,url:'/shared',startMs:5000,endMs:8000,durationMs:3000}]};
 const p=new ReaderPlayback({audio,resolveTrack:async t=>{resolves++;return t.url;}});await p.load(pack);audio.dispatchEvent(new Event('loadedmetadata'));assert.equal(audio.currentTime,2);assert.equal(p.snapshot().durationMs,3000);
 await p.play();audio.currentTime=4.9;audio.dispatchEvent(new Event('timeupdate'));assert.equal(p.snapshot().ayah,1);audio.currentTime=5.1;audio.dispatchEvent(new Event('timeupdate'));assert.equal(p.snapshot().ayah,2);assert.equal(p.snapshot().positionMs,100);assert.equal(audio.paused,false);assert.equal(loads,1);assert.equal(resolves,1);
 p.pause();p.seek(1000);assert.equal(audio.currentTime,6);assert.equal(p.snapshot().ayah,2);await p.select(0);assert.equal(audio.currentTime,2);assert.equal(loads,1);await p.select(1);await p.play();audio.currentTime=8;audio.dispatchEvent(new Event('timeupdate'));assert.equal(p.state,'ended');assert.equal(audio.paused,true);p.dispose();
});
test('whole-surah playback has no invented ayah and seeks across the whole recording',async()=>{
 const audio=new FakeAudio();audio.duration=60;const p=new ReaderPlayback({audio});await p.load({reciter:'noreen-muhammad-siddiq',surah:1,playbackMode:'surah',riwaya:'ad-duri',syncAvailable:false,tracks:[{ayah:null,url:'/whole',durationMs:60000}]});audio.dispatchEvent(new Event('loadedmetadata'));await p.play();p.seek(45000);assert.equal(p.snapshot().positionMs,45000);assert.equal(p.snapshot().ayah,null);assert.equal(p.snapshot().syncAvailable,false);assert.equal(p.snapshot().riwaya,'ad-duri');audio.dispatchEvent(new Event('ended'));assert.equal(p.state,'ended');p.dispose();
});
test('shared surah audio downloads once and reports the actual chapter size',async()=>{
 const entries=new Map(),store={match:async k=>entries.get(k)?.clone(),put:async(k,v)=>entries.set(k,v),delete:async k=>entries.delete(k)},data='shared recording',hash=createHash('sha256').update(data).digest('hex');let requests=0,progress;
 const track={url:'/audio/'+hash+'.mp3',bytes:Buffer.byteLength(data),sha256:hash},pack={tracks:[{...track,ayah:1},{...track,ayah:2}]};
 const cache=new ReaderAudioCache({baseUrl:'https://owned.test',storage:{open:async()=>store},fetcher:async()=>{requests++;return new Response(data);}});await cache.download(pack,{onProgress:p=>progress=p});assert.equal(requests,1);assert.equal(progress.totalBytes,track.bytes);assert.equal(progress.bytes,track.bytes);assert.equal(await cache.has(pack),true);await cache.remove(pack);assert.equal(entries.size,0);
});
