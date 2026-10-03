import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLang, PACK_LANGS } from './build-translation-packs.js';
import { getVerseData } from '../backend/verseData.js';
import { loadQuran } from '../backend/keywordMatcher.js';

test('every optional language pack has 6236 ayahs', () => {
  assert.deepEqual([...PACK_LANGS], ['en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv', 'uzc']);
  for (const lang of PACK_LANGS) {
    const pack = compactLang(lang);
    assert.equal(pack.v, 1, lang);
    assert.equal(pack.lang, lang);
    assert.equal(pack.verses.length, 114, lang);
    assert.equal(pack.ayahs, 6236, lang);
    assert.equal(pack.verses.reduce((n, s) => n + s.length, 0), 6236, lang);
  }
});

test('English and Uzbek compact packs match verseData for An-Nas 114:1', () => {
  loadQuran();
  const en = compactLang('en');
  const uzc = compactLang('uzc');
  assert.match(en.verses[113][0], /seek refuge in the Lord of mankind/i);
  assert.equal(en.verses[113][0], getVerseData(114, 1, 'en').translation);
  assert.match(uzc.verses[113][0], /инсонларнинг Парвардигоридан/);
  assert.equal(uzc.verses[113][0], getVerseData(114, 1, 'uzc').translation);
});
