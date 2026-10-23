import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {RecitationInstaller} from './recitationInstaller.js';

export const RECITERS=Object.freeze([
 {id:'alafasy',name:'Mishary Rashid Alafasy'},
 {id:'husary',name:'Mahmoud Khalil Al-Husary'},
 {id:'abdul-basit-murattal',name:'Abdul Basit — Murattal'},
]);
const chapterCounts=JSON.parse(readFileSync(new URL('./data/quran-json/quran_en.json',import.meta.url),'utf8')).map(c=>c.verses.length);
export function within(root,file){const rel=relative(root,file);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
export function validateRecitationManifest(m){
 if(!RECITERS.some(r=>r.id===m?.reciter)||!Number.isInteger(m.surah)||m.surah<1||m.surah>114)throw Error('Invalid reciter/chapter');
 if(m.bitrateKbps!==64||! /^[a-f0-9]{64}$/.test(m.revision||''))throw Error('Invalid bitrate/revision');
 if(m.rights?.redistributionApproved!==true||!m.rights?.license||!m.rights?.source||!m.rights?.reviewedBy)throw Error('Redistribution rights must be documented');
 if(!Array.isArray(m.tracks)||m.tracks.length!==chapterCounts[m.surah-1])throw Error('Incomplete chapter');
 for(const [i,t]of m.tracks.entries())if(t.ayah!==i+1||! /^[a-f0-9]{64}\.mp3$/.test(t.file||'')||! /^[a-f0-9]{64}$/.test(t.sha256||'')||t.file!==t.sha256+'.mp3'||!Number.isSafeInteger(t.bytes)||t.bytes<=0||!Number.isFinite(t.durationMs)||t.durationMs<=0)throw Error('Invalid track');
 return m;
}
export class RecitationStore{
 constructor(root,{fetchEnabled=process.env.RECITATION_FETCH_ENABLED!=='false',fetcher}={}){this.root=resolve(root);this.indexAt=0;this.index=null;this.fetchEnabled=fetchEnabled;this.installer=new RecitationInstaller(this.root,{fetcher,validate:validateRecitationManifest});}
 async ensure(id,surah){if(!RECITERS.some(r=>r.id===id)||!Number.isInteger(surah)||surah<1||surah>114)return null;if(this.manifest(id,surah))return this.publicManifest(id,surah);if(!this.fetchEnabled)return null;await this.installer.install(id,surah);this.index=null;return this.publicManifest(id,surah);}
 refresh(){if(this.index&&Date.now()-this.indexAt<10000)return;const manifests=[],assets=new Map();for(const r of RECITERS)for(let s=1;s<=114;s++){const m=this.manifest(r.id,s);if(m){manifests.push(m);for(const t of m.tracks)assets.set(t.file,resolve(this.root,'assets',t.file));}}this.index={manifests,assets};this.indexAt=Date.now();}
 manifest(id,surah){
  if(!RECITERS.some(r=>r.id===id)||!Number.isInteger(surah)||surah<1||surah>114)return null;
  try{const m=validateRecitationManifest(JSON.parse(readFileSync(resolve(this.root,id,String(surah)+'.json'),'utf8')));if(m.reciter!==id||m.surah!==surah)return null;for(const t of m.tracks){const p=realpathSync(resolve(this.root,'assets',t.file));if(!within(realpathSync(this.root),p)||statSync(p).size!==t.bytes)return null;}return m;}catch{return null;}
 }
 publicManifest(id,surah){const m=this.manifest(id,surah);if(!m)return null;return {reciter:id,surah,revision:m.revision,bitrateKbps:64,license:m.rights.license,attribution:m.rights.attribution||'',tracks:m.tracks.map(({file,...t})=>({...t,url:'/audio/'+file}))};}
 catalog(){this.refresh();return {reciters:RECITERS.map(r=>{const chapters=this.index.manifests.filter(m=>m.reciter===r.id);return {...r,bitrateKbps:64,available:chapters.length>0,downloadable:this.fetchEnabled,availableSurahs:this.fetchEnabled?Array.from({length:114},(_,i)=>i+1):chapters.map(c=>c.surah),surahs:chapters.map(c=>c.surah),bytes:chapters.reduce((n,c)=>n+c.tracks.reduce((a,t)=>a+t.bytes,0),0)};})};}
 asset(file){if(! /^[a-f0-9]{64}\.mp3$/.test(file))return null;this.refresh();const path=this.index.assets.get(file);if(!path)return null;try{return within(realpathSync(this.root),realpathSync(path))?path:null;}catch{return null;}}
}
export function installRecitationRoutes(app,store){
 app.get('/api/recitations',(_req,res)=>res.set('Access-Control-Allow-Origin','*').json(store.catalog()));
 app.get('/api/recitations/:reciter/:surah',async(req,res)=>{res.set('Access-Control-Allow-Origin','*');try{const m=await store.ensure(req.params.reciter,Number(req.params.surah));return m?res.json(m):res.status(404).json({error:'This recitation has not been installed.'});}catch{res.set('Retry-After','10');return res.status(503).json({error:'Audio preparation could not finish. Please retry shortly.'});}});
 app.get('/audio/:file',(req,res)=>{res.set('Access-Control-Allow-Origin','*');const path=store.asset(req.params.file);if(!path)return res.status(404).end();res.set({'Content-Type':'audio/mpeg','Cache-Control':'public, max-age=31536000, immutable'});return res.sendFile(path);});
}
