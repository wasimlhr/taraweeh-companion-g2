#!/usr/bin/env node
/**
 * Build per-word Quran data from corpus morphology + tajweed annotations.
 *
 * Outputs: backend/data/corpus/quran-words.json
 *
 * Structure per ayah:
 *   "21:79": {
 *     words: [
 *       { ar: "فَفَهَّمْنَٰهَا", morphemes: 4, root: "فهم", pos: "V", weight: 1.2,
 *         grammar: "2nd form perf verb + pronoun", tajweed: ["madd_2"] },
 *       ...
 *     ],
 *     totalWeight: 12.5,     // sum of word weights (used for proportional timing)
 *     madds: 3,              // count of madd elongations
 *     ghunnahs: 2,           // nasalizations
 *     stops: 1,              // waqf marks
 *   }
 *
 * Weight model:
 *   Base weight = 1.0 per word
 *   + 0.15 per extra morpheme (prefixed/suffixed words take longer to recite)
 *   + 0.3 for madd_2 (2-count elongation)
 *   + 0.5 for madd_4/madd_6/madd_246 (longer elongation)
 *   + 0.2 for ghunnah/idghaam (nasalization holds)
 *   + 0.1 for idghaam_ghunnah
 *   + 0.4 for verb forms II-X (heavier pronunciation)
 *   - 0.2 for particles/prepositions (short, fast)
 */

const fs = require('fs');
const path = require('path');

const CORPUS_DIR = path.join(__dirname, '..', 'backend', 'data', 'corpus');
const MORPH_FILE = path.join(CORPUS_DIR, 'quran-morphology.txt');
const TAJWEED_FILE = path.join(CORPUS_DIR, 'tajweed.json');
const QURAN_FILE = path.join(__dirname, '..', 'backend', 'data', 'quran-full.json');
const OUTPUT_FILE = path.join(CORPUS_DIR, 'quran-words.json');

// ─── 1. Parse morphology ────────────────────────────────────────────────
console.log('Parsing morphology...');
const morphLines = fs.readFileSync(MORPH_FILE, 'utf8').split('\n');

// Group morphemes by word: location = chapter:verse:word:morpheme
// We want chapter:verse:word → list of morphemes
const wordMap = new Map(); // "21:79:1" → [{ form, tag, features }, ...]

for (const line of morphLines) {
  if (!line.trim() || line.startsWith('#')) continue;
  const parts = line.split('\t');
  if (parts.length < 4) continue;
  const [loc, form, tag, features] = parts;
  const locParts = loc.split(':');
  if (locParts.length !== 4) continue;
  const [ch, vs, wd] = locParts;
  const key = `${ch}:${vs}:${wd}`;
  if (!wordMap.has(key)) wordMap.set(key, []);
  wordMap.get(key).push({ form, tag, features });
}

console.log(`  ${wordMap.size} words parsed from morphology`);

// ─── 2. Parse tajweed ───────────────────────────────────────────────────
console.log('Parsing tajweed...');
const tajweedData = JSON.parse(fs.readFileSync(TAJWEED_FILE, 'utf8'));

// Build index: "surah:ayah" → annotations[]
const tajweedMap = new Map();
for (const entry of tajweedData) {
  const key = `${entry.surah}:${entry.ayah}`;
  tajweedMap.set(key, entry.annotations || []);
}
console.log(`  ${tajweedMap.size} ayahs with tajweed annotations`);

// ─── 3. Load Arabic text to get word boundaries ────────────────────────
console.log('Loading Arabic text...');
const quranFull = JSON.parse(fs.readFileSync(QURAN_FILE, 'utf8'));

// ─── 4. Build per-word data ─────────────────────────────────────────────
console.log('Building word data...');

// Tajweed rule weights
const TAJWEED_WEIGHTS = {
  madd_2: 0.3,
  madd_4: 0.5,
  madd_6: 0.5,
  madd_246: 0.5,
  ghunnah: 0.2,
  idghaam_ghunnah: 0.1,
  idghaam_without_ghunnah: 0.05,
  ikhfaa: 0.1,
  iqlab: 0.1,
  qalqalah: 0.05,
};

// POS abbreviation to readable
const POS_LABELS = {
  N: 'noun', V: 'verb', P: 'particle', ADJ: 'adjective',
  PN: 'proper noun', PRON: 'pronoun', DEM: 'demonstrative',
  REL: 'relative', CONJ: 'conjunction', SUB: 'subordinating',
  T: 'time', LOC: 'location', IMPN: 'imperative noun',
  NEG: 'negative', PREV: 'preventive', INTG: 'interrogative',
  VOC: 'vocative', COND: 'conditional',
};

const result = {};
let totalAyahs = 0;
let totalWords = 0;

