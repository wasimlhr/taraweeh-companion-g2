import {createReadStream,createWriteStream,readFileSync} from 'node:fs';
import {mkdir,rename,unlink,link,writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {Readable,Transform} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {duriUnits} from './duriReading.js';

export const MP3QURAN_RECITERS=Object.freeze({
 'saad-al-ghamdi':{folder:'saad-ghamdi',read:30,riwaya:'hafs',playbackMode:'ayah'},
 'noreen-muhammad-siddiq':{folder:'noreen-siddiq',read:138,riwaya:'ad-duri',playbackMode:'ayah',timingVersion:1},
});
let noreenTimingBundle;
export function noreenTimingSource(surah){
 if(!noreenTimingBundle)noreenTimingBundle=JSON.parse(readFileSync(new URL('./data/noreen-timings.json',import.meta.url),'utf8'));
 if(noreenTimingBundle.version!==1||noreenTimingBundle.chapters.length!==114)throw Error('Noreen timing bundle is incomplete');
 return {...noreenTimingBundle.chapters[surah-1],source:noreenTimingBundle.source};
}
export function noreenCues(timing,audio){
 if(timing.sha256!==audio.sha256||Math.abs(timing.durationMs-audio.durationMs)>1)throw Error('Noreen recording does not match its verified timings');
 const units=duriUnits(timing.surah);
 if(!units||!timing.tracks?.length)throw Error('Missing Al-Duri timing references');
 return units.map(unit=>{
  const first=timing.tracks[unit.ayah-1],last=timing.tracks[unit.ayahEnd-1];
  if(first?.ayah!==unit.ayah||last?.ayah!==unit.ayahEnd)throw Error('Incomplete Al-Duri timing references');
  return {ayah:unit.ayah,ayahEnd:unit.ayahEnd,ayahLabel:unit.ayahLabel,startMs:first.startMs,endMs:last.endMs,durationMs:last.endMs-first.startMs};
 });
}
const MAX_CHAPTER_BYTES=160*1024*1024;
export function mp3QuranSourceUrl(id,surah){const r=MP3QURAN_RECITERS[id];if(!r||!Number.isInteger(surah)||surah<1||surah>114)throw Error('Invalid MP3Quran recording');return 'https://cdn.mp3quran.net/audio/'+r.folder+'/r1/'+String(surah).padStart(3,'0')+'.mp3';}

// Inspect complete MPEG frames in bounded chunks; long surahs never occupy a
// chapter-sized buffer in the backend. Preserve the source bitrate and bytes.
export async function inspectMp3File(path){
 let pending=Buffer.alloc(0),initial=true,skip=0,junk=0,ended=false,frames=0,durationMs=0,audioBytes=0,total=0,tagBytes=0;const bitrates=new Set();
 for await(const chunk of createReadStream(path)){
  total+=chunk.length;if(ended)continue;let data=Buffer.concat([pending,chunk]);pending=Buffer.alloc(0);
  if(initial){if(data.length<10){pending=data;continue;}initial=false;if(data.subarray(0,3).toString()==='ID3'){skip=10+[data[6],data[7],data[8],data[9]].reduce((n,b)=>n*128+(b&127),0)+((data[5]&16)?10:0);tagBytes=skip;if(skip>16*1024*1024)throw Error('Oversized MP3 tag');}}
  if(skip){const n=Math.min(skip,data.length);skip-=n;data=data.subarray(n);}
  let at=0;
  while(at+4<=data.length){
   const h=data.readUInt32BE(at);if((h>>>21)!==2047){if(!frames&&junk++<4096){at++;continue;}ended=true;break;}
   const version=(h>>>19)&3,layer=(h>>>17)&3,index=(h>>>12)&15,sampleIndex=(h>>>10)&3,padding=(h>>>9)&1;
   if(version===1||layer!==1||sampleIndex===3||index===0||index===15)throw Error('Invalid MP3 frame');
   const rate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index];
   const sample=[44100,48000,32000][sampleIndex]/(version===3?1:version===2?2:4),length=Math.floor((version===3?144000:72000)*rate/sample)+padding;
   if(at+length>data.length)break;
   bitrates.add(rate);durationMs+=(version===3?1152:576)*1000/sample;frames++;audioBytes+=length;at+=length;
  }
  if(!ended)pending=data.subarray(at);
 }
 if(frames<3||skip||(!ended&&pending.length)||audioBytes<(total-tagBytes)*.8)throw Error('Invalid or truncated MP3 audio');
 return {durationMs:Math.round(durationMs),bitrateKbps:bitrates.size===1?[...bitrates][0]:Math.round(audioBytes*8/durationMs),frames};
}

