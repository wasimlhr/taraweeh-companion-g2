/**
 * Word-clock / timer invariant bench — replays scripted recitations through the
 * REAL V4 pipeline (perfect stubbed transcriber, synthetic PCM) and asserts the
 * user-visible invariants that broke in the field:
 *
 *   1. fresh-start   — when the displayed ayah changes, its first word index
 *                      starts at the beginning (<=1), never mid-ayah
 *                      (first-ever lock may legitimately snap mid-word)
 *   2. monotonic     — word index never moves backward within an ayah
 *   3. total-words   — wordProgress.totalWords matches the real ayah length
 *   4. no-relock     — after a surah completes, its last ayah is not re-locked
 *                      (the "last ayah timer reset twice" case)
 *   5. timer-sanity  — per displayed ayah, timerMs jumps upward at most twice
 *
 * Usage: node scripts/wordclock-invariant-bench.js [--scenario=ikhlas] [--verbose]
 */
import {
  SAMPLE_RATE, TICK_MS, buildTimeline, makeVoicedAt, makePcm,
  installGroqStub, loadPipeline, silenceConsole,
} from './lib/recitation-harness.js';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..', 'backend');
const { getAyah } = await import(pathToFileURL(join(backendDir, 'keywordMatcher.js')).href);

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const VERBOSE = argv.includes('--verbose');

const SCENARIOS = {
  ikhlas: {
    what: "the user's field test: Qul Ahad start to finish, then silence",
    steps: [{ recite: [112, 1, 4] }, { pause: 4000 }],
  },
  mulk: {
    what: 'five sequential ayah transitions',
    steps: [{ recite: [67, 1, 5] }],
  },
  repeat: {
    what: 'repeat one ayah (exercises the back-correct display path)',
    steps: [{ recite: [67, 1, 3] }, { repeat: [67, 4], times: 3 }, { recite: [67, 5, 6] }],
  },
  skip: {
    what: 'jump ahead (exercises smooth catch-up stepping and forward-jump snap)',
    steps: [{ recite: [2, 1, 3] }, { recite: [2, 20, 23] }],
  },
  tail: {
    what: 'final-ayah words arrive again right after the surah completes (tail echo)',
    steps: [
      { recite: [112, 1, 4], wps: 1.8, pauseMs: 600 },
      // The echo: the surah's closing words hit the transcriber once more
      // after the display has completed the surah.
      { repeat: [112, 4], times: 2, wps: 1.8, pauseMs: 900 },
      { pause: 6000 },
    ],
  },
};

