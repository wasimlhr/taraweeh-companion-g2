import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root=new URL('../language-evidence/railway-full-report-2026-10-26/',import.meta.url);
const read=file=>JSON.parse(readFileSync(new URL(file,root),'utf8').replace(/^\uFEFF/,''));
const meta=read('collection.json'),parts=read('split-collection.json'),since=Date.parse(meta.since);
const parse=file=>readFileSync(new URL(file,root),'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
const date=t=>new Date(t).toLocaleDateString('en-CA',{timeZone:'America/Los_Angeles'});
const local=t=>new Date(t).toLocaleString('sv-SE',{timeZone:'America/Los_Angeles'});
const inc=(o,key,n=1)=>{key=String(key==null||key===''?'unknown':key);o[key]=(o[key]||0)+n;};
const sum=(rows,key)=>rows.reduce((n,s)=>n+(Number(s[key])||0),0);
const summaries=[],sessions=[],clients=new Map(),http=[],allRows=[];
const seenRuns=new Set();
for(const service of meta.services){
 const jobs=meta.results.filter(j=>j.key===service.key&&j.kind==='runtime'&&j.ok).flatMap(j=>j.lines>=5000?parts.filter(p=>p.deployment===j.deployment):[j]);
 const rows=jobs.flatMap(j=>parse(j.file).map(r=>({...r,service:service.key,deployment:j.deployment}))).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
 const seen=new Set(),unique=rows.filter(r=>{const k=r.timestamp+':'+r.message;if(seen.has(k))return false;seen.add(k);return true;});allRows.push(...unique);
 const init=[],runRows=[];let live=null,latest=null;
 for(let i=0;i<unique.length;i++){
  const row=unique[i],m=String(row.message||'');
  const count=m.match(/\[WS\] Client (?:connected|disconnected).*\((\d+) live\)/);if(count)live=Number(count[1]);
  const match=m.match(/\[Init\] preferredSurah=(\d+) pipeline=(\w+) sid=([^ ]+)/);
  if(match){
  const blockRows=[];for(let at=i+1;at<Math.min(unique.length,i+60);at++){if(Date.parse(unique[at].timestamp)-Date.parse(row.timestamp)>=2000||/\[Init\] preferredSurah=/.test(unique[at].message||''))break;blockRows.push(unique[at]);}
  const block=blockRows.map(r=>r.message||'').join('\n');
   const engine=block.match(/engine provider=(\w+) model=([^\n]+)/),missing=block.match(/No (\w+) key/),setting=block.match(/Creating pipeline \w+ translationLang=([^ ]+) audioSource=([^\n]+)/),mode=block.match(/\[Init\] Pace: .*mode: (\w+)/);
   latest={service:service.key,sid:match[3],at:Date.parse(row.timestamp),timePDT:local(row.timestamp),preferredSurah:Number(match[1]),pipeline:match[2],provider:engine?.[1]||missing?.[1]||'unknown',model:engine?.[2]?.trim()||'unknown',keyMode:missing?'missing':block.includes('SHARED engine')?'shared':block.includes('BYOK engine')?'byok':'unknown',language:setting?.[1]||'unknown',microphone:setting?.[2]?.trim()||'unknown',mode:mode?.[1]==='listen'?'translate':mode?.[1]||'unknown',liveAtInit:live};
   init.push(latest);
   if(latest.sid!=='(none)'){let c=clients.get(latest.sid);if(!c){c={sid:latest.sid,inits:[],sessions:[]};clients.set(c.sid,c);}c.inits.push(latest);}
  }
  if(m.startsWith('[UsageSession] ')){try{runRows.push({run:JSON.parse(m.slice('[UsageSession] '.length)),row});}catch{}}
 }
 const persisted=service.key==='primary'?read('primary-analytics.json').history?.sessions||[]:[];
 const combine=new Map(runRows.map(x=>[x.run.id,{...x.run,service:service.key,fromLog:true,logTimestamp:x.row.timestamp}]));
 for(const run of persisted){const old=combine.get(run.id);combine.set(run.id,{...old,...run,service:service.key,fromVolume:true});}
 for(const run of combine.values()){
  if(run.startedAt<since)continue;
  const origin=init.filter(x=>x.at<=run.startedAt).at(-1);
  // The UUID in a journal row identifies a run, not an installation. Link only
  // when the log records one live socket throughout the start boundary.
  const boundary=unique.filter(x=>Date.parse(x.timestamp)>=origin?.at&&Date.parse(x.timestamp)<=run.startedAt);
  const crossedOverlap=boundary.some(x=>/\[WS\] Client.*\(([2-9]|\d{2,}) live\)/.test(x.message||''));
  const disconnected=boundary.some(x=>/\[WS\] Client disconnected.*\(0 live\)/.test(x.message||''));
  run.sid=origin?.liveAtInit===1&&!crossedOverlap&&!disconnected&&origin.sid!=='(none)'?origin.sid:null;
  run.timePDT=local(run.startedAt);run.dayPDT=date(run.startedAt);
  if(!seenRuns.has(service.key+':'+run.id)){sessions.push(run);seenRuns.add(service.key+':'+run.id);if(run.sid)clients.get(run.sid)?.sessions.push(run);}
 }
 const sr=sessions.filter(s=>s.service===service.key),asr=unique.filter(r=>/^\[(?:Groq|OpenAI):/.test(r.message||'')),latencies=asr.map(r=>Number(r.message.match(/\] (\d+)ms/)?.[1])).filter(Number.isFinite).sort((a,b)=>a-b);
 const httpJobs=existsSync(new URL('http-collection.json',root))?read('http-collection.json').filter(j=>j.key===service.key&&j.ok):meta.results.filter(j=>j.key===service.key&&j.kind==='http'&&j.ok);
 const seenHttp=new Set(),httpRows=httpJobs.flatMap(j=>parse(j.file)).filter(r=>{const key=r.requestId||r.timestamp+':'+r.path;if(seenHttp.has(key))return false;seenHttp.add(key);return true;});http.push(...httpRows.map(r=>({...r,service:service.key})));
 const b={...service,logLines:unique.length,firstLog:unique[0]?.timestamp,lastLog:unique.at(-1)?.timestamp,connections:unique.filter(r=>/\[WS\] Client connected/.test(r.message||'')).length,starts:unique.filter(r=>/\[WS\] msg type=start$/.test(r.message||'')).length,inits:init.length,clientIds:new Set(init.map(x=>x.sid).filter(x=>x!=='(none)')).size,peakLoggedConnections:Math.max(0,...unique.flatMap(r=>{const m=r.message?.match(/\((\d+) live\)/);return m?[Number(m[1])]:[];})),sessions:sr.length,durationMs:sum(sr,'durationMs'),transcripts:sum(sr,'transcripts'),empty:sum(sr,'emptyTranscripts'),matches:sum(sr,'matches'),errors:sum(sr,'errors'),manual:sum(sr,'manualCorrections'),withMatches:sr.filter(s=>s.matches>0).length,withTranscriptsNoMatches:sr.filter(s=>s.transcripts>0&&!s.matches).length,atLeast10s:sr.filter(s=>s.durationMs>=10000).length,asrResponses:asr.length,music:asr.filter(r=>/موسيقى/.test(r.message)).length,subscribe:asr.filter(r=>/اشترك/.test(r.message)).length,normalizations:unique.filter(r=>/Audio normalize:/.test(r.message||'')).length,quietBoosts:unique.filter(r=>/quiet boost:/.test(r.message||'')).length,provider429Lines:unique.filter(r=>/HTTP 429/.test(r.message||'')).length,missingKeyInits:init.filter(i=>i.keyMode==='missing').length,latencyMs:{min:latencies[0],median:latencies[Math.floor(latencies.length/2)],p95:latencies[Math.min(latencies.length-1,Math.floor(latencies.length*.95))],max:latencies.at(-1)},modes:{},languages:{},microphones:{},versions:{},engines:{},days:{},http:{rows:httpRows.length,status:{},paths:{}}};
 for(const s of sr){inc(b.modes,s.mode);inc(b.languages,s.language);inc(b.microphones,s.microphone);inc(b.versions,s.appVersion);inc(b.engines,s.provider+'/'+s.model);const d=b.days[s.dayPDT]||={sessions:0,transcripts:0,matches:0,errors:0,durationMs:0};for(const key of ['transcripts','matches','errors','durationMs'])d[key]+=s[key]||0;d.sessions++;}
 for(const r of httpRows){inc(b.http.status,r.httpStatus);inc(b.http.paths,r.path.split('?')[0]);}
 summaries.push(b);
}
const clientRows=[...clients.values()].map((c,index)=>({label:'Client '+String(index+1).padStart(2,'0'),sid:c.sid,firstPDT:c.inits[0]?.timePDT,lastPDT:c.inits.at(-1)?.timePDT,backends:[...new Set(c.inits.map(x=>x.service))],inits:c.inits.length,modes:[...new Set([...c.inits.map(x=>x.mode),...c.sessions.map(x=>x.mode)])],microphones:[...new Set(c.inits.map(x=>x.microphone))],languages:[...new Set([...c.inits.map(x=>x.language),...c.sessions.map(x=>x.language)])],providers:[...new Set(c.inits.map(x=>x.provider))],keyModes:[...new Set(c.inits.map(x=>x.keyMode))],preferredSurahs:[...new Set(c.inits.map(x=>x.preferredSurah).filter(Boolean))],attributedSessions:c.sessions.length,transcripts:sum(c.sessions,'transcripts'),matches:sum(c.sessions,'matches'),errors:sum(c.sessions,'errors'),durationMs:sum(c.sessions,'durationMs')}));
const totals={sessions:sessions.length,clientIds:clientRows.length,attributedSessions:sessions.filter(s=>s.sid).length,durationMs:sum(sessions,'durationMs'),transcripts:sum(sessions,'transcripts'),emptyTranscripts:sum(sessions,'emptyTranscripts'),matches:sum(sessions,'matches'),errors:sum(sessions,'errors')};
const result={windowStart:meta.since,collectedAt:meta.collectedAt,totals,services:summaries,clients:clientRows,sessions:sessions.sort((a,b)=>a.startedAt-b.startedAt),coverage:{sets:meta.results.length,failures:meta.results.filter(r=>!r.ok),splitSets:parts.length},httpRequests:http.length};
writeFileSync(new URL('analysis.json',root),JSON.stringify(result,null,2));
function csv(file,rows,fields){const quote=x=>'"'+String(Array.isArray(x)?x.join('; '):x??'').replace(/"/g,'""')+'"';writeFileSync(new URL(file,root),fields.map(quote).join(',')+'\n'+rows.map(r=>fields.map(k=>quote(r[k])).join(',')).join('\n'));}
csv('sessions.csv',result.sessions,['service','id','sid','timePDT','mode','microphone','language','provider','model','appVersion','durationMs','transcripts','emptyTranscripts','matches','errors','manualCorrections','verses','endReason']);
csv('clients.csv',clientRows,Object.keys(clientRows[0]||{}));
csv('http-requests.csv',http.map(r=>({service:r.service,timePDT:local(r.timestamp),method:r.method,path:r.path.split('?')[0],status:r.httpStatus,durationMs:r.totalDuration,userAgent:r.clientUa})),['service','timePDT','method','path','status','durationMs','userAgent']);
console.log(JSON.stringify({totals,services:summaries,clients:clientRows},null,2));
