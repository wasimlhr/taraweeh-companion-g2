// Local files only. Never downloads recordings or assumes redistribution rights.
import {readFileSync,mkdirSync,copyFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateRecitationManifest,within} from '../backend/recitations.js';
const [inputPath,outputPath]=process.argv.slice(2);
if(!inputPath||!outputPath)throw Error('Usage: node scripts/import-recitation-pack.mjs approved-pack.json /data/recitations');
const input=JSON.parse(readFileSync(inputPath,'utf8')),sourceRoot=realpathSync(dirname(resolve(inputPath))),destination=resolve(outputPath);
if(input.rights?.redistributionApproved!==true||!input.rights?.license||!input.rights?.source||!input.rights?.reviewedBy)throw Error('Document approved redistribution rights first');
const tracks=input.tracks.map(t=>{const file=realpathSync(resolve(sourceRoot,t.file));if(!within(sourceRoot,file))throw Error('Input file escapes pack directory');const data=readFileSync(file),sha256=createHash('sha256').update(data).digest('hex');const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,codec_type,bit_rate','-of','json',file],{encoding:'utf8'}));const stream=probe.streams?.find(s=>s.codec_type==='audio');if(stream?.codec_name!=='mp3'||Number(stream.bit_rate)!==64000)throw Error('Expected a 64-kbps MP3: '+t.file);const durationMs=Math.round(Number(probe.format?.duration)*1000);return {ayah:t.ayah,file:sha256+'.mp3',bytes:data.length,sha256,durationMs,sourceFile:file};});
const revision=createHash('sha256').update(JSON.stringify({reciter:input.reciter,surah:input.surah,rights:input.rights,tracks:tracks.map(({sourceFile,...t})=>t)})).digest('hex');
const manifest=validateRecitationManifest({reciter:input.reciter,surah:input.surah,bitrateKbps:64,revision,rights:input.rights,tracks:tracks.map(({sourceFile,...t})=>t)});
mkdirSync(resolve(destination,'assets'),{recursive:true});mkdirSync(resolve(destination,input.reciter),{recursive:true});
for(const t of tracks)copyFileSync(t.sourceFile,resolve(destination,'assets',t.file));
const target=resolve(destination,input.reciter,input.surah+'.json');writeFileSync(target+'.tmp',JSON.stringify(manifest,null,2));renameSync(target+'.tmp',target);
console.log(JSON.stringify({reciter:manifest.reciter,surah:manifest.surah,tracks:tracks.length,bytes:tracks.reduce((n,t)=>n+t.bytes,0),revision}));
