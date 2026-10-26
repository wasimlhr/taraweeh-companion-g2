// Native G2 text launcher: no image containers or image transfers.
export const HOME_MODES = [
  {key:'listen',label:'Translate',guide:'Live translation\nKeeps advancing;\nheard verses adjust\ntiming and position.'},
  {key:'practice',label:'Practice',guide:'Follow your recitation\nHolds the verse until\na new verse is heard.'},
  {key:'reader',label:'Read Quran',guide:'Read at your pace\nSwipe through pages\nor use auto-scroll.'},
  {key:'taraweeh',label:'Taraweeh',guide:'Prayer companion\nLive verses with\nrakah tracking.'},
  {key:'audio',label:'Listen Quran',guide:'Quran recordings\nListen and follow\nthe verses.'},
  {key:'settings',label:'Settings',guide:'App preferences\nAdjust your display,\nlanguage and audio.'},
];

export function modeHomeContent(selected=0){
  return HOME_MODES.map((mode,i)=>(i===selected?'> ':'  ')+mode.label).join('\n');
}

export function modeHomePage(menuObject,selected=0){
  const mode=HOME_MODES[selected]||HOME_MODES[0];
  // Four native text regions, one capture target. Keep each below its visible
  // line capacity: overflowing capture text scrolls in firmware (matic H21).
  return {containerTotalNum:4,textObject:[
    {containerID:1,containerName:'homeInput',xPosition:12,yPosition:48,width:264,height:210,content:modeHomeContent(selected),isEventCapture:1,paddingLength:0},
    {containerID:2,containerName:'homeTitle',xPosition:12,yPosition:6,width:264,height:32,content:'Choose mode',isEventCapture:0,paddingLength:0},
    {containerID:3,containerName:'homeDetail',xPosition:300,yPosition:6,width:264,height:168,content:mode.label+'\n\n'+mode.guide,isEventCapture:0,paddingLength:0},
    {containerID:4,containerName:'homeHelp',xPosition:300,yPosition:190,width:264,height:92,content:'Swipe to choose\nTap to open\nDouble tap to exit',isEventCapture:0,paddingLength:0},
  ],menuObject};
}
