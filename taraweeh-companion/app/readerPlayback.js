// One real media element is the clock for separate ayahs and timed surah files.
export const PLAYBACK_RATES=Object.freeze([1,1.25,1.5,2]);
export const normalizePlaybackRate=value=>PLAYBACK_RATES.includes(Number(value))?Number(value):1;
export class ReaderPlayback{
 constructor({audio,onChange=()=>{},resolveTrack=async t=>t.url,prepareTrack=async()=>{},playbackRate=1}={}){
  this.audio=audio||new Audio();this.onChange=onChange;this.resolveTrack=resolveTrack;this.prepareTrack=prepareTrack;this.state='idle';this.manifest=null;this.index=0;this.epoch=0;this.listeners=[];this.objectUrl=null;this.assetKey=null;this.pendingSeek=null;
  this.playbackRate=normalizePlaybackRate(playbackRate);this.audio.defaultPlaybackRate=this.playbackRate;this.audio.playbackRate=this.playbackRate;this.audio.preservesPitch=true;
  for(const name of ['loadedmetadata','playing','waiting','pause','timeupdate','durationchange','seeked','error','ended']){const fn=()=>this.event(name);this.audio.addEventListener(name,fn);this.listeners.push([name,fn]);}
 }
 snapshot(){
  const t=this.manifest?.tracks[this.index],segmented=Number.isFinite(t?.startMs)&&Number.isFinite(t?.endMs);
  const durationMs=segmented?t.endMs-t.startMs:this.pendingSeek!==null&&t?.durationMs?t.durationMs:Number.isFinite(this.audio.duration)?this.audio.duration*1000:t?.durationMs||0;
  const position=this.pendingSeek!==null?this.pendingSeek:(this.audio.currentTime||0)*1000;
  return {state:this.state,reciter:this.manifest?.reciter,surah:this.manifest?.surah,ayah:t?.ayah,ayahEnd:t?.ayahEnd,ayahLabel:t?.ayahLabel,playbackRate:this.playbackRate,playbackMode:this.manifest?.playbackMode||'ayah',riwaya:this.manifest?.riwaya||'hafs',syncAvailable:this.manifest?.syncAvailable!==false,positionMs:Math.min(durationMs,Math.max(0,position-(segmented?t.startMs:0))),durationMs,error:this.error||''};
 }
 emit(){this.onChange(this.snapshot());}
 async load(manifest,{ayah=1}={}){this.pause();this.manifest=manifest;this.index=Math.max(0,manifest.tracks.findIndex(t=>t.ayah===ayah||(Number.isInteger(t.ayahEnd)&&t.ayah<=ayah&&ayah<=t.ayahEnd)));return this.select(this.index);}
 async select(index,{autoplay=false,positionMs=0}={}){
  if(!this.manifest?.tracks[index])return;
  const epoch=++this.epoch;this.state='loading';this.audio.pause();this.index=index;this.error='';this.pendingSeek=null;this.emit();
  try{
   const track=this.manifest.tracks[index],key=this.manifest.revision+':'+track.url;
   const duration=Number.isFinite(track.endMs)?track.endMs-track.startMs:track.durationMs||0;
   const target=(track.startMs||0)+Math.max(0,Math.min(duration,Number(positionMs)||0));
   if(key!==this.assetKey||this.audio.error||this.audio.readyState===0){
    const url=await this.resolveTrack(track);if(epoch!==this.epoch){if(String(url).startsWith('blob:'))URL.revokeObjectURL(url);return;}
    if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.objectUrl=String(url).startsWith('blob:')?url:null;this.assetKey=key;
    this.pendingSeek=target;this.audio.src=url;this.audio.load();
   }else this.audio.currentTime=target/1000;
   this.audio.defaultPlaybackRate=this.playbackRate;this.audio.playbackRate=this.playbackRate;
   // A new recording is not ready until its reading has reached the display.
   // A superseded display request must never resume the previous recording.
   await this.prepareTrack(this.snapshot());if(epoch!==this.epoch)return;
   this.state='ready';this.emit();if(autoplay&&this.cancelledAutoplayEpoch!==epoch)await this.play();
  }catch(e){if(epoch===this.epoch){this.state='error';this.error=e.name||'load_failed';this.emit();}}
 }
 async play(){if(!this.manifest||this.state==='loading'||this.state==='error')return;try{await this.audio.play();}catch(e){this.state='paused';this.error=e.name||'play_failed';this.emit();}}
 pause({cancelPending=false}={}){if(cancelPending){++this.epoch;this.pendingSeek=null;}this.cancelledAutoplayEpoch=this.epoch;this.audio.pause();if(this.manifest){this.state='paused';this.emit();}}
 setPlaybackRate(value){this.playbackRate=normalizePlaybackRate(value);this.audio.defaultPlaybackRate=this.playbackRate;this.audio.playbackRate=this.playbackRate;if(this.manifest)this.emit();return this.playbackRate;}
 seek(ms){const t=this.manifest?.tracks[this.index];this.pendingSeek=null;this.audio.currentTime=((t?.startMs||0)+Math.max(0,Math.min(this.snapshot().durationMs,Number(ms)||0)))/1000;this.emit();}
 step(direction,{autoplay=this.state==='playing'}={}){if(!this.manifest)return;return this.select(Math.max(0,Math.min(this.manifest.tracks.length-1,this.index+Math.sign(direction))),{autoplay});}
 async event(name){
  if(!this.manifest)return;
  if(name==='loadedmetadata'&&this.pendingSeek!==null){const target=this.pendingSeek;this.pendingSeek=null;this.audio.currentTime=target/1000;}
  if(name==='ended'){if(this.index<this.manifest.tracks.length-1)return this.select(this.index+1,{autoplay:true});this.state='ended';}
  else if(name==='playing'){this.state='playing';this.error='';}
  else if(name==='waiting'&&this.state!=='loading')this.state='buffering';
  else if(name==='pause'&&this.state!=='loading'&&this.state!=='ended')this.state='paused';
  else if(name==='error'){this.state='error';this.error='media_'+(this.audio.error?.code||'unknown');}
  if(['timeupdate','seeked','playing'].includes(name)&&this.state==='playing'&&this.pendingSeek===null){
   let track=this.manifest.tracks[this.index];
   // Shared cue ranges advance without interrupting or reloading the source.
   while(Number.isFinite(track.endMs)&&this.audio.currentTime*1000>=track.endMs){
    if(this.index===this.manifest.tracks.length-1){this.state='ended';this.audio.pause();break;}
    const next=this.manifest.tracks[this.index+1];
    if(next.url!==track.url)return this.select(this.index+1,{autoplay:true});
    this.index++;track=next;if(this.audio.currentTime*1000<track.startMs)this.audio.currentTime=track.startMs/1000;
   }
  }
  this.emit();
 }
 dispose(){++this.epoch;this.audio.pause();for(const[n,f]of this.listeners)this.audio.removeEventListener(n,f);if(this.objectUrl)URL.revokeObjectURL(this.objectUrl);this.audio.removeAttribute('src');this.audio.load();this.manifest=null;this.assetKey=null;}
}
