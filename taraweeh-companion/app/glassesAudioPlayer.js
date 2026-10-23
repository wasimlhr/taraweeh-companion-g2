export function audioClock(ms=0){const seconds=Math.floor(Math.max(0,ms)/1000);return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
export function audioProgress(state={}){return Math.max(0,Math.min(1,(state.positionMs||0)/(state.durationMs||Infinity)));}
// A dark, compact transport strip; the ring tap toggles play/pause.
export function drawAudioPlayer(ctx,state={}){
 ctx.save();ctx.fillStyle='#000';ctx.fillRect(0,0,576,32);
 ctx.strokeStyle='#555';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(16,.5);ctx.lineTo(560,.5);ctx.stroke();
 ctx.fillStyle='#fff';
 if(state.state==='playing'){ctx.fillRect(21,11,3,13);ctx.fillRect(28,11,3,13);}
 else{ctx.beginPath();ctx.moveTo(22,10);ctx.lineTo(33,17);ctx.lineTo(22,24);ctx.closePath();ctx.fill();}
 ctx.font='16px sans-serif';ctx.direction='ltr';ctx.textBaseline='middle';ctx.textAlign='left';ctx.fillText(audioClock(state.positionMs),48,18);
 ctx.textAlign='right';ctx.fillText(audioClock(state.durationMs),558,18);
 const start=108,end=492,x=start+(end-start)*audioProgress(state);
 ctx.lineWidth=2;ctx.strokeStyle='#555';ctx.beginPath();ctx.moveTo(start,18);ctx.lineTo(end,18);ctx.stroke();
 ctx.strokeStyle='#ccc';ctx.beginPath();ctx.moveTo(start,18);ctx.lineTo(x,18);ctx.stroke();
 ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,18,3,0,Math.PI*2);ctx.fill();ctx.restore();
}
