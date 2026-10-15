"""Pinned upstream Quranic Arabic Corpus data; no runtime external dependency."""
import gzip,hashlib,json,re,unicodedata,urllib.request,xml.etree.ElementTree as ET
from pathlib import Path
from functools import lru_cache
root=Path(__file__).resolve().parents[1]
out=root/'backend/data/study'
revision='17a9062416eccc332111ef3e84f74072d709e187'
base='https://raw.githubusercontent.com/kaisdukes/quranic-corpus-api/'+revision+'/src/main/resources/data/'
def source(name,url):
 data=urllib.request.urlopen(url).read()
 (out/name).write_bytes(gzip.compress(data,mtime=0))
 return data
raw=source('qac-word-by-word-source.txt.gz',base+'translation/word-by-word.txt')
xml=source('qac-uthmani-alignment-source.xml.gz',base+'quran-uthmani.xml')
local=json.loads((root/'backend/data/corpus/quran-words.json').read_text(encoding='utf8'))
meanings=raw.decode('utf8').splitlines()
def norm(text):
 # Older Tanzil spells sahibay in 12:39/41 with a ya-shaped alif.
 text=text.replace('صَىٰح','صَٰح')
 text=text.replace('ٱ','ا').replace('ى','ي').replace('ـ','').replace('ۥ','').replace('ۦ','')
 return ''.join(c for c in unicodedata.normalize('NFKD',text) if '\u0622'<=c<='\u064a')
verses={};pointer=0;grouped=[];mismatches=[]
for sura in ET.fromstring(xml):
 for aya in sura:
  key=sura.attrib['index']+':'+aya.attrib['index']
  words=[w for w in aya.attrib['text'].split() if norm(w)]
  # The upstream Tokenizer treats Il Yasin as a single token.
  if key=='37:130':words=words[:2]+[' '.join(words[2:])]
  gloss=meanings[pointer:pointer+len(words)];pointer+=len(words)
  assert len(gloss)==len(words) and all(gloss),key
  target=local[key]['words']
  @lru_cache(None)
  def align(i,j):
   if i==len(words) and j==len(target):return ()
   for n in range(1,4):
    for m in range(1,4):
     if i+n>len(words) or j+m>len(target):continue
     if norm(''.join(words[i:i+n]))!=norm(''.join(w['ar'] for w in target[j:j+m])):continue
     rest=align(i+n,j+m)
     if rest is not None:return ((i,j,n,m),)+rest
   return None
  mapping=align(0,0)
  if mapping is None:mismatches.append(key);continue
  rows=[None]*len(target)
  for i,j,n,m in mapping:
   meaning=' '.join(gloss[i:i+n])
   for position in range(j,j+m):rows[position]={'meaning':meaning,'scope':'word' if n==m==1 else 'phrase','sourcePositions':list(range(i+1,i+n+1))}
   if n!=1 or m!=1:grouped.append({'key':key,'sourcePositions':list(range(i+1,i+n+1)),'localPositions':list(range(j+1,j+m+1))})
  verses[key]=rows
assert not mismatches, 'Unaligned ayahs: '+str(mismatches)
assert pointer==len(meanings),(pointer,len(meanings))
assert len(verses)==6236
payload={'schema':1,'source':'Quranic Arabic Corpus, Kais Dukes / University of Leeds','revision':revision,'license':'GNU GPL','sourceUrl':base+'translation/word-by-word.txt','sourceSha256':hashlib.sha256(raw).hexdigest(),'alignmentSha256':hashlib.sha256(xml).hexdigest(),'ayahs':len(verses),'words':sum(len(v) for v in verses.values()),'groups':grouped,'verses':verses}
(out/'quran-word-glosses.json.gz').write_bytes(gzip.compress(json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode('utf8'),mtime=0))
print('Imported',payload['ayahs'],'ayahs,',payload['words'],'local words;',len(grouped),'explicit phrase alignments')
