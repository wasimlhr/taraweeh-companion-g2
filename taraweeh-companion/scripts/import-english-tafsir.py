"""Extract the publisher's CC BY 4.0 English Al-Mukhtasar, without rewriting text.
Download quran.db at the pinned revision below into language-evidence first.
"""
import sqlite3, json, gzip, hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
directory=root/'backend/data/study'
revision='dbbfa77518a724a10e72d8d7fd48d2d36a50fa9e'
db=sqlite3.connect(f'file:{root / "language-evidence/tafsir-center-quran.db"}?mode=ro',uri=True)
chapters=[]
for surah in range(1,115):
    verses=[{'surah':s,'ayah':a,'text':text} for s,a,text in db.execute('select surahNo,ayahNo,Mukhtasaren from QuranTafseer where surahNo=? order by ayahNo',(surah,))]
    assert all(v['text'] for v in verses)
    name=f'tafsir-266-{surah}.json.gz'
    data=gzip.compress(json.dumps(verses,ensure_ascii=False).encode(),mtime=0)
    (directory/name).write_bytes(data)
    chapters.append({'surah':surah,'entries':len(verses),'file':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
assert sum(c['entries'] for c in chapters)==6236
catalog=json.loads((directory/'catalog.json').read_text())
catalog['tafsirs']=[e for e in catalog['tafsirs'] if e['id']!=266]
catalog['tafsirs'].insert(0,{'id':266,'name':'Al-Mukhtasar · English','language_name':'english','author_name':'Tafsir Center for Quranic Studies','source':'https://huggingface.co/datasets/tafsircenter/tafsir-mcp-data','revision':revision,'license':'CC-BY-4.0','attribution':'Tafsir Center for Quranic Studies (https://tafsir.net)','entries':6236,'chapters':chapters})
(directory/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf8')
(directory/'english-tafsir-NOTICE.txt').write_text('English Al-Mukhtasar. Copyright Tafsir Center for Quranic Studies (https://tafsir.net).\nCC BY 4.0: https://creativecommons.org/licenses/by/4.0/\nSource: https://huggingface.co/datasets/tafsircenter/tafsir-mcp-data/tree/'+revision+'\nText extracted verbatim from QuranTafseer.Mukhtasaren; presentation packaged as per-surah JSON.\n',encoding='utf8')
print('Imported 6236 English commentary entries')
