/**
 * Shared harness for the offline pipeline benches.
 *
 * Builds a scripted recitation with a known word-by-word clock, feeds it to the
 * real pipeline as synthetic PCM, and stubs the Groq HTTP call with a *perfect*
 * transcriber: it reads the WAV the pipeline chose to send, derives the audio
 * window from its byte length, and answers with exactly the words spoken in that
 * window. ASR is therefore never the variable — everything measured is pipeline
 * gating, buffering, pacing and correction logic.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const backendDir = join(__dirname, '..', '..', 'backend');

export const SAMPLE_RATE = 16000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
export const TICK_MS = 85;          // matches the browser 4096-frame ScriptProcessor

let quranCache = null;
function quran() {
  if (!quranCache) {
    quranCache = JSON.parse(readFileSync(join(backendDir, 'data', 'quran-full.json'), 'utf8'));
  }
  return quranCache;
}

export function versesOf(surah, fromAyah, toAyah) {
  const list = quran()[String(surah)] || [];
  const picked = list.filter((v) => v.verse >= fromAyah && v.verse <= toAyah);
  if (!picked.length) throw new Error(`No verses for ${surah}:${fromAyah}-${toAyah}`);
  return picked;
}

/**
 * Turn a step script into a word timeline.
 *
 * Steps:
 *   { recite: [surah, from, to], wps?, pauseMs? }  sequential ayahs
 *   { repeat: [surah, ayah], times?, wps? }        reciter repeats one ayah
 *   { pause: ms }                                  silence (breath, or a wait)
 *   { say: 'text', ms? }                           arbitrary speech, e.g. takbeer
 *
 * `pauseMs` is the breath inserted after each ayah of a recite/repeat step.
 */
export function buildTimeline(steps, defaults = {}) {
  const baseWps = defaults.wps ?? 1.6;
  const basePause = defaults.pauseMs ?? 1200;
  const timeline = [];
  const marks = [];
  let t = 0;

  const pushWords = (text, surah, ayah, wps) => {
    const msPerWord = 1000 / wps;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      timeline.push({ word, startMs: t, endMs: t + msPerWord * 0.85, surah, ayah });
      t += msPerWord;
    }
  };

  for (const step of steps) {
    if (step.pause != null) {
      marks.push({ atMs: t, kind: 'pause', detail: `${step.pause}ms` });
      t += step.pause;
      continue;
    }
    if (step.say != null) {
      marks.push({ atMs: t, kind: 'say', detail: step.say });
      // surah 0 marks non-Quran speech: ground truth is "whatever was last recited".
      pushWords(step.say, 0, 0, step.wps ?? baseWps);
      t += step.pauseMs ?? basePause;
      continue;
    }
    const wps = step.wps ?? baseWps;
    const pauseMs = step.pauseMs ?? basePause;
    if (step.repeat) {
      const [surah, ayah] = step.repeat;
      const [v] = versesOf(surah, ayah, ayah);
      marks.push({ atMs: t, kind: 'repeat', detail: `${surah}:${ayah} x${step.times ?? 2}` });
      for (let i = 0; i < (step.times ?? 2); i++) {
        pushWords(v.text, surah, ayah, wps);
        t += pauseMs;
      }
      continue;
    }
    const [surah, from, to] = step.recite;
    marks.push({ atMs: t, kind: 'recite', detail: `${surah}:${from}-${to} @${wps}wps` });
    for (const v of versesOf(surah, from, to)) {
      pushWords(v.text, surah, v.verse, wps);
      t += pauseMs;
    }
  }
  return { timeline, marks, totalMs: t };
}

export function makeVoicedAt(timeline) {
  let cursor = 0;
  return function isVoicedAt(ms) {
    // Timeline is ordered; keep a rolling cursor so long runs stay cheap.
    if (ms < (timeline[cursor]?.startMs ?? 0)) cursor = 0;
    for (let i = cursor; i < timeline.length; i++) {
      const w = timeline[i];
      if (w.startMs > ms) { cursor = Math.max(0, i - 1); return false; }
      if (ms < w.endMs) { cursor = i; return true; }
    }
    return false;
  };
}

/** The ayah actually being recited at time `ms` (holds through pauses). */
export function makeTruthAt(timeline) {
  return function truthAt(ms) {
    let last = null;
    for (const w of timeline) {
      if (w.startMs > ms) break;
      if (w.surah > 0) last = w;
    }
    return last ? { surah: last.surah, ayah: last.ayah } : null;
  };
}

export function makePcm(targetRms, samples) {
  const buf = Buffer.alloc(samples * 2);
  // Uniform noise has rms = amplitude / sqrt(3); solve for the target rms.
  const amp = Math.min(32000, targetRms * 32768 * Math.sqrt(3));
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2);
  }
  return buf;
}

/**
 * Replace global fetch with a perfect Groq. Returns the call log, plus a
 * `setClock` the caller uses to declare t=0 once audio starts flowing.
 */
export function installGroqStub(timeline, { latencyMs = 350, verbose = false } = {}) {
  const calls = [];
  let clockStart = 0;
  const wordsInWindow = (fromMs, toMs) => timeline.filter((w) => {
    const mid = (w.startMs + w.endMs) / 2;
    return mid >= fromMs && mid <= toMs;
  });

  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.groq.com')) throw new Error(`Unexpected fetch: ${url}`);
    const file = init?.body?.get?.('file');
    const wavBytes = file?.size ?? 44;
    const windowMs = Math.max(0, (wavBytes - 44) / BYTES_PER_MS);
    const nowMs = Date.now() - clockStart;
    const from = nowMs - windowMs;
    const heard = wordsInWindow(from, nowMs);
    calls.push({ atMs: nowMs, windowMs: Math.round(windowMs), words: heard.length });
    if (verbose) {
      console.log(`  [ASR] t=${(nowMs / 1000).toFixed(1)}s window=${Math.round(windowMs)}ms words=${heard.length}`);
    }
    await new Promise((r) => setTimeout(r, latencyMs));
    return new Response(JSON.stringify({
      text: heard.map((w) => w.word).join(' '),
      words: heard.map((w) => ({ word: w.word, start: (w.startMs - from) / 1000, end: (w.endMs - from) / 1000 })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return { calls, setClock: (t) => { clockStart = t; } };
}

export async function loadPipeline(file) {
  const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
  loadQuran();
  const { AudioPipeline } = await import(join(backendDir, file));
  return AudioPipeline;
}

export function silenceConsole() {
  const write = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return (line) => write(line + '\n');
}
