import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const run=promisify(execFile),cli='C:/Users/W4R-PC/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe';
const out=new URL('../language-evidence/railway-full-report-2026-10-26/',import.meta.url);mkdirSync(new URL('logs/',out),{recursive:true});
const services=[
 {key:'primary',project:'2efeb234-d454-4876-8226-847a354b8f25',service:'5f5137e4-56db-4f58-bc60-9a4806a2186d',domain:'taraweeh.up.railway.app'},
 {key:'observant-g2',project:'2efeb234-d454-4876-8226-847a354b8f25',service:'9f89f269-f053-466a-94db-11e5e0cd37e5',domain:'taraweeh-companion-g2-production.up.railway.app'},
 {key:'legacy-150e',project:'b19fffb8-bb27-4157-a447-4f907b5e5275',service:'bf58357b-a605-43e9-9975-eab30a527708',domain:'taraweeh-companion-g2-production-150e.up.railway.app'}
];
const read=file=>JSON.parse(readFileSync(new URL(file,out),'utf8').replace(/^\uFEFF/,''));
const since='2026-10-19T07:00:00Z',jobs=[];
for(const service of services){
 const deployments=read(service.key+'-deployments.json');
 const selected=[...deployments.filter(d=>d.createdAt>=since)];const preceding=deployments.find(d=>d.createdAt<since);if(preceding)selected.push(preceding);
 for(const d of selected)jobs.push({...service,kind:'runtime',deployment:d.id,createdAt:d.createdAt,status:d.status});
 jobs.push({...service,kind:'http'});
}
let cursor=0;const results=[];
await Promise.all(Array.from({length:4},async()=>{
 while(cursor<jobs.length){const job=jobs[cursor++],file='logs/'+job.key+'-'+(job.deployment||'http')+'.jsonl';
  const args=['logs',...(job.deployment?[job.deployment]:[]),'-p',job.project,'-s',job.service,'-e','production','--since',since,'--lines',job.kind==='http'?'500':'5000','--json',...(job.kind==='http'?['--http']:[])];
  try{const {stdout,stderr}=await run(cli,args,{maxBuffer:48*1024*1024,timeout:60000,windowsHide:true});writeFileSync(new URL(file,out),stdout);const lines=stdout.trim().split(/\r?\n/).filter(Boolean).length;results.push({...job,file,lines,ok:true,warning:stderr.trim()});}
  catch(error){results.push({...job,file,ok:false,error:String(error.stderr||error.message).slice(0,500)});}
  writeFileSync(new URL('collection.json',out),JSON.stringify({since,collectedAt:new Date().toISOString(),services,jobs:jobs.length,results},null,2));
  if(results.length%10===0)console.log('Collected '+results.length+'/'+jobs.length+' log sets');
 }
}));
console.log(JSON.stringify({sets:results.length,failures:results.filter(r=>!r.ok).map(r=>({service:r.key,kind:r.kind,error:r.error})),capped:results.filter(r=>r.lines>=(r.kind==='http'?500:5000)).map(r=>({service:r.key,kind:r.kind,deployment:r.deployment})),nonempty:results.filter(r=>r.lines>0).length}));
