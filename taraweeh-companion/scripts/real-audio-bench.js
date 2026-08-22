/**
 * Real-audio sync bench — the same measurement as sync-accuracy-bench.js, but
 * driven by an actual recitation instead of synthetic tones, and by an actual
 * Whisper instead of a perfect stub.
 *
 * Audio comes from scripts/fetch-recitation.sh, which stitches per-ayah files so
 * every ayah boundary is known exactly. Transcription goes to the local Whisper
 * server, which receives the same WAV the pipeline would have posted to Groq.
 * So both halves of the loop are real: real recitation levels through the voice
 * gate and clip guard, and real ASR errors through the matcher.
 *
 * The local model is `small` on CPU; Groq runs large-v3-turbo, so treat every
 * number here as a floor rather than a ceiling.
 *
 * Usage:
 *   node scripts/real-audio-bench.js --dir=/tmp/recitations/Alafasy_128kbps_78_1-40
 *        [--target-rms=0.006]   attenuate to simulate a phone mic at distance
 *        [--whisper=http://127.0.0.1:8123] [--taraweeh] [--fast] [--timeline]
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { quotaReport } from './lib/quota.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OPTS = {
  dir: arg('dir', null),
  targetRms: parseFloat(arg('target-rms', '0')),   // 0 = leave the audio as-is
  whisper: arg('whisper', ''),                     // live local model, if given
  asrLatency: parseInt(arg('asr-latency', '350'), 10),   // Groq-like, for transcript mode
  taraweeh: argv.includes('--taraweeh'),
  fast: argv.includes('--fast'),
  practice: argv.includes('--practice'),
  timeline: argv.includes('--timeline'),
  quiet: argv.includes('--quiet'),
};
if (!OPTS.dir) throw new Error('--dir is required (output of fetch-recitation.sh)');

const SAMPLE_RATE = 16000;
const TICK_MS = 85;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const SAMPLE_EVERY_MS = 250;

// ── real audio + known ayah boundaries ───────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(OPTS.dir, 'manifest.json'), 'utf8'));
const wav = readFileSync(join(OPTS.dir, 'audio.wav'));

// Skip the RIFF header to reach PCM. Files come straight from ffmpeg as
// 16kHz mono s16le, so the header is the canonical 44 bytes.
let pcm = wav.subarray(44);
const totalMs = Math.floor(pcm.length / BYTES_PER_MS);

// Cumulative boundaries: which ayah is sounding at time t.
const bounds = [];
let acc = 0;
for (const a of manifest.ayahs) {
  bounds.push({ ayah: a.ayah, startMs: acc, endMs: acc + a.durationMs });
  acc += a.durationMs;
}
const truthAt = (ms) => {
  for (let i = bounds.length - 1; i >= 0; i--) if (ms >= bounds[i].startMs) return bounds[i];
  return bounds[0];
};

function rmsOf(buf) {
  const n = Math.floor(buf.length / 2);
  let s = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; s += v * v; }
  return Math.sqrt(s / n);
}

const originalRms = rmsOf(pcm);
if (OPTS.targetRms > 0) {
  const gain = OPTS.targetRms / originalRms;
  const scaled = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length / 2; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * gain)));
    scaled.writeInt16LE(v, i * 2);
  }
  pcm = scaled;
}
const feedRms = rmsOf(pcm);

// ── real Whisper standing in for Groq ────────────────────────────────────────

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

// Two ways to stand in for Groq:
//  --whisper=<url>  post the exact WAV to a local model. Most faithful, but the
//                   local turbo needs ~5s per 6s window on CPU, which is slower
//                   than the pipeline's own check interval and so distorts it.
//  transcript.json  one real transcription of the whole recitation, replayed by
//                   timestamp with Groq-like latency. Real recitation, real ASR
//                   errors, realistic timing — but the model saw more context
//                   than a 6s request would, so ASR quality is optimistic.
let transcript = null;
if (!OPTS.whisper) {
  transcript = JSON.parse(readFileSync(join(OPTS.dir, 'transcript.json'), 'utf8'));
}

const asrCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.groq.com')) return realFetch(url, init);
  const file = init?.body?.get?.('file');
  const buf = Buffer.from(await file.arrayBuffer());
  const windowMs = Math.round((buf.length - 44) / BYTES_PER_MS);
  const t0 = Date.now();
  let data;
  if (OPTS.whisper) {
    const res = await realFetch(`${OPTS.whisper}/transcribe`, {
      method: 'POST', body: buf, headers: { 'content-type': 'audio/wav' },
    });
    data = await res.json();
  } else {
    const nowMs = Date.now() - clockStart;
    const from = (nowMs - windowMs) / 1000;
    const to = nowMs / 1000;
    const heard = transcript.words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= from && mid <= to;
    });
    await new Promise((r) => setTimeout(r, OPTS.asrLatency));
    data = {
      text: heard.map((w) => w.word).join(' '),
      words: heard.map((w) => ({ word: w.word, start: w.start - from, end: w.end - from })),
    };
  }
  asrCalls.push({
    atMs: Date.now() - clockStart, windowMs, latencyMs: Date.now() - t0,
    words: data.words?.length || 0, text: data.text || '',
  });
  return new Response(JSON.stringify(data), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

// ── run ──────────────────────────────────────────────────────────────────────

const backendDir = join(import.meta.dirname, '..', 'backend');
const out = OPTS.quiet ? (() => { const w = process.stdout.write.bind(process.stdout); console.log = () => {}; console.warn = () => {}; return (l) => w(l + '\n'); })() : (l) => console.log(l);

const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
loadQuran();
const { AudioPipeline } = await import(join(backendDir, 'audioPipelineV4.js'));

let shown = null;
let clockStart = 0;
const pipeline = new AudioPipeline({
  preferredSurah: 0,
  audioSource: 'browser',
  whisperOpts: { provider: 'groq', apiKey: 'gsk_real_audio_bench' },
  onStateUpdate: (msg) => {
    if (msg.type !== 'state') return;
    const st = msg.state || {};
    if (st.mode === 'SEARCHING' || !st.surah) return;
    shown = { surah: st.surah, ayah: st.ayah };
  },
  onStatus: () => {},
  onError: () => {},
});
if (OPTS.fast) pipeline.setFastMode(true);
if (OPTS.taraweeh) pipeline.setTaraweehMode(true);
if (OPTS.practice) pipeline.setPracticeMode(true);

const samples = [];
pipeline.start();
clockStart = Date.now();

const TICK_BYTES = Math.round(TICK_MS * BYTES_PER_MS);
let cursor = 0;
const feed = setInterval(() => {
  const elapsed = Date.now() - clockStart;
  // Keep the stream aligned to wall clock so a slow tick cannot desynchronise
  // the audio from the ground-truth timeline.
  const want = Math.min(pcm.length, Math.floor(elapsed * BYTES_PER_MS));
  if (cursor >= pcm.length) return;
  const end = Math.min(pcm.length, Math.max(cursor + TICK_BYTES, want));
  pipeline.ingest(pcm.subarray(cursor, end));
  cursor = end;
}, TICK_MS);

const probe = setInterval(() => {
  const elapsed = Date.now() - clockStart;
  if (elapsed > totalMs) return;
  samples.push({ atMs: elapsed, truth: truthAt(elapsed).ayah, shown: shown ? { ...shown } : null });
}, SAMPLE_EVERY_MS);

setTimeout(() => {
  clearInterval(feed);
  clearInterval(probe);
  pipeline.destroy();
  report();
  process.exit(0);
}, totalMs + 1500);

function report() {
  const firstIdx = samples.findIndex((s) => s.shown);
  const tracked = firstIdx < 0 ? [] : samples.slice(firstIdx);
  const errs = tracked.map((s) => {
    if (!s.shown) return null;
    if (s.shown.surah !== manifest.surah) return 'surah';
    return s.shown.ayah - s.truth;
  });
  const numeric = errs.filter((e) => typeof e === 'number');
  const n = errs.length || 1;
  const pct = (v) => `${((v / n) * 100).toFixed(1)}%`;
  const ahead = numeric.filter((e) => e > 0);
  const behind = numeric.filter((e) => e < 0);

  // Longest continuous run where the error breaches a tolerance. A one-ayah
  // offset is acceptable in use, so the tolerance=1 figure is the one that
  // describes a real failure; tolerance=0 is reported for reference.
  const longestRunBeyond = (tol) => {
    let worst = { runMs: 0, atMs: 0 };
    let runStart = -1;
    for (let i = 0; i <= errs.length; i++) {
      const e = i < errs.length ? errs[i] : 0;
      const bad = i < errs.length && (e === 'surah' || Math.abs(e) > tol);
      if (bad && runStart < 0) runStart = i;
      if (!bad && runStart >= 0) {
        const runMs = (i - runStart) * SAMPLE_EVERY_MS;
        if (runMs > worst.runMs) worst = { runMs, atMs: tracked[runStart].atMs };
        runStart = -1;
      }
    }
    return worst;
  };
  const worst = longestRunBeyond(0);
  const worstBeyond1 = longestRunBeyond(1);
  const outside1 = errs.filter((e) => e === 'surah' || (typeof e === 'number' && Math.abs(e) > 1)).length;

  const lat = asrCalls.map((c) => c.latencyMs).sort((a, b) => a - b);
  const emptyCalls = asrCalls.filter((c) => !c.text.trim()).length;

  out('');
  out('='.repeat(78));
  out(`REAL AUDIO  ${manifest.reciter}  surah ${manifest.surah}:${bounds[0].ayah}-${bounds[bounds.length - 1].ayah}`);
  out(`${(totalMs / 1000).toFixed(0)}s of recitation · ${bounds.length} ayahs · fed at rms=${feedRms.toFixed(4)}${OPTS.targetRms ? ` (attenuated from ${originalRms.toFixed(4)})` : ' (as recorded)'}`);
  out(`taraweeh=${OPTS.taraweeh} fast=${OPTS.fast} practice=${OPTS.practice}`);
  out('='.repeat(78));
  out(`ayah pace           : ${(bounds.reduce((a, b) => a + (b.endMs - b.startMs), 0) / bounds.length / 1000).toFixed(1)}s per ayah`);
  out(`first lock at       : ${firstIdx < 0 ? 'NEVER' : `${(samples[firstIdx].atMs / 1000).toFixed(1)}s`}`);
  out(`ASR calls           : ${asrCalls.length} (${(asrCalls.length / (totalMs / 60000)).toFixed(1)} per min), ${emptyCalls} returned nothing`);
  out(`ASR source          : ${OPTS.whisper ? `live ${OPTS.whisper}` : `${transcript.model.split('/').pop()} (${transcript.compute}), replayed`}`);
  quotaReport(out, asrCalls, totalMs);
  out(`ASR latency         : median ${lat.length ? lat[Math.floor(lat.length / 2)] : 0}ms (Groq is ~350ms)`);
  out(`IN SYNC (exact)     : ${pct(numeric.filter((e) => e === 0).length)}`);
  out(`within +/-1 ayah    : ${pct(numeric.filter((e) => Math.abs(e) <= 1).length)}`);
  out(`display AHEAD       : ${pct(ahead.length)}${ahead.length ? ` (max +${Math.max(...ahead)})` : ''}`);
  out(`display BEHIND      : ${pct(behind.length)}${behind.length ? ` (max ${Math.min(...behind)})` : ''}`);
  out(`wrong surah         : ${pct(errs.filter((e) => e === 'surah').length)}`);
  out(`OUTSIDE +/-1        : ${pct(outside1)}   <- the failure case`);
  out(`longest beyond +/-1 : ${(worstBeyond1.runMs / 1000).toFixed(1)}s${worstBeyond1.runMs ? ` starting at ${(worstBeyond1.atMs / 1000).toFixed(1)}s` : ''}`);
  out(`longest not-exact   : ${(worst.runMs / 1000).toFixed(1)}s starting at ${(worst.atMs / 1000).toFixed(1)}s`);

  if (OPTS.timeline) {
    out('');
    out('t(s)  truth  shown  err');
    for (const s of tracked) {
      if (s.atMs % 2000 >= SAMPLE_EVERY_MS) continue;
      const sh = s.shown ? `${s.shown.surah}:${s.shown.ayah}` : '--';
      const e = s.shown ? (s.shown.surah !== manifest.surah ? 'SURAH' : String(s.shown.ayah - s.truth)) : '--';
      out(`${(s.atMs / 1000).toFixed(0).padStart(4)}  ${String(s.truth).padEnd(6)} ${sh.padEnd(6)} ${e.padStart(5)}`);
    }
    out('');
    out('ASR transcripts:');
    for (const c of asrCalls) out(`  ${(c.atMs / 1000).toFixed(1)}s ${c.windowMs}ms "${c.text.slice(0, 70)}"`);
  }
}
