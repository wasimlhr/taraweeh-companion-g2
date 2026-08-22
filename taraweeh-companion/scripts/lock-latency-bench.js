/**
 * Lock-latency bench — measures how long the audio pipeline takes to reach its
 * first LOCKED state on a scripted recitation, with no network access.
 *
 * The Groq HTTP call is replaced by a stub that reads the WAV it was handed,
 * derives the audio window from its byte length, and answers with exactly the
 * words the reciter spoke inside that window. The ASR side is therefore perfect,
 * so every millisecond the bench reports comes from pipeline gating, buffering
 * and throttling rather than from transcription quality.
 *
 * Usage:
 *   node scripts/lock-latency-bench.js [--pipeline=<file>] [--source=browser|simulator|g2]
 *                                      [--rms=0.006] [--noise=0.0006] [--wps=1.6] [--pause=1200]
 *                                      [--surah=67] [--from=1] [--ayahs=10]
 *                                      [--duration=45000] [--latency=350]
 *                                      [--taraweeh] [--practice] [--verbose] [--quiet]
 *
 * All the pipeline's own tuning env vars still apply, so a suspected threshold
 * can be bisected without editing code, e.g.:
 *   BROWSER_VOICE_MIN_ACTIVITY_RMS=0.002 node scripts/lock-latency-bench.js --rms=0.0025
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..', 'backend');

// ── args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const OPTS = {
  pipeline: arg('pipeline', 'audioPipelineV4.js'),
  source: arg('source', 'browser'),
  voicedRms: parseFloat(arg('rms', '0.006')),
  noiseRms: parseFloat(arg('noise', '0.0006')),
  wps: parseFloat(arg('wps', '1.6')),
  ayahPauseMs: parseInt(arg('pause', '1200'), 10),
  durationMs: parseInt(arg('duration', '45000'), 10),
  asrLatencyMs: parseInt(arg('latency', '350'), 10),
  surah: parseInt(arg('surah', '67'), 10),
  fromAyah: parseInt(arg('from', '1'), 10),
  ayahCount: parseInt(arg('ayahs', '10'), 10),
  taraweeh: argv.includes('--taraweeh'),
  practice: argv.includes('--practice'),
  verbose: argv.includes('--verbose'),
  quiet: argv.includes('--quiet'),
};

const SAMPLE_RATE = 16000;
const TICK_MS = 85;                 // matches the browser 4096-frame ScriptProcessor
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

// ── scripted recitation ──────────────────────────────────────────────────────

const quran = JSON.parse(readFileSync(join(backendDir, 'data', 'quran-full.json'), 'utf8'));
const verses = (quran[String(OPTS.surah)] || [])
  .filter((v) => v.verse >= OPTS.fromAyah && v.verse < OPTS.fromAyah + OPTS.ayahCount);
if (!verses.length) throw new Error(`No verses for surah ${OPTS.surah}`);

// Every word gets a spoken start/end on the recitation clock. Between ayahs the
// reciter takes a breath, which is the silence the pipeline's VAD has to survive.
const timeline = [];
let cursorMs = 0;
const msPerWord = 1000 / OPTS.wps;
for (const v of verses) {
  for (const word of v.text.split(/\s+/).filter(Boolean)) {
    timeline.push({ word, startMs: cursorMs, endMs: cursorMs + msPerWord * 0.85, ayah: v.verse });
    cursorMs += msPerWord;
  }
  cursorMs += OPTS.ayahPauseMs;
}
const recitationMs = cursorMs;

function isVoicedAt(ms) {
  for (const w of timeline) {
    if (w.startMs > ms) break;
    if (ms >= w.startMs && ms < w.endMs) return true;
  }
  return false;
}

function wordsInWindow(fromMs, toMs) {
  return timeline.filter((w) => {
    const mid = (w.startMs + w.endMs) / 2;
    return mid >= fromMs && mid <= toMs;
  });
}

// ── synthetic PCM ────────────────────────────────────────────────────────────

function makePcm(targetRms, samples) {
  const buf = Buffer.alloc(samples * 2);
  // Uniform noise has rms = amplitude / sqrt(3); solve for the target rms.
  const amp = Math.min(32000, targetRms * 32768 * Math.sqrt(3));
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2);
  }
  return buf;
}

// ── stubbed Groq endpoint ────────────────────────────────────────────────────

const asrCalls = [];
let clockStart = 0;

globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.groq.com')) throw new Error(`Unexpected fetch: ${url}`);
  // groqProvider posts a FormData whose "file" part is the WAV it decided to
  // send, so its size is exactly the audio window the pipeline chose.
  const file = init?.body?.get?.('file');
  const wavBytes = file?.size ?? 44;
  const windowMs = Math.max(0, (wavBytes - 44) / BYTES_PER_MS);
  const nowMs = Date.now() - clockStart;
  const from = nowMs - windowMs;
  const heard = wordsInWindow(from, nowMs);
  const text = heard.map((w) => w.word).join(' ');
  asrCalls.push({ atMs: nowMs, windowMs: Math.round(windowMs), words: heard.length, text });
  if (OPTS.verbose) {
    console.log(`  [ASR] t=${(nowMs / 1000).toFixed(1)}s window=${Math.round(windowMs)}ms words=${heard.length}`);
  }
  await new Promise((r) => setTimeout(r, OPTS.asrLatencyMs));
  return new Response(JSON.stringify({
    text,
    words: heard.map((w) => ({ word: w.word, start: (w.startMs - from) / 1000, end: (w.endMs - from) / 1000 })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// ── run ──────────────────────────────────────────────────────────────────────

if (OPTS.quiet) {
  console.log = () => {};
  console.warn = () => {};
}
const realLog = process.stdout.write.bind(process.stdout);
function out(line) { realLog(line + '\n'); }

const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
loadQuran();
const { AudioPipeline } = await import(join(backendDir, OPTS.pipeline));

let lockedAtMs = 0;
let lockedVerse = null;
const locks = [];

const pipeline = new AudioPipeline({
  preferredSurah: 0,
  audioSource: OPTS.source,
  whisperOpts: { provider: 'groq', apiKey: 'gsk_bench' },
  onStateUpdate: (msg) => {
    if (msg.type !== 'state') return;
    const st = msg.state || {};
    if (st.mode !== 'LOCKED') return;
    const verse = `${st.surah}:${st.ayah}`;
    if (!lockedAtMs) { lockedAtMs = Date.now() - clockStart; lockedVerse = verse; }
    if (locks[locks.length - 1]?.verse !== verse) {
      locks.push({ atMs: Date.now() - clockStart, verse });
    }
  },
  onStatus: () => {},
  onError: () => {},
});
if (OPTS.taraweeh) pipeline.setTaraweehMode(true);
if (OPTS.practice) pipeline.setPracticeMode(true);

const truncations = [];
let lastSearchBufMs = 0;

pipeline.start();
clockStart = Date.now();

const tick = setInterval(() => {
  const elapsed = Date.now() - clockStart;
  if (elapsed > OPTS.durationMs) return;
  const voiced = isVoicedAt(elapsed % (recitationMs + 2000));
  const samples = Math.round((TICK_MS * SAMPLE_RATE) / 1000);
  const before = pipeline._searchBuf ? pipeline._searchBuf.length / BYTES_PER_MS : 0;
  pipeline.ingest(makePcm(voiced ? OPTS.voicedRms : OPTS.noiseRms, samples));
  const after = pipeline._searchBuf ? pipeline._searchBuf.length / BYTES_PER_MS : 0;
  if (before > 1500 && after < before - 500) {
    truncations.push({ atMs: elapsed, fromMs: Math.round(before), toMs: Math.round(after) });
  }
  lastSearchBufMs = after;
}, TICK_MS);

setTimeout(() => {
  clearInterval(tick);
  pipeline.destroy();
  report();
  process.exit(0);
}, OPTS.durationMs + 500);

function report() {
  out('');
  out('='.repeat(78));
  out(`pipeline=${OPTS.pipeline} source=${OPTS.source} rms=${OPTS.voicedRms} wps=${OPTS.wps} pause=${OPTS.ayahPauseMs}ms`);
  out('='.repeat(78));
  out(`ASR calls           : ${asrCalls.length} in ${OPTS.durationMs / 1000}s`);
  if (asrCalls.length) {
    out(`first ASR call at   : ${(asrCalls[0].atMs / 1000).toFixed(2)}s (window ${asrCalls[0].windowMs}ms)`);
    const gaps = asrCalls.slice(1).map((c, i) => Math.round(c.atMs - asrCalls[i].atMs));
    if (gaps.length) out(`ASR call gaps (ms)  : ${gaps.join(', ')}`);
    out(`ASR windows (ms)    : ${asrCalls.map((c) => c.windowMs).join(', ')}`);
    out(`ASR words per call  : ${asrCalls.map((c) => c.words).join(', ')}`);
  }
  out(`FIRST LOCK          : ${lockedAtMs ? `${(lockedAtMs / 1000).toFixed(2)}s on ${lockedVerse}` : 'NEVER LOCKED'}`);
  out(`verse locks         : ${locks.length ? locks.map((l) => `${(l.atMs / 1000).toFixed(1)}s=${l.verse}`).join(' ') : 'none'}`);
  out(`search-buf truncs   : ${truncations.length}${truncations.length ? ` -> ${truncations.slice(0, 8).map((t) => `${(t.atMs / 1000).toFixed(1)}s:${t.fromMs}->${t.toMs}ms`).join(', ')}` : ''}`);
  out(`final search buf    : ${Math.round(lastSearchBufMs)}ms`);
}
