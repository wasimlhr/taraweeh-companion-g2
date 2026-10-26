// Native G2 text launcher: no image containers or image transfers.
export const HOME_MODES = [
  {key:'listen',label:'Translate'},
  {key:'practice',label:'Practice'},
  {key:'reader',label:'Read Quran'},
  {key:'taraweeh',label:'Taraweeh'},
  {key:'audio',label:'Listen Quran'},
  {key:'settings',label:'Settings'},
];

export function modeHomeContent(selected=0){
  return 'Choose mode\n\n'+HOME_MODES.map((mode,i)=>(i===selected?'> ':'  ')+mode.label).join('\n')+'\n\nSwipe to choose · Tap to open';
}

export function modeHomePage(menuObject,selected=0){
  return {containerTotalNum:1,
    textObject:[{containerID:1,containerName:'homeInput',xPosition:12,yPosition:6,width:552,height:276,content:modeHomeContent(selected),isEventCapture:1,paddingLength:0}],menuObject};
}