for (const [surahNum, ayahs] of Object.entries(quranFull)) {
  for (const ayahObj of ayahs) {
    const ch = parseInt(surahNum);
    const vs = ayahObj.verse;
    const arabicText = ayahObj.text || '';
    const arabicWords = arabicText.trim().split(/\s+/).filter(w => w);
    const ayahKey = `${ch}:${vs}`;

    // Get tajweed annotations for this ayah
    const tajweedAnns = tajweedMap.get(ayahKey) || [];

    // Map tajweed annotations to word positions
    // Annotations use character offsets in the full ayah text
    // We need to figure out which word each annotation falls in
    const wordCharRanges = [];
    let pos = 0;
    for (const word of arabicWords) {
      const start = arabicText.indexOf(word, pos);
      const end = start + word.length;
      wordCharRanges.push({ start, end });
      pos = end;
    }

    // Assign tajweed rules to words
    const wordTajweed = arabicWords.map(() => []);
    for (const ann of tajweedAnns) {
      // Find which word this annotation overlaps with
      for (let wi = 0; wi < wordCharRanges.length; wi++) {
        const wr = wordCharRanges[wi];
        if (ann.start < wr.end && ann.end > wr.start) {
          wordTajweed[wi].push(ann.rule);
          break; // assign to first overlapping word
        }
      }
    }

    // Build word entries
    const words = [];
    let ayahTotalWeight = 0;
    let ayahMadds = 0;
    let ayahGhunnahs = 0;

    for (let wi = 0; wi < arabicWords.length; wi++) {
      const wordIdx = wi + 1; // 1-based
      const morphKey = `${ch}:${vs}:${wordIdx}`;
      const morphemes = wordMap.get(morphKey) || [];

      // Extract word-level info from morphemes
      let root = '';
      let mainPos = '';
      let verbForm = '';
      const morphemeCount = morphemes.length;

      for (const m of morphemes) {
        const feats = m.features || '';
        // Get root
        const rootMatch = feats.match(/ROOT:([^\|]+)/);
        if (rootMatch && !root) root = rootMatch[1];
        // Get main POS (stem, not prefix/suffix)
        if (!feats.includes('PREF') && !feats.includes('SUFF')) {
          if (!mainPos) mainPos = m.tag;
        }
        // Get verb form
        const vfMatch = feats.match(/VF:(\d+)/);
        if (vfMatch && !verbForm) verbForm = vfMatch[1];
      }

      // Calculate weight
      let weight = 1.0;

      // Morpheme bonus: prefixed/suffixed words are longer
      if (morphemeCount > 1) {
        weight += (morphemeCount - 1) * 0.15;
      }

      // Verb form bonus (forms II-X are heavier)
      if (verbForm && parseInt(verbForm) >= 2) {
        weight += 0.2;
      }

      // Particle discount (short words)
      if (mainPos === 'P' && morphemeCount <= 2) {
        weight -= 0.2;
      }

      // Tajweed bonuses
      const tj = wordTajweed[wi] || [];
      for (const rule of tj) {
        weight += TAJWEED_WEIGHTS[rule] || 0;
        if (rule.startsWith('madd')) ayahMadds++;
        if (rule.includes('ghunnah') || rule === 'ghunnah') ayahGhunnahs++;
      }

      weight = Math.max(0.3, Math.round(weight * 100) / 100);
      ayahTotalWeight += weight;

      const wordEntry = {
        ar: arabicWords[wi],
        w: weight,
      };

      // Only include optional fields if they add value
      if (root) wordEntry.root = root;
      if (mainPos && mainPos !== 'P') wordEntry.pos = mainPos;
      if (verbForm) wordEntry.vf = parseInt(verbForm);
      if (tj.length > 0) wordEntry.tj = tj;
      if (morphemeCount > 2) wordEntry.mc = morphemeCount;

      words.push(wordEntry);
      totalWords++;
    }

    result[ayahKey] = {
      words,
      tw: Math.round(ayahTotalWeight * 100) / 100,
      madds: ayahMadds || undefined,
      ghunnahs: ayahGhunnahs || undefined,
    };
    totalAyahs++;
  }
}

// ─── 5. Write output ────────────────────────────────────────────────────
console.log(`Writing ${totalAyahs} ayahs, ${totalWords} words...`);
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result));
const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${OUTPUT_FILE} (${sizeMB} MB)`);

// ─── 6. Sample output ──────────────────────────────────────────────────
console.log('\nSample — 21:79 (Sulayman):');
console.log(JSON.stringify(result['21:79'], null, 2));
console.log('\nSample — 1:1 (Bismillah):');
console.log(JSON.stringify(result['1:1'], null, 2));
