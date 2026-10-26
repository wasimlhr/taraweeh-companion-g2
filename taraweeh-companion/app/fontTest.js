import {ARABIC_FONTS,ARABIC_SIZES,ARABIC_RENDERINGS,arabicPreferences,fontTestCanvas} from './glassesTypography.js';

export function mountFontTest({host,onDraw=()=>{},onApply=()=>{},onClose=()=>{}}){
 host.innerHTML=`<header class="reader-top"><button type="button" class="back-btn" data-font-back>← Back</button><h2>Arabic font test</h2></header>
 <p class="settings-panel-hint">Compare all three bundled fonts on your glasses. Listening pauses while you test. Changes stay in this preview until you save.</p>
 <div class="font-test-controls"><label>Arabic size<select data-font-size></select></label><label>Rendering<select data-font-rendering></select></label></div>
 <p class="settings-panel-hint">Larger letters fit fewer words. Smooth rendering uses the same display pixels. Al-Duri is used automatically for Noreen’s reading.</p>
 <button type="button" class="back-btn" data-font-apply>Use these settings</button><p class="s-hint" data-font-status role="status" aria-live="polite"></p><div data-font-samples></div>`;
 const size=host.querySelector('[data-font-size]'),rendering=host.querySelector('[data-font-rendering]'),status=host.querySelector('[data-font-status]');
 for(const value of ARABIC_SIZES)size.add(new Option(value+' px'+(value===28?' (default)':''),value));
 for(const option of ARABIC_RENDERINGS)rendering.add(new Option(option.label,option.id));
 const samples=host.querySelector('[data-font-samples]'),rows=[];let preferences={},index=0,epoch=0,active=false;
 for(const [i,font] of ARABIC_FONTS.entries()){
  const row=document.createElement('section');row.className='font-test-sample';
  const title=document.createElement('h3');title.textContent=font.label;
  const button=document.createElement('button');button.type='button';button.className='back-btn';button.textContent='Show on glasses';button.onclick=()=>show(i);
  const canvas=document.createElement('canvas');canvas.width=576;canvas.height=288;canvas.setAttribute('aria-label',font.label+' Arabic preview');
  row.append(title,button,canvas);samples.append(row);rows.push({row,button,canvas});
 }
 function snapshot(){return {...preferences,font:ARABIC_FONTS[index].id,index};}
 async function show(next=index){
  index=(next+ARABIC_FONTS.length)%ARABIC_FONTS.length;const serial=++epoch;
  size.value=String(preferences.glassesArabicSize);rendering.value=preferences.glassesArabicRendering;
  host.querySelector('[data-font-apply]').textContent=index===2?'Use size and rendering':'Use these settings';
  status.textContent='Preparing font preview…';
  try{
   const canvases=await Promise.all(ARABIC_FONTS.map(font=>fontTestCanvas(font,preferences)));
   if(!active||serial!==epoch)return;
   rows.forEach(({canvas,row,button},i)=>{canvas.getContext('2d').drawImage(canvases[i],0,0);row.dataset.selected=String(i===index);button.setAttribute('aria-pressed',String(i===index));button.textContent='Show on glasses';});
   const shown=await onDraw(canvases[index],ARABIC_FONTS[index],snapshot());
   if(active&&serial===epoch){rows[index].button.textContent=shown?'Showing on glasses':'Selected preview';status.textContent=ARABIC_FONTS[index].label+' · '+size.value+' px · '+ARABIC_RENDERINGS.find(o=>o.id===rendering.value).label+(shown?'':' · Phone preview; connect glasses to compare on device.');}
  }catch(error){if(active&&serial===epoch)status.textContent='Preview unavailable. Choose a font to retry.';}
 }
 size.onchange=()=>{preferences.glassesArabicSize=Number(size.value);show();};
 rendering.onchange=()=>{preferences.glassesArabicRendering=rendering.value;show();};
 async function apply(){await onApply({...preferences,glassesArabicFont:index===2?preferences.glassesArabicFont:ARABIC_FONTS[index].id});status.textContent='Saved. '+(index===2?'Al-Duri stays automatic for Noreen.':'Font, size and rendering apply to Arabic on glasses.');}
 host.querySelector('[data-font-back]').onclick=onClose;host.querySelector('[data-font-apply]').onclick=apply;
 return {async open(settings,font){active=true;const normalized=arabicPreferences(settings);preferences={glassesArabicSize:normalized.size,glassesArabicRendering:normalized.rendering,glassesArabicFont:normalized.font};index=Math.max(0,ARABIC_FONTS.findIndex(o=>o.id===font));await show(index);},close(){active=false;++epoch;},snapshot,
  event(event){const e=event.textEvent||event.listEvent||event.sysEvent,t=e?.eventType??0,id=event.menuItemClickEvent?.itemID;
   if(id===67||t===3||event.sysEvent&&(t===6||t===7))return onClose();
   if(event.sysEvent&&(t===4||t===5))return;
   if(id===61||id===62||e&&(t===1||t===2))return show(index+(id===62||t===1?-1:1));
   if(id===66)return apply();
   if(id===65){const n=ARABIC_RENDERINGS.findIndex(o=>o.id===preferences.glassesArabicRendering);preferences.glassesArabicRendering=ARABIC_RENDERINGS[(n+1)%ARABIC_RENDERINGS.length].id;return show();}
   if(id===63||id===64||e&&t===0){const n=ARABIC_SIZES.indexOf(preferences.glassesArabicSize);preferences.glassesArabicSize=ARABIC_SIZES[(n+(id===64?ARABIC_SIZES.length-1:1))%ARABIC_SIZES.length];return show();}
  }};
}
