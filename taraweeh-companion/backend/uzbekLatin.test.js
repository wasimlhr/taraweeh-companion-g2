import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { cyrillicToUzbekLatin } from './uzbekLatin.js';
import { getVerseData } from './verseData.js';
import { loadQuran } from './keywordMatcher.js';

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
