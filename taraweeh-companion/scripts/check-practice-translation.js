/**
 * Practice-mode translation check — whatever verse the user recites, the payload
 * pushed to the phone and glasses must carry Arabic, transliteration and
 * translation for that exact verse.
 *
 * Feeds the pipeline a sequence of unrelated verses from across the Quran (short
 * surahs, long surahs, refrains, the last ayah of a surah, and Al-Hashr 20 which
 * used to sit past a wrong ayah total) and asserts every resulting lock emits a
 * complete verse payload for the verse that was actually heard.
 *
 * Usage:
 *   node scripts/check-practice-translation.js [--lang=ur] [--verbose]
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..', 'backend');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const LANG = arg('lang', '');
const VERBOSE = argv.includes('--verbose');

const SAMPLE_RATE = 16000;
const TICK_MS = 85;

// Deliberately scattered: different surah lengths, a refrain, a surah's final
// ayah, and 59:20 which lives past the ayah total the header used to report.
// 36:1 is the bare muqatta'at "yaseen" — one of 28 single-word ayahs that are
// genuinely ambiguous alone ("alif lam meem" opens six surahs), so the matcher
// is right to wait for context. It is listed to prove that is what happens, and
// the pair below proves it locks as soon as the next ayah follows.
const TARGETS = [
  [112, 1], [2, 255], [55, 13], [59, 20], [78, 40], [1, 5], [114, 6],
  [36, 1, { ambiguousAlone: true }],
];
const CONTEXT_PAIR = [36, 2];   // "yaseen. wal-qur'ani'l-hakeem" — the real case

const corpus = JSON.parse(readFileSync(join(backendDir, 'data', 'quran-full.json'), 'utf8'));
const textOf = (s, a) => (corpus[String(s)] || []).find((v) => v.verse === a)?.text || '';

let target = 0;
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.groq.com')) throw new Error(`Unexpected fetch: ${url}`);
  const [s, a] = TARGETS[Math.min(target, TARGETS.length - 1)];
  const text = textOf(s, a);
  const words = text.split(/\s+/).filter(Boolean)
    .map((w, i) => ({ word: w, start: i * 0.45, end: i * 0.45 + 0.4 }));
  await new Promise((r) => setTimeout(r, 120));
  return new Response(JSON.stringify({ text, words }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

function pcm(rms, samples) {
  const b = Buffer.alloc(samples * 2);
  const amp = rms * 32768 * Math.sqrt(3);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2);
  return b;
}

const origLog = console.log;
console.log = () => {};
const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
loadQuran();
const { AudioPipeline } = await import(join(backendDir, 'audioPipelineV4.js'));

const emitted = new Map();   // "s:a" -> payload
const pipeline = new AudioPipeline({
  preferredSurah: 0,
  audioSource: 'browser',
  translationLang: LANG,
  whisperOpts: { provider: 'groq', apiKey: 'gsk_check' },
  onStateUpdate: (msg) => {
    if (msg.type !== 'state') return;
    const st = msg.state || {};
    if (st.mode !== 'LOCKED' || !st.surah) return;
    emitted.set(`${st.surah}:${st.ayah}`, {
      surahName: st.surahName, ayah: st.ayah, ayahTotal: st.ayahTotal,
      arabic: st.arabic, transliteration: st.transliteration, translation: st.translation,
    });
  },
  onStatus: () => {},
  onError: () => {},
});
pipeline.setPracticeMode(true);
pipeline.start();

const TICK_SAMPLES = Math.round((TICK_MS * SAMPLE_RATE) / 1000);
const feed = setInterval(() => pipeline.ingest(pcm(0.02, TICK_SAMPLES)), TICK_MS);

// Give each target long enough to be transcribed, matched and emitted.
const PER_TARGET_MS = 4000;
await new Promise((resolve) => {
  const step = setInterval(() => {
    target += 1;
    if (target >= TARGETS.length) { clearInterval(step); setTimeout(resolve, PER_TARGET_MS); }
  }, PER_TARGET_MS);
});
clearInterval(feed);
pipeline.destroy();
console.log = origLog;

const pad = (s, n) => String(s).padEnd(n);
let failures = 0;
console.log(`\nPractice mode, translation lang = ${LANG || '(built-in en)'}\n`);
console.log(`${pad('recited', 10)}${pad('emitted', 10)}${pad('arabic', 9)}${pad('translit', 10)}${pad('translation', 13)}ayahTotal`);
console.log('-'.repeat(72));

for (const [s, a, opts] of TARGETS) {
  const key = `${s}:${a}`;
  const v = emitted.get(key);
  const ok = (x) => (x && String(x).trim() ? 'yes' : 'MISSING');
  if (!v) {
    if (opts?.ambiguousAlone) {
      console.log(pad(key, 10) + pad('held', 10) + 'single-word ayah — correctly waits for context');
      continue;
    }
    failures++;
    console.log(pad(key, 10) + pad('NOT HEARD', 10) + pad('-', 9) + pad('-', 10) + pad('-', 13) + '-');
    continue;
  }
  const bad = !v.arabic?.trim() || !v.transliteration?.trim() || !v.translation?.trim() || !v.ayahTotal;
  if (bad) failures++;
  console.log(pad(key, 10) + pad(key, 10) + pad(ok(v.arabic), 9)
    + pad(ok(v.transliteration), 10) + pad(ok(v.translation), 13) + (v.ayahTotal || 'MISSING'));
  if (VERBOSE) {
    console.log(`           ${v.surahName} · ayah ${v.ayah} of ${v.ayahTotal}`);
    console.log(`           ${(v.translation || '').replace(/\s+/g, ' ').slice(0, 76)}`);
  }
}

// The muqatta'at as actually recited: the letters plus the ayah that follows.
const { findAnchor } = await import(join(backendDir, 'keywordMatcher.js'));
const pairText = `${textOf(36, 1)} ${textOf(CONTEXT_PAIR[0], CONTEXT_PAIR[1])}`;
const pairTop = findAnchor(pairText, 0).matches[0];
const pairOk = pairTop && pairTop.surah === 36 && pairTop.ayah === CONTEXT_PAIR[1];
if (!pairOk) failures++;
console.log(`\nmuqatta'at with following ayah → ${pairTop ? `${pairTop.surah}:${pairTop.ayah} score=${pairTop.score.toFixed(2)}` : 'no match'} ${pairOk ? '(ok)' : '(FAIL)'}`);

const graded = TARGETS.filter(([, , o]) => !o?.ambiguousAlone).length;
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${graded - failures}/${graded} recited verses emitted a complete translated payload\n`);
process.exit(failures === 0 ? 0 : 1);