export function validateAyahTimings(rows,count,durationMs){
 if(!Array.isArray(rows))throw Error('Missing official ayah timings');
 const cues=rows.filter(r=>r.ayah>0);let previousEnd=0;
 if(cues.length!==count)throw Error('Incomplete official ayah timings');
 return cues.map((r,i)=>{if(r.ayah!==i+1||!Number.isInteger(r.start_time)||!Number.isInteger(r.end_time)||r.start_time<previousEnd||r.end_time<=r.start_time||r.end_time>durationMs+100)throw Error('Invalid official ayah timings');previousEnd=r.end_time;return {ayah:r.ayah,startMs:r.start_time,endMs:Math.min(r.end_time,durationMs),durationMs:Math.min(r.end_time,durationMs)-r.start_time};});
}

export class Mp3QuranInstaller{
 constructor(root,{fetcher=fetch,validate=m=>m,counts,noreenTimings=noreenTimingSource}={}){this.root=resolve(root);this.fetcher=fetcher;this.validate=validate;this.counts=counts;this.noreenTimings=noreenTimings;this.jobs=new Map();this.queue=Promise.resolve();}
 install(id,surah){mp3QuranSourceUrl(id,surah);const key=id+':'+surah;if(this.jobs.has(key))return this.jobs.get(key);if(this.jobs.size>=8)throw Error('Audio preparation queue is busy');const job=this.queue.catch(()=>{}).then(()=>this.build(id,surah));this.queue=job;this.jobs.set(key,job);job.finally(()=>this.jobs.delete(key)).catch(()=>{});return job;}
 async download(url,temp){
  let last;
  for(let attempt=0;attempt<3;attempt++)try{
   const response=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Audio upstream status '+response.status);
   if(Number(response.headers.get('content-length'))>MAX_CHAPTER_BYTES)throw Error('Audio chapter exceeds limit');
   const hash=createHash('sha256');let bytes=0;
   await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>MAX_CHAPTER_BYTES){done(Error('Audio chapter exceeds limit'));return;}hash.update(chunk);done(null,chunk);}}),createWriteStream(temp));
   return {bytes,sha256:hash.digest('hex'),...await inspectMp3File(temp)};
  }catch(error){last=error;await unlink(temp).catch(()=>{});if(attempt<2)await new Promise(r=>setTimeout(r,300*2**attempt));}
  throw last;
 }
 async build(id,surah){
  const source=MP3QURAN_RECITERS[id],assets=resolve(this.root,'assets');await mkdir(assets,{recursive:true});await mkdir(resolve(this.root,id),{recursive:true});
  const temp=resolve(assets,randomUUID()+'.download');
  try{
   const audio=await this.download(mp3QuranSourceUrl(id,surah),temp),file=audio.sha256+'.mp3';
   let cues=[{ayah:null,durationMs:audio.durationMs}],timing=null;
   if(source.timingVersion){timing=this.noreenTimings(surah);cues=noreenCues(timing,audio);}
   else if(source.playbackMode==='ayah'){
    const response=await this.fetcher('https://www.mp3quran.net/api/v3/ayat_timing?surah='+surah+'&read='+source.read,{redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Official timing service unavailable');
    cues=validateAyahTimings(await response.json(),this.counts[surah-1],audio.durationMs);
   }
   const rights={redistributionApproved:true,license:'MP3Quran published permission to copy materials and use source links; reciter rights retained',source:'https://www.mp3quran.net/eng/privacy',reviewedBy:'Project source review 2026-10-23',attribution:'Recitation: '+id+'; audio'+(source.playbackMode==='ayah'?' and ayah timings':'')+' supplied by MP3Quran.net. Reciter rights retained.'};
   if(timing){rights.license+='; timing data Apache-2.0';rights.attribution='Noreen Muhammad Siddiq — Al-Duri. Audio: MP3Quran.net. Verified recording timings: zaibihassan/Quranic-Recitation-Data (Apache-2.0), revision '+timing.source.revision+'. Arabic: Quranpedia.net, 2026-10-23. Reciter rights retained.';}
   const tracks=cues.map(c=>({...c,file,sha256:audio.sha256,bytes:audio.bytes}));
   const metadata={reciter:id,surah,bitrateKbps:audio.bitrateKbps,assetDurationMs:audio.durationMs,playbackMode:source.playbackMode,riwaya:source.riwaya,syncAvailable:source.playbackMode==='ayah',rights,tracks};
   if(timing){metadata.timingVersion=source.timingVersion;metadata.timingRevision=timing.source.revision;}
   const manifest=this.validate({...metadata,revision:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')});
   await link(temp,resolve(assets,file)).catch(e=>{if(e.code!=='EEXIST')throw e;});
   const target=resolve(this.root,id,surah+'.json'),pending=target+'.'+randomUUID()+'.tmp';
   try{await writeFile(pending,JSON.stringify(manifest));await rename(pending,target);}finally{await unlink(pending).catch(()=>{});}
   return manifest;
  }finally{await unlink(temp).catch(()=>{});}
 }
}
