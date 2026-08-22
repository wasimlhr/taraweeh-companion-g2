/**
 * Sync-accuracy bench — measures whether the display STAYS on the ayah being
 * recited, which is the thing this app actually has to do. Time-to-first-lock is
 * covered by lock-latency-bench.js; this one is about the rest of the rakat.
 *
 * A scripted recitation is replayed through the real pipeline with a perfect
 * stubbed transcriber, and every 250ms the displayed ayah is compared against
 * the ayah genuinely being recited. Perturbations a real imam produces — pace
 * changes, long breaths, a repeated ayah, skipped ayahs, takbeer between
 * positions — are injected so drift and recovery are measured, not assumed.
 *
 * Usage:
 *   node scripts/sync-accuracy-bench.js [--scenario=steady] [--pipeline=<file>]
 *                                       [--source=g2] [--rms=0.003] [--taraweeh]
 *                                       [--latency=350] [--verbose] [--timeline]
 *   node scripts/sync-accuracy-bench.js --list
 */
import {
  SAMPLE_RATE, TICK_MS, buildTimeline, makeVoicedAt, makeTruthAt, makePcm,
  installGroqStub, loadPipeline, silenceConsole,
} from './lib/recitation-harness.js';
import { quotaReport } from './lib/quota.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

// Each scenario is a step script plus the perturbation it is probing.
const SCENARIOS = {
  steady: {
    what: 'even pace, normal breaths — the baseline case',
    steps: [{ recite: [67, 1, 14] }],
  },
  // Reciter-style cases: every imam paces differently, and the pipeline has to
  // learn each one rather than assume a house style.
  'slow-murattal': {
    what: 'slow murattal imam, 0.85 wps with 3s breaths',
    steps: [{ recite: [67, 1, 10], wps: 0.85, pauseMs: 3000 }],
  },
  'very-slow': {
    what: 'very slow, heavily drawn out — 0.7 wps with 5s breaths',
    steps: [{ recite: [67, 1, 8], wps: 0.7, pauseMs: 5000 }],
  },
  'fast-khatam': {
    what: 'khatam-night pace, 2.8 wps with 0.4s breaths',
    steps: [{ recite: [2, 1, 24], wps: 2.8, pauseMs: 400 }],
  },
  'pace-swing': {
    what: 'reciter slows to 1.0 wps then speeds to 2.6 wps',
    steps: [
      { recite: [67, 1, 4], wps: 1.6 },
      { recite: [67, 5, 8], wps: 1.0 },
      { recite: [67, 9, 14], wps: 2.6 },
    ],
  },
  'long-breaths': {
    what: '4s pauses between ayahs, as in slow Taraweeh',
    steps: [{ recite: [67, 1, 10], pauseMs: 4000 }],
  },
  'repeat-ayah': {
    what: 'reciter repeats one ayah three times, then continues',
    steps: [
      { recite: [67, 1, 3] },
      { repeat: [67, 4], times: 3 },
      { recite: [67, 5, 10] },
    ],
  },
  'skip-ahead': {
    what: 'reciter jumps forward past several ayahs',
    steps: [
      { recite: [2, 1, 4] },
      { recite: [2, 20, 27] },
    ],
  },
  'surah-jump': {
    what: 'finishes a short surah and starts a different one',
    steps: [
      { recite: [112, 1, 4] },
      { pause: 2500 },
      { recite: [55, 1, 10] },
    ],
  },
  takbeer: {
    what: 'Fatiha, takbeer, then a surah — Taraweeh position changes',
    steps: [
      { recite: [1, 1, 7] },
      { pause: 1500 },
      { say: 'الله اكبر' },
      { pause: 2000 },
      { recite: [67, 1, 8] },
    ],
  },
};

