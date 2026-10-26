// Rebuild from Quranpedia's primary mushafs-6 dump without changing source text.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const input=process.argv[2]||new URL('../language-evidence/noreen/primary-duri-source.json',import.meta.url);
const bytes=readFileSync(input),dump=JSON.parse(bytes);
if(dump.data?.id!==6||dump.data?.surahs?.length!==114||!dump.license?.version)throw Error('Expected the primary Al-Duri mushaf dump');
const chapters=dump.data.surahs.map(c=>({surah:c.id,arabicName:c.name.replace(/^سورة\s+/,''),verses:c.ayahs.map(v=>{
 if(!v.text||!v.marker||!v.number_in_hafs?.length)throw Error('Incomplete source verse '+c.id+':'+v.number);
 return {ayah:v.number,arabic:v.text,translationAyahs:v.number_in_hafs,marker:v.marker};
})}));
const output={version:dump.license.version,source:dump.license.source,sourceDump:'https://api.quranpedia.net/dumps/mushafs-6.json.gz',sourceSha256:createHash('sha256').update(bytes).digest('hex'),license:dump.license.en,bismillah:dump.data.bismillah.trim(),chapters};
writeFileSync(new URL('../backend/data/duri-reading.json',import.meta.url),JSON.stringify(output));
console.log('Imported '+chapters.length+' chapters; '+chapters.reduce((n,c)=>n+c.verses.length,0)+' original Al-Duri verses.');
