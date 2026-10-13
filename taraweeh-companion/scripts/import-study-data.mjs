// Pinned, reproducible server-only content import. Never downloads at runtime.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const root=new URL('../backend/data/study/',import.meta.url);
await mkdir(root,{recursive:true});
const tafsirRevision='eb82bb6294efe30ad5c135c03b1864afaa70e855';
const hadithRevision='df57907be35291c91ad6a6691180e22ca9920784';
async function download(url){for(let i=0;i<4;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error(url+' '+r.status);return await r.text();}catch(e){if(i===3)throw e;}}}
async function save(name,value){const bytes=gzipSync(Buffer.from(JSON.stringify(value)),{level:9});await writeFile(new URL(name,root),bytes);return {file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
async function pool(items,fn){let next=0;await Promise.all(Array.from({length:6},async()=>{while(next<items.length){const item=items[next++];await fn(item);}}));}
const catalog={schema:1,tafsirs:[],hadith:[],sources:{tafsir:{repository:'https://github.com/spa5k/tafsir_api',revision:tafsirRevision,license:'MIT'},hadith:{repository:'https://github.com/fawazahmed0/hadith-api',revision:hadithRevision,license:'Unlicense'}}};
for(const [name,repo,rev] of [['tafsir','spa5k/tafsir_api',tafsirRevision],['hadith','fawazahmed0/hadith-api',hadithRevision]])await writeFile(new URL(name+'-LICENSE.txt',root),await download('https://raw.githubusercontent.com/'+repo+'/'+rev+'/LICENSE'));
const editions=JSON.parse(await download('https://raw.githubusercontent.com/spa5k/tafsir_api/'+tafsirRevision+'/data/editions.json'));
// Classical Arabic texts only; repository software licenses do not clear modern translations.
for(const id of [22,23,37,27,523,518,488,491,489,494,496,500,493,513,501,512,510]){
 const edition=editions.find(e=>e.id===id);if(!edition)throw Error('Missing tafsir '+id);
 const chapters=[];await pool(Array.from({length:114},(_,i)=>i+1),async surah=>{const data=JSON.parse(await download('https://raw.githubusercontent.com/spa5k/tafsir_api/'+tafsirRevision+'/tafsir/'+edition.slug+'/'+surah+'.json'));const verses=data.ayahs||data;chapters[surah-1]={surah,entries:verses.length,...await save('tafsir-'+id+'-'+surah+'.json.gz',verses)};});
 catalog.tafsirs.push({...edition,entries:chapters.reduce((n,c)=>n+c.entries,0),chapters});console.log('Imported tafsir',id,edition.name);
 await writeFile(new URL('catalog.json',root),JSON.stringify(catalog,null,2));
}
const books=JSON.parse(await download('https://raw.githubusercontent.com/fawazahmed0/hadith-api/'+hadithRevision+'/editions.json'));
await pool(Object.values(books).flatMap(book=>book.collection.map(e=>({...e,collectionName:book.name}))),async edition=>{
 const data=JSON.parse(await download('https://raw.githubusercontent.com/fawazahmed0/hadith-api/'+hadithRevision+'/editions/'+edition.name+'.json'));
 catalog.hadith.push({...edition,count:data.hadiths.length,...await save('hadith-'+edition.name+'.json.gz',data)});console.log('Imported hadith',edition.name,data.hadiths.length);
});
catalog.hadith.sort((a,b)=>a.name.localeCompare(b.name));
await writeFile(new URL('catalog.json',root),JSON.stringify(catalog,null,2));
console.log('Complete',catalog.tafsirs.length,'tafsirs,',catalog.hadith.length,'hadith editions');