if (argv.includes('--list')) {
  for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k.padEnd(14)} ${v.what}`);
  process.exit(0);
}

const OPTS = {
  scenario: arg('scenario', 'steady'),
  pipeline: arg('pipeline', 'audioPipelineV4.js'),
  source: arg('source', 'g2'),
  rms: parseFloat(arg('rms', '0.003')),
  noiseRms: parseFloat(arg('noise', '0.0004')),
  latency: parseInt(arg('latency', '350'), 10),
  taraweeh: argv.includes('--taraweeh'),
  practice: argv.includes('--practice'),
  fast: argv.includes('--fast'),
  slow: argv.includes('--slow'),
  verbose: argv.includes('--verbose'),
  timeline: argv.includes('--timeline'),
  quiet: argv.includes('--quiet'),
};
const scenario = SCENARIOS[OPTS.scenario];
if (!scenario) throw new Error(`Unknown scenario "${OPTS.scenario}" (try --list)`);

const SAMPLE_EVERY_MS = 250;
const { timeline, marks, totalMs } = buildTimeline(scenario.steps);
const isVoicedAt = makeVoicedAt(timeline);
const truthAt = makeTruthAt(timeline);
const { calls, setClock } = installGroqStub(timeline, { latencyMs: OPTS.latency, verbose: OPTS.verbose });

const out = OPTS.quiet ? silenceConsole() : (l) => console.log(l);
const AudioPipeline = await loadPipeline(OPTS.pipeline);

let shown = null;
const pipeline = new AudioPipeline({
  preferredSurah: 0,
  audioSource: OPTS.source,
  whisperOpts: { provider: 'groq', apiKey: 'gsk_bench' },
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
if (OPTS.slow) pipeline.setSlowMode(true);
if (OPTS.taraweeh) pipeline.setTaraweehMode(true);
if (OPTS.practice) pipeline.setPracticeMode(true);

const samples = [];
pipeline.start();
const t0 = Date.now();
setClock(t0);

const TICK_SAMPLES = Math.round((TICK_MS * SAMPLE_RATE) / 1000);
const feed = setInterval(() => {
  const elapsed = Date.now() - t0;
  if (elapsed > totalMs) return;
  const voiced = isVoicedAt(elapsed);
  pipeline.ingest(makePcm(voiced ? OPTS.rms : OPTS.noiseRms, TICK_SAMPLES));
}, TICK_MS);

const probe = setInterval(() => {
  const elapsed = Date.now() - t0;
  if (elapsed > totalMs) return;
  const truth = truthAt(elapsed);
  if (!truth) return;
  samples.push({
    atMs: elapsed,
    truth,
    shown: shown ? { ...shown } : null,
  });
}, SAMPLE_EVERY_MS);

setTimeout(() => {
  clearInterval(feed);
  clearInterval(probe);
  pipeline.destroy();
  report();
  process.exit(0);
}, totalMs + 500);

function report() {
  // Ignore the initial acquisition; sync quality is about what happens after.
  const firstLockIdx = samples.findIndex((s) => s.shown);
  const tracked = firstLockIdx < 0 ? [] : samples.slice(firstLockIdx);
  const errs = tracked.map((s) => {
    if (!s.shown) return null;
    if (s.shown.surah !== s.truth.surah) return 'surah';
    return s.shown.ayah - s.truth.ayah;
  });
  const numeric = errs.filter((e) => typeof e === 'number');
  const wrongSurah = errs.filter((e) => e === 'surah').length;
  const exact = numeric.filter((e) => e === 0).length;
  const within1 = numeric.filter((e) => Math.abs(e) <= 1).length;
  const ahead = numeric.filter((e) => e > 0);
  const behind = numeric.filter((e) => e < 0);
  const n = errs.length || 1;
  const pct = (v) => `${((v / n) * 100).toFixed(1)}%`;

  // Longest continuous run where the error breaches a tolerance. A one-ayah
  // offset is acceptable in use, so the tolerance=1 figure describes a real
  // failure; tolerance=0 is reported for reference.
  const longestRunBeyond = (tol) => {
    let worst = { runMs: 0, atMs: 0, err: 0 };
    let runStart = -1;
    for (let i = 0; i <= errs.length; i++) {
      const e = i < errs.length ? errs[i] : 0;
      const bad = i < errs.length && (e === 'surah' || Math.abs(e) > tol);
      if (bad && runStart < 0) runStart = i;
      if (!bad && runStart >= 0) {
        const runMs = (i - runStart) * SAMPLE_EVERY_MS;
        if (runMs > worst.runMs) worst = { runMs, atMs: tracked[runStart].atMs, err: errs[runStart] };
        runStart = -1;
      }
    }
    return worst;
  };
  const worst = longestRunBeyond(0);
  const worstBeyond1 = longestRunBeyond(1);
  const outside1 = errs.filter((e) => e === 'surah' || (typeof e === 'number' && Math.abs(e) > 1)).length;

  out('');
  out('='.repeat(78));
  out(`scenario=${OPTS.scenario} (${scenario.what})`);
  out(`pipeline=${OPTS.pipeline} source=${OPTS.source} taraweeh=${OPTS.taraweeh} len=${(totalMs / 1000).toFixed(0)}s`);
  out('='.repeat(78));
  out(`first lock at       : ${firstLockIdx < 0 ? 'NEVER' : `${(samples[firstLockIdx].atMs / 1000).toFixed(1)}s`}`);
  out(`ASR calls           : ${calls.length} (${(calls.length / (totalMs / 60000)).toFixed(1)} per min)`);
  quotaReport(out, calls, totalMs);
  out(`IN SYNC (exact)     : ${pct(exact)}`);
  out(`within +/-1 ayah    : ${pct(within1)}`);
  out(`display AHEAD       : ${pct(ahead.length)}${ahead.length ? ` (max +${Math.max(...ahead)})` : ''}`);
  out(`display BEHIND      : ${pct(behind.length)}${behind.length ? ` (max ${Math.min(...behind)})` : ''}`);
  out(`wrong surah         : ${pct(wrongSurah)}`);
  out(`OUTSIDE +/-1        : ${pct(outside1)}   <- the failure case`);
  out(`longest beyond +/-1 : ${(worstBeyond1.runMs / 1000).toFixed(1)}s${worstBeyond1.runMs ? ` starting at ${(worstBeyond1.atMs / 1000).toFixed(1)}s` : ''}`);
  out(`longest not-exact   : ${(worst.runMs / 1000).toFixed(1)}s starting at ${(worst.atMs / 1000).toFixed(1)}s (err=${worst.err})`);

  if (OPTS.timeline) {
    out('');
    out('t(s)  truth  shown  err   marks');
    let markIdx = 0;
    for (const s of tracked) {
      while (markIdx < marks.length && marks[markIdx].atMs <= s.atMs) markIdx++;
      const mk = marks[markIdx - 1];
      const shownStr = s.shown ? `${s.shown.surah}:${s.shown.ayah}` : '--';
      const err = s.shown
        ? (s.shown.surah !== s.truth.surah ? 'SURAH' : String(s.shown.ayah - s.truth.ayah))
        : '--';
      if (s.atMs % 1000 < SAMPLE_EVERY_MS) {
        out(`${(s.atMs / 1000).toFixed(0).padStart(4)}  ${`${s.truth.surah}:${s.truth.ayah}`.padEnd(6)} ${shownStr.padEnd(6)} ${err.padStart(5)}  ${mk ? mk.kind + ' ' + mk.detail : ''}`);
      }
    }
  }
}
