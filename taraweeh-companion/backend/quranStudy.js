// Checked-in datasets only: no outbound API calls.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const DATA=new URL('./data/study/',import.meta.url);
export const TAFSIRS={266:'Al-Mukhtasar · English',22:'Ibn Kathir',23:'Al-Qurtubi',37:'Al-Tabari',27:'Al-Baghawi',523:'Al-Jalalayn',518:'Al-Baydawi',488:'Al-Razi',491:'Ibn Juzay',489:'Al-Wahidi',494:'Al-Shawkani',496:'Ibn Al-Jawzi',500:'Ibn Al-Qayyim',493:'Al-Suyuti',513:'Al-Samarqandi',501:'Al-Alusi',512:'Al-Mawardi',510:'Al-Zamakhshari'};
export class QuranStudy {
 constructor({directory=DATA}={}){this.directory=directory;this.cache=new Map();this.corpus=null;}
 catalog(){return JSON.parse(readFileSync(new URL('catalog.json',this.directory),'utf8'));}
 read(file){if(!/^[a-zA-Z0-9-]+\.json\.gz$/.test(file))throw Error('Invalid content file');if(this.cache.has(file))return this.cache.get(file);const value=JSON.parse(gunzipSync(readFileSync(new URL(file,this.directory))));if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);this.cache.set(file,value);return value;}
 async words(key){this.corpus||=JSON.parse(readFileSync(new URL('./data/corpus/quran-words.json',import.meta.url),'utf8'));const verse=this.corpus[key];if(!verse)throw Error('Unknown ayah');return {key,source:'Local Quran morphology corpus',meaningAvailable:false,words:verse.words.map((word,index)=>({position:index+1,arabic:word.ar,root:word.root||'',meaning:'Arabic root: '+(word.root||'unavailable'),transliteration:''}))};}
 async tafsir(key,id=266){if(!TAFSIRS[id])throw Error('Unknown tafsir');const [surah,ayah]=key.split(':').map(Number);const edition=this.catalog().tafsirs.find(e=>e.id===id);if(!edition)throw Error('Tafsir not installed');const chapter=edition.chapters.find(c=>c.surah===surah);const verse=this.read(chapter.file).find(v=>v.ayah===ayah);return {key,id,name:edition.name,source:id===266?'Tafsir Center for Quranic Studies (https://tafsir.net) · CC BY 4.0':'Locally hosted classical Arabic tafsir',language:id===266?'en':'ar',text:verse?.text||''};}
 async hadith(key){return {key,available:false,message:'Hadith is hosted locally. No verified ayah-to-Hadith links are installed; browse by collection and number.',editions:this.catalog().hadith.map(e=>({name:e.name,collection:e.collectionName,language:e.language,count:e.count}))};}
 async hadithText(editionName,number){const edition=this.catalog().hadith.find(e=>e.name===editionName);if(!edition)throw Error('Unknown Hadith edition');const hadith=this.read(edition.file).hadiths.find(h=>h.hadithnumber===number);if(!hadith)throw Error('Unknown Hadith number');return {edition:edition.name,collection:edition.collectionName,language:edition.language,source:'Locally hosted Hadith library',...hadith};}
}
