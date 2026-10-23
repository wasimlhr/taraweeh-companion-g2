import {mkdir,writeFile,rename,unlink,link} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const RECITATION_SOURCES=Object.freeze({alafasy:'ar.alafasy',husary:'ar.husary','abdul-basit-murattal':'ar.abdulbasitmurattal'});
const counts=JSON.parse(readFileSync(new URL('./data/quran-json/quran_en.json',import.meta.url),'utf8')).map(c=>c.verses.length);
const jobs=new Map(),waiting=[];let running=0;
function schedule(task){return new Promise((resolve,reject)=>{waiting.push({task,resolve,reject});drain();});}
function drain(){while(running<2&&waiting.length){const j=waiting.shift();running++;Promise.resolve().then(j.task).then(j.resolve,j.reject).finally(()=>{running--;drain();});}}
export function recitationSourceUrl(id,surah,ayah){if(!Object.hasOwn(RECITATION_SOURCES,id)||!Number.isInteger(surah)||surah<1||surah>114||!Number.isInteger(ayah)||ayah<1||ayah>counts[surah-1])throw Error('Invalid recitation source');const number=counts.slice(0,surah-1).reduce((a,n)=>a+n,0)+ayah;return 'https://cdn.islamic.network/quran/audio/64/'+RECITATION_SOURCES[id]+'/'+number+'.mp3';}

// Read MPEG Layer III frame headers, not extension or declared Content-Type.
// Duration is the sum of actual frames; reject VBR/non-64kbps files.
export function inspectMp3(bytes){const b=Buffer.from(bytes);let at=0,totalMs=0,frames=0,audioBytes=0;
 if(b.subarray(0,3).toString()==='ID3'){if(b.length<10)throw Error('Truncated ID3');const n=[b[6],b[7],b[8],b[9]].reduce((a,n)=>a*128+(n&127),0);at=10+n+((b[5]&16)?10:0);}
 let junk=0;
 while(at+4<=b.length){const h=b.readUInt32BE(at);if((h>>>21)!==2047){if(!frames&&junk++<4096){at++;continue;}break;}const version=(h>>>19)&3,layer=(h>>>17)&3,index=(h>>>12)&15,sampleIndex=(h>>>10)&3,padding=(h>>>9)&1;
  if(version===1||layer!==1||sampleIndex===3||index===0||index===15)throw Error('Invalid MP3 frame');
  const rates=version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  if(rates[index]!==64)throw Error('Expected 64kbps MP3');const sample=[44100,48000,32000][sampleIndex]/(version===3?1:version===2?2:4),length=Math.floor((version===3?144000:72000)*64/sample)+padding;
  if(at+length>b.length)throw Error('Truncated MP3 frame');totalMs+=(version===3?1152:576)*1000/sample;frames++;audioBytes+=length;at+=length;
 }
 if(frames<3||totalMs<=0||audioBytes<Math.max(1,b.length-at+audioBytes)*.8)throw Error('Invalid MP3 audio');return {durationMs:Math.round(totalMs),bitrateKbps:64,frames};}

async function fetchAudio(url,fetcher){let last;for(let attempt=0;attempt<3;attempt++){try{const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Audio upstream status '+response.status);const declared=Number(response.headers.get('content-length'));if(declared>10*1024*1024)throw Error('Audio file exceeds limit');let size=0;const parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>10*1024*1024)throw Error('Audio file exceeds limit');parts.push(Buffer.from(chunk));}return Buffer.concat(parts);}catch(e){last=e;if(attempt<2)await new Promise(r=>setTimeout(r,300*2**attempt));}}throw last;}
export class RecitationInstaller{
 constructor(root,{fetcher=fetch,validate=m=>m}={}){this.root=resolve(root);this.fetcher=fetcher;this.validate=validate;}
 install(id,surah){recitationSourceUrl(id,surah,1);const key=this.root+':'+id+':'+surah;if(jobs.has(key))return jobs.get(key);if(waiting.length>=8)throw Error('Audio preparation queue is busy; retry shortly');const job=schedule(()=>this.build(id,surah)).finally(()=>jobs.delete(key));jobs.set(key,job);return job;}
 async build(id,surah){const source=RECITATION_SOURCES[id],tracks=Array(counts[surah-1]);let next=0,total=0,failed=false;const assets=resolve(this.root,'assets');await mkdir(assets,{recursive:true});await mkdir(resolve(this.root,id),{recursive:true});
  await Promise.allSettled(Array.from({length:4},async()=>{while(!failed){const i=next++;if(i>=tracks.length)return;try{const data=await fetchAudio(recitationSourceUrl(id,surah,i+1),this.fetcher);total+=data.length;if(total>120*1024*1024)throw Error('Audio chapter exceeds limit');const info=inspectMp3(data),sha256=createHash('sha256').update(data).digest('hex'),file=sha256+'.mp3',temp=resolve(assets,sha256+'.'+randomUUID()+'.tmp');try{await writeFile(temp,data);await link(temp,resolve(assets,file)).catch(e=>{if(e.code!=='EEXIST')throw e;});}finally{await unlink(temp).catch(()=>{});}tracks[i]={ayah:i+1,file,sha256,bytes:data.length,durationMs:info.durationMs};}catch(e){failed=e;throw e;}}}));
  if(failed)throw failed;
  const rights={redistributionApproved:true,license:'Al Quran Cloud section IV — free non-commercial redistribution at published bitrate; reciter copyright retained',source:'https://alquran.cloud/terms-and-conditions',reviewedBy:'Project source review 2026-10-23',termsUpdated:'2026-06-14',sourceEdition:source,attribution:'Recitation: '+id+'; supplied by Al Quran Cloud / Islamic Network. Copyright remains with the reciter or estate.'};
  const revision=createHash('sha256').update(JSON.stringify({id,surah,tracks,rights})).digest('hex'),manifest=this.validate({reciter:id,surah,revision,bitrateKbps:64,rights,tracks}),target=resolve(this.root,id,surah+'.json'),temp=target+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(manifest));await rename(temp,target);}finally{await unlink(temp).catch(()=>{});}return manifest;
 }
}
