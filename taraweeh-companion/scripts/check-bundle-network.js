import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export function undeclaredOrigins(text,whitelist) {
 const allowed=new Set(whitelist.map(value=>new URL(value).origin));
 return [...new Set(text.match(/(?:https?|wss?):\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?/g)||[])].filter(origin=>!allowed.has(new URL(origin).origin));
}
export function auditBundle(folder,manifest) {
 const whitelist=manifest.permissions.find(p=>p.name==='network')?.whitelist||[];
 let files=0;
 function scan(dir){for(const entry of readdirSync(dir,{withFileTypes:true})) {
  const path=join(dir,entry.name);if(entry.isDirectory()){scan(path);continue;}
  if(!/\.(html|js|json|css|txt)$/i.test(entry.name))continue;
  files++;const missing=undeclaredOrigins(readFileSync(path,'utf8'),whitelist);
  if(missing.length)throw Error(path+': undeclared network URLs: '+missing.join(', '));
 }}
 scan(folder);console.log('Bundle network audit passed: '+files+' text assets; all external origins declared.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 auditBundle(resolve('dist'),JSON.parse(readFileSync('app.json','utf8')));
}
