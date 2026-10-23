// Geometry-only manuscript frame. Colors become brightness on the G2.
function star(ctx,x,y,r){ctx.beginPath();for(let n=0;n<16;n++){const a=n*Math.PI/8-Math.PI/2,rr=n%2?r*.46:r;const xx=x+Math.cos(a)*rr,yy=y+Math.sin(a)*rr;n?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy);}ctx.closePath();ctx.stroke();}
export function drawReaderFrame(ctx,title,font='QuranIndoPak',range='',showHeader=true){
 ctx.save();ctx.strokeStyle='#555';ctx.lineWidth=1;ctx.strokeRect(3,3,570,282);ctx.strokeRect(15,15,546,258);
 for(let x=27;x<559;x+=24){star(ctx,x,9,4);star(ctx,x,279,4);}
 for(let y=27;y<268;y+=24){star(ctx,9,y,4);star(ctx,567,y,4);}
 [[9,9],[567,9],[9,279],[567,279]].forEach(([x,y])=>star(ctx,x,y,7));
 if(!showHeader){ctx.restore();return;}
 ctx.strokeStyle='#666';ctx.beginPath();ctx.moveTo(108,22);ctx.lineTo(468,22);ctx.lineTo(480,39);ctx.lineTo(468,56);ctx.lineTo(108,56);ctx.lineTo(96,39);ctx.closePath();ctx.stroke();
 for(const x of [54,78,498,522])star(ctx,x,39,9);
 if(range){ctx.fillStyle='#fff';ctx.font='16px sans-serif';ctx.textAlign='center';ctx.direction='ltr';ctx.fillText(range,147,43);const arabicRange=range.replace(/[0-9]/g,d=>String.fromCharCode(0x660+Number(d)));ctx.fillText(arabicRange,429,43);}
 ctx.fillStyle='#fff';ctx.font='24px '+font;ctx.textAlign='center';ctx.direction='rtl';ctx.fillText(title,288,43,range?140:350);ctx.restore();
}