async function runScenario(name) {
  const scenario = SCENARIOS[name];
  const { timeline, totalMs } = buildTimeline(scenario.steps);
  const isVoicedAt = makeVoicedAt(timeline);
  const { setClock } = installGroqStub(timeline, { latencyMs: 350 });

  const AudioPipeline = await loadPipeline('audioPipelineV4.js');

  // Everything the pipeline emits, timestamped.
  const events = [];
  const pipeline = new AudioPipeline({
    preferredSurah: 0,
    audioSource: 'g2',
    whisperOpts: { provider: 'groq', apiKey: 'gsk_bench' },
    onStateUpdate: (msg) => events.push({ atMs: Date.now() - t0, msg }),
    onStatus: () => {},
    onError: () => {},
  });

  pipeline.start();
  const t0 = Date.now();
  setClock(t0);

  const TICK_SAMPLES = Math.round((TICK_MS * SAMPLE_RATE) / 1000);
  await new Promise((resolve) => {
    const feed = setInterval(() => {
      const elapsed = Date.now() - t0;
      if (elapsed > totalMs) return;
      pipeline.ingest(makePcm(isVoicedAt(elapsed) ? 0.003 : 0.0004, TICK_SAMPLES));
    }, TICK_MS);
    setTimeout(() => { clearInterval(feed); pipeline.destroy(); resolve(); }, totalMs + 800);
  });

  // ── Assertions ────────────────────────────────────────────────────────────
  const failures = [];
  const warnings = [];

  // Build the word-position stream: wordProgress messages plus LOCKED states.
  const wordStream = [];
  for (const { atMs, msg } of events) {
    if (msg.type === 'wordProgress' && msg.totalWords > 0) {
      wordStream.push({ atMs, surah: msg.surah, ayah: msg.ayah, wi: msg.wordIndex, tw: msg.totalWords, src: 'wp' });
    } else if (msg.type === 'state' && msg.state?.mode === 'LOCKED' && typeof msg.state.wordIndex === 'number') {
      wordStream.push({ atMs, surah: msg.state.surah, ayah: msg.state.ayah, wi: msg.state.wordIndex, tw: msg.state.totalWords, src: 'st' });
    }
  }

  // 1 + 2 + 3: fresh start on ayah change, monotonic within, correct totals.
  let cur = null;
  let firstLockSeen = false;
  for (const w of wordStream) {
    const key = `${w.surah}:${w.ayah}`;
    if (!cur || cur.key !== key) {
      if (firstLockSeen && w.wi > 1) {
        failures.push(`fresh-start: ${key} first word index is ${w.wi} (src=${w.src}, t=${(w.atMs / 1000).toFixed(1)}s) — appeared mid-word`);
      }
      firstLockSeen = true;
      cur = { key, lastWi: w.wi };
    } else if (w.wi < cur.lastWi) {
      failures.push(`monotonic: ${key} word index went ${cur.lastWi} -> ${w.wi} (src=${w.src}, t=${(w.atMs / 1000).toFixed(1)}s)`);
      cur.lastWi = w.wi;
    } else {
      cur.lastWi = w.wi;
    }
    const a = getAyah(w.surah, w.ayah);
    const real = a ? (a.canonicalWordCount || a.words?.length || -1) : -1;
    const display = a ? a.text.split(/\s+/).filter(Boolean).length : -1;
    if (w.tw !== real) {
      failures.push(`total-words: ${key} reports ${w.tw}, canonical says ${real} (t=${(w.atMs / 1000).toFixed(1)}s)`);
    }
    if (real !== display) {
      failures.push(`total-words: ${key} canonical ${real} != display tokenization ${display}`);
    }
  }

  // 4: after completedSurah=S, its last ayah must not re-lock.
  const completions = events.filter(({ msg }) => msg.type === 'state' && msg.state?.completedSurah);
  for (const { atMs, msg } of completions) {
    const s = msg.state.completedSurah;
    const relock = events.find(({ atMs: a2, msg: m2 }) => a2 > atMs
      && m2.type === 'state' && m2.state?.mode === 'LOCKED' && m2.state.surah === s);
    if (relock) {
      failures.push(`no-relock: surah ${s} completed at ${(atMs / 1000).toFixed(1)}s but re-locked ${relock.msg.state.surah}:${relock.msg.state.ayah} at ${(relock.atMs / 1000).toFixed(1)}s`);
    }
  }

  // 5: timerMs should not jump upward more than twice per displayed ayah.
  const timerByAyah = new Map();
  let prevTimer = null;
  for (const { atMs, msg } of events) {
    if (msg.type !== 'state' || msg.state?.mode !== 'LOCKED' || !msg.state.timerMs) continue;
    const key = `${msg.state.surah}:${msg.state.ayah}`;
    if (!prevTimer || prevTimer.key !== key) {
      prevTimer = { key, last: msg.state.timerMs };
      timerByAyah.set(key, (timerByAyah.get(key) ?? 0));
      continue;
    }
    if (msg.state.timerMs > prevTimer.last + 1500) {
      timerByAyah.set(key, (timerByAyah.get(key) ?? 0) + 1);
      if (VERBOSE) console.log(`  [timer] ${key} +${msg.state.timerMs - prevTimer.last}ms at ${(atMs / 1000).toFixed(1)}s`);
    }
    prevTimer.last = msg.state.timerMs;
  }
  for (const [key, jumps] of timerByAyah) {
    if (jumps > 2) failures.push(`timer-sanity: ${key} timer jumped upward ${jumps} times`);
    else if (jumps === 2) warnings.push(`timer-sanity: ${key} timer jumped upward twice (allowed, watch)`);
  }

  const locks = wordStream.length;
  return { name, what: scenario.what, totalMs, events: events.length, locks, failures, warnings };
}

const names = arg('scenario', '') ? [arg('scenario', '')] : Object.keys(SCENARIOS);
let anyFail = false;
for (const name of names) {
  process.stdout.write(`\n=== ${name} — ${SCENARIOS[name].what} ===\n`);
  const restore = VERBOSE ? null : silenceConsole();
  const r = await runScenario(name);
  if (restore) restore('');
  const say = (l) => process.stdout.write(l + '\n');
  say(`  ${(r.totalMs / 1000).toFixed(0)}s run, ${r.events} messages, ${r.locks} word-position samples`);
  for (const w of r.warnings) say('  WARN ' + w);
  if (r.failures.length) {
    anyFail = true;
    for (const f of r.failures) say('  FAIL ' + f);
  } else {
    say('  PASS all invariants (fresh-start, monotonic, total-words, no-relock, timer-sanity)');
  }
}
process.exit(anyFail ? 1 : 0);
