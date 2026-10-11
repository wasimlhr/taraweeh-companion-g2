import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { cyrillicToUzbekLatin } from './uzbekLatin.js';
import { getVerseData } from './verseData.js';
import { loadQuran } from './keywordMatcher.js';
import { compactLang } from '../scripts/build-translation-packs.js';

const sample = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'data/uzbek-latin-sample.json'),
  'utf8',
));

test('cyrillicToUzbekLatin matches the published Latin sample', () => {
  loadQuran();
  let compared = 0;
  for (const [key, obj] of Object.entries(sample)) {
    const [s, a] = key.split(':').map(Number);
    const cyr = getVerseData(s, a, 'uzc');
    assert.ok(cyr?.translation, key);
    const conv = cyrillicToUzbekLatin(cyr.translation);
    const want = String(obj.translation || '').replace(/[.;,]+$/u, '');
    const got = conv.replace(/[.;,]+$/u, '');
    assert.equal(got, want, key);
    compared++;
  }
  assert.equal(compared, 22);
});

test('uzbek Latin and Cyrillic cover the mushaf and glasses get Latin', () => {
  loadQuran();
  const fatihaCyr = getVerseData(1, 1, 'uzc');
  const fatihaLat = getVerseData(1, 1, 'uz');
  assert.match(fatihaCyr.translation, /Меҳрибон/);
  assert.match(fatihaLat.translation, /Mehribon/);
  assert.match(fatihaCyr.translationGlasses, /Mehribon/);
  assert.equal(fatihaLat.translationGlasses, fatihaLat.translation);

  const ikhlas = getVerseData(112, 1, 'uz');
  assert.match(ikhlas.translation, /Alloh Birdir/);

  // Spot-check a letter the G2 font lacks in Cyrillic still reaches glasses as Latin.
  const qaf = getVerseData(1, 7, 'uzc');
  assert.match(qaf.translation, /[Ққ]/);
  assert.match(qaf.translationGlasses, /q/i);
  assert.doesNotMatch(qaf.translationGlasses, /[ҒғҚқҲҳ]/);
});

test('An-Nas 114:1 Uzbek is not the built-in English line from the 3.4.7 field report', () => {
  loadQuran();
  const builtIn = getVerseData(114, 1, '');
  const uz = getVerseData(114, 1, 'uz');
  const uzc = getVerseData(114, 1, 'uzc');
  assert.match(builtIn.translation, /seek refuge in the Lord of mankind/i);
  assert.equal(builtIn.transliteration, 'Qul aAAoothu birabbi annas');
  assert.doesNotMatch(uz.translation, /seek refuge in the Lord of mankind/i);
  assert.doesNotMatch(uzc.translation, /seek refuge in the Lord of mankind/i);
  assert.match(uz.translation, /insonlarning Parvardigoridan/);
  assert.match(uzc.translation, /инсонларнинг Парвардигоридан/);
  assert.equal(uz.translationLang, 'uz');
  assert.equal(uzc.translationLang, 'uzc');
  assert.equal(uz.transliteration, 'Qul aAAoothu birabbi alnnasi');
});

test('compact uzc pack matches Mansour 114:1 and the mushaf', () => {
  const packed = compactLang('uzc');
  assert.equal(packed.verses.length, 114);
  assert.equal(packed.ayahs, 6236);
  loadQuran();
  const packedNas = packed.verses[113][0];
  const uzc = getVerseData(114, 1, 'uzc');
  assert.equal(packedNas, uzc.translation);
  assert.match(cyrillicToUzbekLatin(packedNas), /insonlarning Parvardigoridan/);
  assert.doesNotMatch(packedNas, /seek refuge in the Lord of mankind/i);
});
