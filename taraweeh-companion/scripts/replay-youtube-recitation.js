#!/usr/bin/env node
/**
 * Live-replay a recitation WAV/PCM (optionally downloaded from YouTube)
 * through AudioPipeline V4 in realtime — the same SEARCHING → LOCKED sync loop
 * the glasses/sim use. Not a caption dump. YouTube auto-captions are not Quranic
 * Arabic and are never sent to the matcher.
 *
 *   node scripts/replay-youtube-recitation.js <youtube-url-or-wav> [--mode taraweeh|practice]
 *       [--seconds 180] [--start 85] [--source simulator|g2|browser]
 *
 * `t=85s` on a YouTube URL is honoured as --start. Needs GROQ_API_KEY or
 * SHARED_GROQ_KEY. Play the same audio into the EvenHub sim mic for a full UI test.
 */
import { spawn } from 'child_process';
import { createReadStream, mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const YT_DLP = process.env.YT_DLP || join(process.env.HOME || '', '.local/bin/yt-dlp');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}\n${err.slice(-800)}`));
    });
  });
}

function groqKey() {
  return (process.env.GROQ_API_KEY || process.env.SHARED_GROQ_KEY || '').trim();
}

function parseStartSeconds(url, cli) {
  if (cli != null && cli !== '') {
    const n = parseTimeToken(String(cli));
    if (n != null) return n;
  }
  if (!url) return 0;
  try {
    const u = new URL(url);
    const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
    const fromQuery = parseTimeToken(t);
    if (fromQuery != null) return fromQuery;
    const hash = String(u.hash || '').match(/t=([^&]+)/);
    if (hash) return parseTimeToken(hash[1]) || 0;
  } catch (_) {}
  const m = String(url).match(/[?&#]t=(\d+h)?(\d+m)?(\d+s)?/i);
  if (m) return parseTimeToken(m[0].slice(m[0].indexOf('=') + 1)) || 0;
  return 0;
}

function parseTimeToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    return (parseInt(m[1] || '0', 10) * 3600)
      + (parseInt(m[2] || '0', 10) * 60)
      + parseInt(m[3] || '0', 10);
  }
  return null;
}

async function downloadAudio(url, workDir) {
  const template = join(workDir, 'recitation.%(ext)s');
  const yt = existsSync(YT_DLP) ? YT_DLP : 'yt-dlp';
  console.log(`[replay] downloading audio (not captions) ${url}`);
  await run(yt, [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'wav',
    '--no-playlist',
    '-o', template,
    url,
  ], { env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });

  const wavSrc = join(workDir, 'recitation.wav');
  if (!existsSync(wavSrc)) throw new Error('yt-dlp did not produce recitation.wav');
  return wavSrc;
}

async function toPcm(wavSrc, pcmOut, startSec) {
  console.log(`[replay] 16 kHz mono s16le start=${startSec}s`);
  const args = ['-y'];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-i', wavSrc, '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', pcmOut);
  await run('ffmpeg', args);
  return pcmOut;
}

async function livePipelinePass(pcmPath, { mode, seconds, source }) {
  const { AudioPipeline } = await import('../backend/audioPipelineV4.js');
  const { loadQuran } = await import('../backend/keywordMatcher.js');
  loadQuran();
  const events = [];
  let lastLock = null;
  const pipeline = new AudioPipeline({
    audioSource: source,
    whisperOpts: {
      provider: 'groq',
      groqApiKey: groqKey(),
    },
    onStateUpdate: (msg) => {
      if (!msg) return;
      events.push({ t: Date.now(), mode: msg.mode, surah: msg.surah, ayah: msg.ayah, type: msg.type });
      const key = `${msg.mode || ''}:${msg.surah}:${msg.ayah}`;
      if (msg.mode === 'LOCKED' && key !== lastLock) {
        lastLock = key;
        console.log(`[live] LOCK ${msg.surah}:${msg.ayah}  ${msg.arabic || msg.english || ''}`);
      } else if (msg.mode && msg.mode !== 'LOCKED') {
        console.log(`[live] ${msg.mode} ${msg.surah || 0}:${msg.ayah || 0}`);
      }
    },
    onStatus: () => {},
    onError: (err) => console.error('[live] error', err),
  });
  if (mode === 'practice') pipeline.setPracticeMode(true);
  else pipeline.setTaraweehMode(true);
  pipeline.start();

  const chunkBytes = 3200; // 100 ms @ 16 kHz s16le — same cadence as sim/G2 frames
  const limitBytes = Math.floor(16000 * 2 * seconds);
  let sent = 0;
  const stream = createReadStream(pcmPath, { highWaterMark: chunkBytes });
  const t0 = Date.now();
  for await (const chunk of stream) {
    if (sent >= limitBytes) break;
    const slice = sent + chunk.length > limitBytes ? chunk.subarray(0, limitBytes - sent) : chunk;
    pipeline.ingest(slice);
    sent += slice.length;
    await sleep(100);
  }
  await sleep(4000);
  pipeline.stop();
  pipeline.destroy();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const locks = events.filter((e, i, a) => e.mode === 'LOCKED' && (i === 0 || a[i - 1].surah !== e.surah || a[i - 1].ayah !== e.ayah || a[i - 1].mode !== 'LOCKED'));
  return { events, locks, sentBytes: sent, elapsedSec: elapsed };
}

async function main() {
  const target = process.argv.find((a) => /^https?:\/\//.test(a) || /\.(wav|pcm|s16le)$/i.test(a));
  if (!target) {
    console.error('Usage: node scripts/replay-youtube-recitation.js <youtube-url|wav> [--mode taraweeh|practice] [--seconds 180] [--start 85] [--source simulator|g2|browser]');
    process.exit(1);
  }
  const mode = arg('--mode', 'taraweeh');
  const seconds = parseInt(arg('--seconds', '180'), 10);
  const source = arg('--source', 'simulator');
  const startSec = parseStartSeconds(target, arg('--start', ''));
  const workDir = join(tmpdir(), `taraweeh-yt-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  if (!groqKey()) {
    console.error('[replay] GROQ_API_KEY / SHARED_GROQ_KEY required. This is a live STT lock loop — YouTube captions are not used.');
    process.exit(2);
  }

  let wavSrc = target;
  if (/^https?:\/\//.test(target)) {
    wavSrc = await downloadAudio(target, workDir);
  }
  const pcmOut = await toPcm(wavSrc, join(workDir, 'recitation.s16le'), startSec);

  console.log(`[replay] live ${mode} ${seconds}s source=${source} start=${startSec}s`);
  const pipeline = await livePipelinePass(pcmOut, { mode, seconds, source });
  const report = { target, mode, seconds, source, startSec, pipeline, workDir };
  writeFileSync(join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[replay] locks=${(pipeline.locks || []).map((l) => l.surah + ':' + l.ayah).join(' → ') || '(none)'}`);
  console.log(`[replay] report ${join(workDir, 'report.json')}`);
}

main().catch((err) => {
  console.error('[replay] failed:', err.message);
  process.exit(1);
});
