// Original monochrome UI pictograms, rasterized locally for the G2 display.
export const HOME_MODES = [
  {key:'listen',label:'Translate'},
  {key:'practice',label:'Practice'},
  {key:'reader',label:'Read Quran'},
  {key:'taraweeh',label:'Taraweeh'},
];

function icon(ctx,key,x,y){
  ctx.save();ctx.translate(x,y);ctx.lineWidth=2.5;ctx.lineCap='round';ctx.lineJoin='round';
  const path=d=>{ctx.stroke(new Path2D(d));};
  if(key==='listen'){
    // Paired language sheets and opposing translation arrows.
    path('M3 4H27V28H3Z M17 20H43V44H17 M9 10H21 M15 10V14Q15 20 9 23 M11 15L21 23 M24 37L30 25L36 37 M26 33H34 M30 7H41L37 3 M41 7L37 11 M13 38H3L7 34 M3 38L7 42');
  }else if(key==='practice'){
    // Head in profile, with thought dots: memorization and recall.
    path('M10 44V35Q2 32 3 22Q4 10 16 10Q27 10 28 23L33 29H28V36H22V44 M11 21Q11 16 17 16Q23 16 23 21Q23 25 18 26V29');
    ctx.beginPath();ctx.arc(18,33,1.4,0,Math.PI*2);ctx.fill();
    for(const [a,b,r] of [[34,16,2],[40,10,3],[39,2,4]]){ctx.beginPath();ctx.arc(a,b,r,0,Math.PI*2);ctx.stroke();}
  }else if(key==='reader'){
    // An open Quran resting on a crossed rehal stand.
    path('M3 6Q12 3 23 10Q34 3 43 6V29Q32 26 23 32Q14 26 3 29Z M23 10V32 M8 12Q14 11 19 15 M8 18Q14 17 19 21 M28 15Q34 11 39 12 M28 21Q34 17 39 18 M8 32L38 44 M38 32L8 44 M23 32V38');
  }else{
    path('M33 4A21 21 0 1 0 43 35A22 22 0 0 1 33 4Z M37 9V19 M32 14H42');
  }
  ctx.restore();
}

export function drawModeHome(ctx,selected=0){
  ctx.fillStyle='#000';ctx.fillRect(0,0,576,288);
  HOME_MODES.forEach((mode,i)=>{
    const x=12+(i%2)*282,y=8+Math.floor(i/2)*124,w=270,h=112,active=i===selected;
    ctx.fillStyle=active?'#1d1d1d':'#000';ctx.strokeStyle=active?'#fff':'#777';ctx.lineWidth=active?2:1;
    ctx.beginPath();ctx.roundRect(x,y,w,h,10);ctx.fill();ctx.stroke();
    ctx.strokeStyle=active?'#fff':'#aaa';ctx.fillStyle=ctx.strokeStyle;icon(ctx,mode.key,x+20,y+32);
    ctx.fillStyle=active?'#fff':'#b8b8b8';ctx.font='22px sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(mode.label,x+85,y+57);
    if(active){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x+w-15,y+15,3,0,Math.PI*2);ctx.fill();}
  });
  ctx.fillStyle='#999';ctx.font='15px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('Swipe to choose · Tap to open',288,274);
}

export function modeHomePage(menuObject){
  return {containerTotalNum:5,
    textObject:[{containerID:1,containerName:'homeInput',xPosition:0,yPosition:0,width:576,height:288,content:' ',isEventCapture:1,zOrderIndex:0}],
    imageObject:Array.from({length:4},(_,i)=>({containerID:30+i,containerName:'home'+i,xPosition:i%2*288,yPosition:Math.floor(i/2)*144,width:288,height:144,zOrderIndex:i+1})),menuObject};
}
