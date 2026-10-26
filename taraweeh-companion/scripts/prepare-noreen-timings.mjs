// Import pinned, published timings only after verifying the actual recording.
// This is a maintainer tool, never an app-side third-party download.
import {readFileSync,writeFileSync,mkdirSync,existsSync,createWriteStream,createReadStream,renameSync,unlinkSync,statSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectMp3File,mp3QuranSourceUrl} from '../backend/mp3QuranRecitations.js';
const root=fileURLToPath(new URL('../language-evidence/noreen/',import.meta.url));
const repository=JSON.parse(readFileSync(root+'hf-revision.json')),revision=repository.sha;
const counts=JSON.parse(readFileSync(new URL('../backend/data/quran-json/quran_en.json',import.meta.url))).map(c=>c.verses.length);
mkdirSync(root+'recordings',{recursive:true});
const prior=existsSync(root+'recording-audit.json')?JSON.parse(readFileSync(root+'recording-audit.json')):null;
const chapters=prior?.revision===revision?prior.chapters:[],failures=[];
const queue=Array.from({length:114},(_,i)=>i+1).filter(s=>!chapters.some(c=>c.surah===s));
async function download(url,path){if(existsSync(path))return;let last;for(let attempt=0;attempt<3;attempt++)try{const res=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!res.ok)throw Error('HTTP '+res.status);await pipeline(Readable.fromWeb(res.body),createWriteStream(path+'.tmp'));const expected=Number(res.headers.get('content-length'));if(expected&&statSync(path+'.tmp').size!==expected)throw Error('Truncated download');renameSync(path+'.tmp',path);return;}catch(e){last=e;if(existsSync(path+'.tmp'))unlinkSync(path+'.tmp');}throw last;}
await Promise.all(Array.from({length:3},async()=>{while(queue.length){const surah=queue.shift(),s=String(surah).padStart(3,'0');try{
 // The pinned repository's first 30 files have moved to Full Surah; the
 // remaining audio is still in its legacy chapter directory (identical PB).
 const pairPath='Noreen Muhammad Siddiq (Murattal)/'+(surah<=30?'Full Surah/':'')+s+'/'+s+'.opus';
 const pair='https://huggingface.co/datasets/zaibihassan/Quranic-Recitation-Data/resolve/'+revision+'/'+pairPath.split('/').map(encodeURIComponent).join('/');
 const mp3=root+'recordings/'+s+'.mp3',expectedDuration=JSON.parse(readFileSync(root+'timings/'+s+'.json')).metadata.duration_ms;
 if(existsSync(mp3)){try{if(Math.abs((await inspectMp3File(mp3)).durationMs-expectedDuration)>150)unlinkSync(mp3);}catch{unlinkSync(mp3);}}
 await Promise.all([download(pair,root+'recordings/'+s+'.opus'),download(mp3QuranSourceUrl('noreen-muhammad-siddiq',surah),root+'recordings/'+s+'.mp3')]);
 const checked=spawnSync('C:/Users/W4R-PC/AppData/Local/Programs/Python/Python312/python.exe',[fileURLToPath(new URL('./verify-noreen-waveforms.py',import.meta.url)),root,s],{encoding:'utf8'});
 if(checked.status!==0)throw Error(checked.stdout+checked.stderr);
 const waveform=JSON.parse(checked.stdout),path=root+'recordings/'+s+'.mp3',audio=await inspectMp3File(path),data=JSON.parse(readFileSync(root+'timings/'+s+'.json'));
 if(Math.abs(audio.durationMs-data.metadata.duration_ms)>150)throw Error('Recording duration differs');
 if(data.verses.length!==counts[surah-1])throw Error('Incomplete reference verse coverage');
 const hash=createHash('sha256');for await(const c of createReadStream(path))hash.update(c);
 // Keep the original pauses. A boundary occurs at the next verse's first
 // aligned word, rather than seeking over its preceding silence.
 const starts=data.verses.map(v=>Math.min(...v.words.map(w=>w.startTime)));
 const tracks=data.verses.map((v,i)=>({ayah:i+1,startMs:i===0?0:starts[i],endMs:i+1<starts.length?starts[i+1]:audio.durationMs}));
 if(tracks.some((t,i)=>vInvalid(data.verses[i],t,audio.durationMs)||i>0&&t.startMs!==tracks[i-1].endMs))throw Error('Invalid timestamps');
 chapters.push({surah,sha256:hash.digest('hex'),durationMs:audio.durationMs,tracks,waveform});
 console.log(s+' verified ('+queue.length+' remaining)');
 }catch(error){failures.push({surah,error:error.message});console.error(s+' FAILED '+error.message);}
 writeFileSync(root+'recording-audit.json',JSON.stringify({revision,chapters:chapters.sort((a,b)=>a.surah-b.surah),failures},null,2));
}}));
function vInvalid(v,t,duration){return !v.words.length||t.endMs<=t.startMs||v.words.some((w,i)=>!Number.isInteger(w.startTime)||!Number.isInteger(w.endTime)||w.endTime<=w.startTime||w.endTime>duration||(i>0&&w.startTime<v.words[i-1].endTime));}
if(failures.length||chapters.length!==114){console.error('No production timing bundle published: verification incomplete.');process.exit(1);}
const source={url:'https://huggingface.co/datasets/zaibihassan/Quranic-Recitation-Data',revision,license:'Apache-2.0',recordingSource:'https://www.mp3quran.net/eng/nourin_siddig',method:'Published asr_v15.0 word timestamps; exact MP3 performance verified at three positions per surah; no time scaling'};
const target=new URL('../backend/data/noreen-timings.json',import.meta.url);
writeFileSync(target,JSON.stringify({version:1,source,chapters:chapters.map(({waveform,...c})=>c)}));
console.log('Published '+fileURLToPath(target));
