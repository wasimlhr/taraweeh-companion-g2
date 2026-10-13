import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

// Bounded persistent session summaries. No PCM, transcripts, keys, IPs or user IDs.
export class UsageJournal {
  constructor({path,now=Date.now,maxSessions=500}={}) {
    this.path=path;this.now=now;this.maxSessions=maxSessions;this.sessions=[];this.active=new Map();this.lastError='';
    if(path) try {
      this.sessions=JSON.parse(readFileSync(path,'utf8')).sessions.slice(-maxSessions);
      for(const run of this.sessions)if(run.endedAt==null){run.endedAt=run.startedAt+run.durationMs;run.endReason='server_restart';}
    } catch {}
  }
  begin(meta={}) {
    const run={id:randomUUID(),startedAt:this.now(),endedAt:null,durationMs:0,
      provider:['groq','openai','deepgram','elevenlabs'].includes(meta.provider)?meta.provider:'unknown',
      model:/^(whisper-large-v3(-turbo)?|gpt-4o(-mini)?-transcribe|whisper-1|nova-3)$/.test(meta.model||'')?meta.model:'',
      microphone:['g2','simulator','browser'].includes(meta.audioSource)?meta.audioSource:'unknown',mode:meta.practiceMode?'practice':meta.taraweehMode?'taraweeh':'translate',
      language:/^[a-z]{2,3}$/.test(meta.lang||'')?meta.lang:'en',appVersion:/^v?\d+\.\d+\.\d+$/.test(meta.appVersion||'')?meta.appVersion:'',
      transcripts:0,emptyTranscripts:0,providerLatencyMs:0,errors:0,errorKinds:{},
      matches:0,verses:[],manualCorrections:0,audioSamples:0,voiceSamples:0,settingsChanges:[],
      unmatchedChecks:0,pendingJumps:0,confirmedJumps:0};
    this.sessions.push(run);this.active.set(run.id,run);
    while(this.sessions.length>this.maxSessions){const removable=this.sessions.findIndex(s=>!this.active.has(s.id));if(removable<0)break;this.sessions.splice(removable,1);}
    this.flush();return run.id;
  }
  event(id,event={}) {
    const run=this.active.get(id);if(!run)return;
    if(event.type==='asr') {run.transcripts++;if(!String(event.text||'').trim())run.emptyTranscripts++;run.providerLatencyMs+=Math.max(0,Number(event.latencyMs)||0);}
    if(event.type==='audio'){run.audioSamples++;if(event.voice)run.voiceSamples++;}
    if(event.type==='error') {run.errors++;const kind=String(event.status||event.where||'pipeline').slice(0,40);run.errorKinds[kind]=(run.errorKinds[kind]||0)+1;}
    if(event.type==='note') {
      if(event.what==='match-miss')run.unmatchedChecks++;
      if(event.what==='jump-pending')run.pendingJumps++;
      if(event.what==='jump-confirmed')run.confirmedJumps++;
    }
  }
  match(id,state) {
    const run=this.active.get(id);if(!run||state.mode!=='LOCKED'||state.isCandidate||state.userSearching)return;
    const key=Number(state.surah)+':'+Number(state.ayah);if(!/^\d+:\d+$/.test(key))return;
    if(run.verses.at(-1)!==key){run.matches++;run.verses.push(key);if(run.verses.length>300)run.verses.shift();}
  }
  manual(id){const run=this.active.get(id);if(run)run.manualCorrections++;}
  settings(id,{mode,microphone,pace}={}) {
    const run=this.active.get(id);if(!run)return;
    const change={atMs:this.now()-run.startedAt};
    if(['translate','practice','taraweeh'].includes(mode))change.mode=run.mode=mode;
    if(['g2','simulator','browser'].includes(microphone))change.microphone=run.microphone=microphone;
    if(['follow','fast','slow'].includes(pace))change.pace=pace;
    run.settingsChanges.push(change);if(run.settingsChanges.length>80)run.settingsChanges.shift();
  }
  end(id,reason='stop') {const run=this.active.get(id);if(!run)return;
    run.endedAt=this.now();run.durationMs=run.endedAt-run.startedAt;run.endReason=reason;
    this.active.delete(id);this.flush();console.log('[UsageSession] '+JSON.stringify(run));return run;
  }
  flush() {
    for(const run of this.active.values())run.durationMs=this.now()-run.startedAt;
    if(!this.path)return;
    try {mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify({v:1,sessions:this.sessions}));renameSync(this.path+'.tmp',this.path);this.lastError='';}
    catch(e){this.lastError=e.code||'write_failed';console.error('[Usage] persistence failed:',this.lastError);}
  }
  snapshot(){return {persistent:!!this.path,storageError:this.lastError,retentionSessions:this.maxSessions,
    sessions:this.sessions.slice().reverse(),totals:this.sessions.reduce((a,s)=>{
      a.sessions++;a.durationMs+=s.durationMs;a.transcripts+=s.transcripts;a.emptyTranscripts+=s.emptyTranscripts;
      a.matches+=s.matches;a.errors+=s.errors;return a;
    },{sessions:0,durationMs:0,transcripts:0,emptyTranscripts:0,matches:0,errors:0})};}
}
