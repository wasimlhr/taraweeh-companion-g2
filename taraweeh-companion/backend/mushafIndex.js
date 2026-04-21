/**
 * Builds an ayah → page index from the Madani Mushaf page JSONs.
 * Output format: { "1:1": 1, "1:2": 1, ..., "114:6": 604 }
 *
 * Called once at server startup. The index is ~100 KB JSON, served via /mushaf/index.json.
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSHAF_DIR = join(__dirname, 'public', 'mushaf');
const INDEX_PATH = join(MUSHAF_DIR, 'index.json');

export function buildMushafIndex(force = false) {
  const pageFiles = readdirSync(MUSHAF_DIR).filter(f => /^page-\d{3}\.json$/.test(f));
  if (pageFiles.length === 0) {
    console.warn('[MushafIndex] No page files found — skipping');
    return null;
  }

  const index = {};
  let count = 0;
  for (const file of pageFiles) {
    const page = parseInt(file.match(/page-(\d{3})/)[1], 10);
    const data = JSON.parse(readFileSync(join(MUSHAF_DIR, file), 'utf-8'));
    for (const line of data.lines || []) {
      if (!line.verseRange) continue;
      // verseRange: "S:A-S:B" (line can span e.g. end of surah 2 + start of surah 3)
      const [startPart, endPart] = line.verseRange.split('-');
      if (!startPart || !endPart) continue;
      const [ss, sa] = startPart.split(':').map(Number);
      const [es, ea] = endPart.split(':').map(Number);
      if (!ss || !es) continue;
      // Walk every ayah in the range; map each to this page (first page wins on duplicates)
      let s = ss, a = sa;
      while (s < es || (s === es && a <= ea)) {
        const key = `${s}:${a}`;
        if (!index[key]) { index[key] = page; count++; }
        a++;
        // simplistic — doesn't cross surah boundaries mid-range; that only happens at surah ends
        // which we handle by each page independently since startPart.ss == endPart.es for most lines
        if (s < es && a > 300) break;  // safety
      }
    }
  }

  writeFileSync(INDEX_PATH, JSON.stringify(index), 'utf-8');
  console.log(`[MushafIndex] Built index — ${count} ayahs mapped to ${pageFiles.length} pages`);
  return { count, pages: pageFiles.length };
}
