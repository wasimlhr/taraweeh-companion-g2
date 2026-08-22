/**
 * Head-to-head ASR comparison on the metric this app actually cares about.
 *
 * Word error rate is not the question. The question is whether the keyword
 * matcher lands on the ayah the reciter is on, so this sends identical 6-second
 * windows of real recitation to each provider and scores the resulting text
 * through the app's own matcher against the ayahs genuinely sounding in that
 * window.
 *
 *   node scripts/compare-asr-providers.js \
 *     --dirs=/tmp/recitations/a,/tmp/recitations/b \
 *     --groq-key=/tmp/.groq_key --openai-key=/tmp/.oai_key [--window=6] [--step=12]
 *
 * Keys are read from files so they never appear in a command line or a log.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OPTS = {
  dirs: (arg('dirs', '') || '').split(',').filter(Boolean),
  groqKey: arg('groq-key', ''),
  openaiKey: arg('openai-key', ''),
  windowSec: parseFloat(arg('window', '6')),
  stepSec: parseFloat(arg('step', '12')),
  // Groq free tier is 20 RPM. Firing windows back to back trips it and looks
  // like an accuracy problem, so pace the loop by default.
  paceMs: parseInt(arg('pace-ms', '4000'), 10),
  verbose: argv.includes('--verbose'),
};
if (!OPTS.dirs.length) throw new Error('--dirs is required');

const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

const origLog = console.log;
console.log = () => {};
const { loadQuran, findAnchor } = await import(join(import.meta.dirname, '..', 'backend', 'keywordMatcher.js'));
loadQuran();
console.log = origLog;

function wavOf(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const PROVIDERS = {
  groq: {
    label: 'Groq whisper-large-v3-turbo',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    key: OPTS.groqKey ? readFileSync(OPTS.groqKey, 'utf8').trim() : '',
  },
  openai: {
    label: 'OpenAI whisper-1',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    key: OPTS.openaiKey ? readFileSync(OPTS.openaiKey, 'utf8').trim() : '',
  },
};
const active = Object.entries(PROVIDERS).filter(([, p]) => p.key);
if (!active.length) throw new Error('need at least one key');

async function transcribe(p, wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
  form.append('model', p.model);
  form.append('language', 'ar');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('temperature', '0');
  const t0 = Date.now();
  const res = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${p.key}` }, body: form });
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, text: '', words: 0, status: res.status };
  const d = await res.json();
  return { ms, text: (d.text || '').trim(), words: (d.words || []).length, status: 200 };
}

const results = {};
for (const [name] of active) results[name] = { hits: 0, total: 0, lat: [], scores: [], empty: 0, errors: 0 };

for (const dir of OPTS.dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const pcm = readFileSync(join(dir, 'audio.wav')).subarray(44);
  const bounds = [];
  let acc = 0;
  for (const a of manifest.ayahs) { bounds.push({ ayah: a.ayah, from: acc, to: acc + a.durationMs }); acc += a.durationMs; }
  const totalMs = Math.floor(pcm.length / BYTES_PER_MS);

  console.log(`\n${manifest.reciter} surah ${manifest.surah} — ${(totalMs / 1000).toFixed(0)}s`);
  for (let endMs = OPTS.windowSec * 1000; endMs <= totalMs; endMs += OPTS.stepSec * 1000) {
    const fromMs = endMs - OPTS.windowSec * 1000;
    // Every ayah with any audio inside the window is a correct answer.
    const expect = new Set(bounds.filter((b) => b.to > fromMs && b.from < endMs).map((b) => b.ayah));
    const slice = pcm.subarray(Math.floor(fromMs * BYTES_PER_MS), Math.floor(endMs * BYTES_PER_MS));
    const wav = wavOf(slice);

    const line = [`  ${(endMs / 1000).toFixed(0).padStart(4)}s expect ${[...expect].join('/')}`];
    for (const [name, p] of active) {
      const r = results[name];
      const t = await transcribe(p, wav);
      r.total++; r.lat.push(t.ms);
      if (t.status !== 200) { r.errors++; line.push(`${name}=HTTP${t.status}`); continue; }
      if (!t.text) { r.empty++; line.push(`${name}=<empty>`); continue; }
      const top = findAnchor(t.text, 0).matches[0];
      const hit = top && top.surah === manifest.surah && expect.has(top.ayah);
      if (hit) { r.hits++; r.scores.push(top.score); }
      line.push(`${name}=${top ? `${top.surah}:${top.ayah}` : 'nomatch'}${hit ? ' OK' : ' MISS'}`);
      if (OPTS.verbose) line.push(`\n        ${name}: "${t.text.slice(0, 74)}"`);
    }
    console.log(line.join('  '));
    if (OPTS.paceMs > 0) await new Promise((r) => setTimeout(r, OPTS.paceMs));
  }
}

const pad = (s, n) => String(s).padEnd(n);
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
console.log('\n' + '='.repeat(78));
console.log('IDENTICAL WINDOWS THROUGH BOTH PROVIDERS');
console.log('scored on whether the app matcher lands on an ayah actually in the window');
console.log('='.repeat(78));
console.log(pad('provider', 30) + pad('windows', 9) + pad('matched', 9) + pad('hit rate', 10) + pad('med score', 11) + 'med latency');
console.log('-'.repeat(78));
for (const [name, p] of active) {
  const r = results[name];
  console.log(pad(p.label, 30) + pad(r.total, 9) + pad(r.hits, 9)
    + pad(`${((r.hits / r.total) * 100).toFixed(0)}%`, 10)
    + pad(r.scores.length ? med(r.scores).toFixed(2) : '-', 11)
    + `${med(r.lat)}ms`);
}
for (const [name, p] of active) {
  const r = results[name];
  if (r.empty || r.errors) console.log(`  ${p.label}: ${r.empty} empty, ${r.errors} errors`);
}
