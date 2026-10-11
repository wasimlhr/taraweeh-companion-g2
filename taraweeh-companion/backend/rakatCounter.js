/** Count confirmed Al-Fatihah openings; never infer prayer postures. */
export class RakatCounter {
  constructor({onChange=()=>{}, config={}}={}) {
    this.onChange=onChange; this.config={rakatPerSet:2,targetRakat:0,witrMode:'off',...config}; this.reset({silent:true});
  }
  get rakat(){return this.completedRakat+1;}
  snapshot(){return {position:'QIYAM',positionShort:'',rakat:this.rakat,completedRakat:this.completedRakat,
    ...this.config, lastOpeningAt:this.lastOpeningAt, reason:this.reason, seenFatiha:this.seenFatiha, fatihaFinished:this.fatihaFinished};}
  emit(reason){this.reason=reason;const s=this.snapshot();this.onChange(s);return s;}
  feedVerse({surah,ayah,locked=false,confidence=0,now=Date.now()}={}) {
    if(!locked || confidence<0.65 || !surah || !ayah) return null;
    if(surah!==1){if(this.seenFatiha && !this.fatihaFinished){this.fatihaFinished=true;return this.emit('fatiha-complete');}return null;}
    if(ayah<=3 && (!this.seenFatiha || (this.fatihaFinished && now-this.lastOpeningAt>=20000))) {
      if(this.seenFatiha)this.completedRakat=Math.min(199,this.completedRakat+1);
      this.seenFatiha=true;this.fatihaFinished=false;this.lastOpeningAt=now;
      return this.emit('fatiha-opening');
    }
    if(ayah>=6 && this.seenFatiha && !this.fatihaFinished){this.fatihaFinished=true;return this.emit('fatiha-complete');}
    return null;
  }
  // Old clients may still send these; they cannot affect count or recitation.
  feedCue(){return null;} feedText(){return null;} feedAmeen(){return null;} tick(){return null;}
  setPosition(){return this.snapshot();} nextPosition(){return this.snapshot();}
  adjustRakat(delta){const n=Number(delta);if(Number.isFinite(n))this.completedRakat=Math.max(0,Math.min(199,this.completedRakat+Math.trunc(n)));return this.emit('manual');}
  setConfig(config={}, {silent=false}={}){this.config={...this.config,...config};return silent?this.snapshot():this.emit('config');}
  reset({silent=false}={}){this.completedRakat=0;this.seenFatiha=false;this.fatihaFinished=false;this.reason='reset';this.lastOpeningAt=0;return silent?this.snapshot():this.emit('reset');}
  toJSON(now=Date.now()){return {v:1,...this.snapshot(),lastOpeningAt:this.lastOpeningAt,ts:now};}
  restore(data,{now=Date.now(),maxAgeMs=1200000}={}){
    if(!data || data.v!==1 || !Number.isFinite(data.ts) || now-data.ts>maxAgeMs || data.ts>now+60000)return false;
    this.completedRakat=Math.max(0,Math.min(199,Math.trunc(Number(data.completedRakat)||0)));
    this.seenFatiha=!!data.seenFatiha;this.fatihaFinished=!!data.fatihaFinished;
    this.lastOpeningAt=Number(data.lastOpeningAt)||data.ts;
    this.emit('restored');return true;
  }
}
