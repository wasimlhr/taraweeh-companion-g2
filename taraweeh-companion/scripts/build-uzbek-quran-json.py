#!/usr/bin/env python3
"""
Build backend/data/quran-json/quran_uzc.json from Alauddin Mansour's
Cyrillic Uzbek translation (chapter/verse list).

  python3 scripts/build-uzbek-quran-json.py /path/to/uzb-alauddinmansour.json
"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
en_path = root / 'backend/data/quran-json/quran_en.json'
out_path = root / 'backend/data/quran-json/quran_uzc.json'


def main():
    src_path = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/uzbek/uzb-alauddinmansour.json')
    src = json.loads(src_path.read_text(encoding='utf-8'))
    verses = {(int(v['chapter']), int(v['verse'])): v['text'].strip() for v in src['quran']}
    if len(verses) != 6236:
        raise SystemExit(f'expected 6236 verses, got {len(verses)}')

    en = json.loads(en_path.read_text(encoding='utf-8'))
    out = []
    missing = []
    for ch in en:
        sid = ch['id']
        cloned = {k: ch[k] for k in ch if k != 'verses'}
        cloned['verses'] = []
        for v in ch['verses']:
            text = verses.get((sid, v['id']))
            if not text:
                missing.append(f'{sid}:{v["id"]}')
                text = ''
            cloned['verses'].append({'id': v['id'], 'text': v['text'], 'translation': text})
        out.append(cloned)
    if missing:
        raise SystemExit(f'missing {len(missing)} verses: {missing[:12]}')
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {out_path} ({out_path.stat().st_size} bytes, {len(verses)} verses)')


if __name__ == '__main__':
    main()
