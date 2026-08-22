/**
 * Rate-limit behaviour check.
 *
 * Groq's free tier allows 7200 audio seconds per hour and bills a 10s minimum
 * per request, so a long session can run into 429s. This asserts the pipeline
 * responds the way it should when that happens:
 *
 *   1. it backs off instead of hammering the endpoint,
 *   2. it honours the Retry-After the server sends,
 *   3. it surfaces the rate limit to the client,
 *   4. it resumes on its own once the window passes, without a restart.
 *
 * Usage: node scripts/check-rate-limit-handling.js
 */
import { join } from 'path';
import { readFileSync } from 'fs';

const backendDir = join(import.meta.dirname, '..', 'backend');
const SAMPLE_RATE = 16000;
const TICK_MS = 85;

const corpus = JSON.parse(readFileSync(join(backendDir, 'data', 'quran-full.json'), 'utf8'));
const versesOf = (s) => corpus[String(s)] || [];

// 429 for a stretch in the middle, then recover.
const LIMIT_FROM_MS = 12000;
const LIMIT_TO_MS = 24000;
const RETRY_AFTER_SEC = 8;

let clockStart = 0;
const attempts = [];
let served = 0;

globalThis.fetch = async (url) => {
  if (!String(url).includes('api.groq.com')) throw new Error(`Unexpected fetch: ${url}`);
  const at = Date.now() - clockStart;
  const limited = at >= LIMIT_FROM_MS && at < LIMIT_TO_MS;
  attempts.push({ atMs: at, limited });
  await new Promise((r) => setTimeout(r, 200));
  if (limited) {
    return new Response('{"error":{"message":"Rate limit reached for whisper-large-v3-turbo. Please try again in 8s."}}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(RETRY_AFTER_SEC) },
    });
  }
  served++;
  const v = versesOf(67)[Math.min(served - 1, 4)];
  const words = v.text.split(/\s+/).filter(Boolean)
    .map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
  return new Response(JSON.stringify({ text: v.text, words }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

function pcm(rms, n) {
  const b = Buffer.alloc(n * 2);
  const amp = rms * 32768 * Math.sqrt(3);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2);
  return b;
}

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {}; console.warn = () => {};
const { loadQuran } = await import(join(backendDir, 'keywordMatcher.js'));
loadQuran();
const { AudioPipeline } = await import(join(backendDir, 'audioPipelineV4.js'));

const statuses = [];
let lastVerse = null;
const pipeline = new AudioPipeline({
  preferredSurah: 0,
  audioSource: 'browser',
  whisperOpts: { provider: 'groq', apiKey: 'gsk_ratelimit_check' },
  onStateUpdate: (m) => {
    if (m.type === 'state' && m.state?.mode === 'LOCKED') lastVerse = `${m.state.surah}:${m.state.ayah}`;
  },
  onStatus: (s) => {
    if (s?.httpStatus === 429 || /rate limit/i.test(s?.message || '')) {
      statuses.push({ atMs: Date.now() - clockStart, message: s.message, retryAfterMs: s.retryAfterMs });
    }
  },
  onError: () => {},
});
pipeline.start();
clockStart = Date.now();

const TICK_SAMPLES = Math.round((TICK_MS * SAMPLE_RATE) / 1000);
const feed = setInterval(() => pipeline.ingest(pcm(0.02, TICK_SAMPLES)), TICK_MS);
await new Promise((r) => setTimeout(r, 42000));
clearInterval(feed);
pipeline.destroy();
console.log = origLog; console.warn = origWarn;

// ── assertions ───────────────────────────────────────────────────────────────

const during = attempts.filter((a) => a.limited);
const after = attempts.filter((a) => a.atMs >= LIMIT_TO_MS);
const gapsDuring = during.slice(1).map((a, i) => a.atMs - during[i].atMs);
const tightRetries = gapsDuring.filter((g) => g < RETRY_AFTER_SEC * 1000 * 0.5).length;

const checks = [
  ['surfaced the rate limit to the client', statuses.length > 0],
  ['honoured Retry-After (no retry inside half the window)', tightRetries === 0],
  [`backed off (<=2 attempts during a ${(LIMIT_TO_MS - LIMIT_FROM_MS) / 1000}s block)`, during.length <= 2],
  ['resumed transcribing after the block lifted', after.length > 0],
  ['still tracking a verse at the end', !!lastVerse],
];

const pad = (s, n) => String(s).padEnd(n);
console.log('\nSimulated Groq 429 from 12s to 24s, Retry-After: 8s\n');
console.log(`attempts total      : ${attempts.length} (${during.length} hit the 429 window, ${after.length} after it lifted)`);
console.log(`attempt times (s)   : ${attempts.map((a) => (a.atMs / 1000).toFixed(1) + (a.limited ? '*' : '')).join(', ')}`);
console.log(`retry gaps in block : ${gapsDuring.length ? gapsDuring.map((g) => Math.round(g) + 'ms').join(', ') : '(only one attempt)'}`);
console.log(`client saw          : ${statuses.length ? statuses.map((s) => `"${s.message}" retryAfter=${s.retryAfterMs}ms`).join(' | ') : 'nothing'}`);
console.log(`verse at end        : ${lastVerse || 'none'}\n`);
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${pad(name, 58)}`);
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${checks.length - failed}/${checks.length} rate-limit behaviours correct\n`);
process.exit(failed === 0 ? 0 : 1);
