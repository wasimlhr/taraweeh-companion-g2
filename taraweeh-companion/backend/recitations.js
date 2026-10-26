import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {RecitationInstaller} from './recitationInstaller.js';
import {MP3QURAN_RECITERS,Mp3QuranInstaller} from './mp3QuranRecitations.js';
import {duriUnits} from './duriReading.js';

export const RECITERS=Object.freeze([
 {id:'alafasy',name:'Mishary Rashid Alafasy'},
 {id:'husary',name:'Mahmoud Khalil Al-Husary'},
 {id:'abdul-basit-murattal',name:'Abdul Basit — Murattal'},
 {id:'saad-al-ghamdi',name:'Saad Al-Ghamdi',riwaya:'hafs',playbackMode:'ayah'},
 {id:'noreen-muhammad-siddiq',name:'Noreen Muhammad Siddiq · Al-Duri',riwaya:'ad-duri',playbackMode:'ayah'},
]);
const chapterCounts=JSON.parse(readFileSync(new URL('./data/quran-json/quran_en.json',import.meta.url),'utf8')).map(c=>c.verses.length);
export function within(root,file){const rel=relative(root,file);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
export function validateRecitationManifest(m){
 if(!RECITERS.some(r=>r.id===m?.reciter)||!Number.isInteger(m.surah)||m.surah<1||m.surah>114)throw Error('Invalid reciter/chapter');
 const source=MP3QURAN_RECITERS[m.reciter];
 if((source?(!Number.isInteger(m.bitrateKbps)||m.bitrateKbps<8||m.bitrateKbps>320):m.bitrateKbps!==64)||! /^[a-f0-9]{64}$/.test(m.revision||''))throw Error('Invalid bitrate/revision');
 if(m.rights?.redistributionApproved!==true||!m.rights?.license||!m.rights?.source||!m.rights?.reviewedBy)throw Error('Redistribution rights must be documented');
 if(source&&(m.playbackMode!==source.playbackMode||m.riwaya!==source.riwaya||m.syncAvailable!==(source.playbackMode==='ayah')||!Number.isFinite(m.assetDurationMs)||m.assetDurationMs<=0))throw Error('Invalid recitation mode');
 const chapterOnly=source?.playbackMode==='surah';
 const units=source?.timingVersion?duriUnits(m.surah):null;
 if(units&&(m.timingVersion!==source.timingVersion||! /^[a-f0-9]{40}$/.test(m.timingRevision||'')))throw Error('Noreen needs verified automatic timings');
 if(!Array.isArray(m.tracks)||m.tracks.length!==(units?units.length:chapterOnly?1:chapterCounts[m.surah-1]))throw Error('Incomplete chapter');
 let previousEnd=0;
 for(const [i,t]of m.tracks.entries()){
  if(t.ayah!==(units?units[i].ayah:chapterOnly?null:i+1)||! /^[a-f0-9]{64}\.mp3$/.test(t.file||'')||! /^[a-f0-9]{64}$/.test(t.sha256||'')||t.file!==t.sha256+'.mp3'||!Number.isSafeInteger(t.bytes)||t.bytes<=0||!Number.isFinite(t.durationMs)||t.durationMs<=0)throw Error('Invalid track');
  if(units&&(t.ayahEnd!==units[i].ayahEnd||t.ayahLabel!==units[i].ayahLabel||t.startMs!==previousEnd))throw Error('Invalid Al-Duri verse mapping');
  if(source&&!chapterOnly){if(!Number.isInteger(t.startMs)||!Number.isInteger(t.endMs)||t.startMs<previousEnd||t.endMs<=t.startMs||t.endMs>m.assetDurationMs||t.durationMs!==t.endMs-t.startMs||t.file!==m.tracks[0].file||t.bytes!==m.tracks[0].bytes)throw Error('Invalid ayah cues');previousEnd=t.endMs;}
 }
 return m;
}
export class RecitationStore{
 constructor(root,{fetchEnabled=process.env.RECITATION_FETCH_ENABLED!=='false',fetcher,noreenTimings}={}){this.root=resolve(root);this.indexAt=0;this.index=null;this.fetchEnabled=fetchEnabled;this.installer=new RecitationInstaller(this.root,{fetcher,validate:validateRecitationManifest});this.mp3QuranInstaller=new Mp3QuranInstaller(this.root,{fetcher,validate:validateRecitationManifest,counts:chapterCounts,noreenTimings});}
 async ensure(id,surah){if(!RECITERS.some(r=>r.id===id)||!Number.isInteger(surah)||surah<1||surah>114)return null;if(this.manifest(id,surah))return this.publicManifest(id,surah);if(!this.fetchEnabled)return null;await (MP3QURAN_RECITERS[id]?this.mp3QuranInstaller:this.installer).install(id,surah);this.index=null;return this.publicManifest(id,surah);}
 refresh(){if(this.index&&Date.now()-this.indexAt<10000)return;const manifests=[],assets=new Map();for(const r of RECITERS)for(let s=1;s<=114;s++){const m=this.manifest(r.id,s);if(m){manifests.push(m);for(const t of m.tracks)assets.set(t.file,resolve(this.root,'assets',t.file));}}this.index={manifests,assets};this.indexAt=Date.now();}
 manifest(id,surah){
  if(!RECITERS.some(r=>r.id===id)||!Number.isInteger(surah)||surah<1||surah>114)return null;
  try{const m=validateRecitationManifest(JSON.parse(readFileSync(resolve(this.root,id,String(surah)+'.json'),'utf8')));if(m.reciter!==id||m.surah!==surah)return null;const sizes=new Map();for(const t of m.tracks){if(!sizes.has(t.file)){const p=realpathSync(resolve(this.root,'assets',t.file));if(!within(realpathSync(this.root),p))return null;sizes.set(t.file,statSync(p).size);}if(sizes.get(t.file)!==t.bytes)return null;}return m;}catch{return null;}
 }
 publicManifest(id,surah){const m=this.manifest(id,surah);if(!m)return null;return {reciter:id,reciterName:RECITERS.find(r=>r.id===id).name,surah,revision:m.revision,bitrateKbps:m.bitrateKbps,playbackMode:m.playbackMode||'ayah',riwaya:m.riwaya||'hafs',syncAvailable:m.syncAvailable!==false,...(m.timingVersion?{timingVersion:m.timingVersion}:{}),license:m.rights.license,attribution:m.rights.attribution||'',tracks:m.tracks.map(({file,...t})=>({...t,url:'/audio/'+file}))};}
 catalog(){this.refresh();return {reciters:RECITERS.map(r=>{const chapters=this.index.manifests.filter(m=>m.reciter===r.id);return {...r,bitrateKbps:MP3QURAN_RECITERS[r.id]?null:64,available:chapters.length>0,downloadable:this.fetchEnabled,availableSurahs:this.fetchEnabled?Array.from({length:114},(_,i)=>i+1):chapters.map(c=>c.surah),surahs:chapters.map(c=>c.surah),bytes:chapters.reduce((n,c)=>n+[...new Map(c.tracks.map(t=>[t.file,t.bytes])).values()].reduce((a,b)=>a+b,0),0)};})};}
 asset(file){if(! /^[a-f0-9]{64}\.mp3$/.test(file))return null;this.refresh();const path=this.index.assets.get(file);if(!path)return null;try{return within(realpathSync(this.root),realpathSync(path))?path:null;}catch{return null;}}
}
export function installRecitationRoutes(app,store){
 app.get('/api/recitations',(_req,res)=>res.set('Access-Control-Allow-Origin','*').json(store.catalog()));
 app.get('/api/recitations/:reciter/:surah',async(req,res)=>{res.set('Access-Control-Allow-Origin','*');try{const m=await store.ensure(req.params.reciter,Number(req.params.surah));return m?res.json(m):res.status(404).json({error:'This recitation has not been installed.'});}catch{res.set('Retry-After','10');return res.status(503).json({error:'Audio preparation could not finish. Please retry shortly.'});}});
 app.get('/audio/:file',(req,res)=>{res.set('Access-Control-Allow-Origin','*');const path=store.asset(req.params.file);if(!path)return res.status(404).end();res.set({'Content-Type':'audio/mpeg','Cache-Control':'public, max-age=31536000, immutable'});return res.sendFile(path);});
}
