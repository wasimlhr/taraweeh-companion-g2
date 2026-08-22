#!/usr/bin/env node
/**
 * Replay a YouTube recitation through AudioPipeline V4.
 *
 *   node scripts/replay-youtube-recitation.js <youtube-url> [--mode taraweeh|practice] [--seconds 180]
 *
 * Uses GROQ_API_KEY or SHARED_GROQ_KEY for STT. Without a key, still downloads
 * audio and scores auto-captions through the matcher (algorithm-only).
 */
import { spawn } from 'child_process';
import { createReadStream, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

function hasFlag(name) {
  return process.argv.includes(name);
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

async function downloadAudio(url, workDir) {
  const template = join(workDir, 'recitation.%(ext)s');
  const yt = existsSync(YT_DLP) ? YT_DLP : 'yt-dlp';
  console.log(`[replay] downloading ${url}`);
  await run(yt, [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'wav',
    '--no-playlist',
    '--write-auto-sub', '--write-sub',
    '--sub-langs', 'ar,ar-en,en',
    '--convert-subs', 'vtt',
    '-o', template,
    url,
  ], { env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });

  const wavSrc = join(workDir, 'recitation.wav');
  const pcmOut = join(workDir, 'recitation.s16le');
  if (!existsSync(wavSrc)) throw new Error('yt-dlp did not produce recitation.wav');
  console.log('[replay] converting to 16 kHz mono s16le');
  await run('ffmpeg', [
    '-y', '-i', wavSrc,
    '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le',
    pcmOut,
  ]);
  return { wavSrc, pcmOut, workDir };
}

function parseVttCues(vttText) {
  const cues = [];
  const blocks = String(vttText).split(/\n\n+/);
  for (const block of blocks) {
    const m = block.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const text = block
      .split('\n')
      .filter((l) => !l.includes('-->') && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ t0: m[1], t1: m[2], text });
  }
  return cues;
}

async function matcherPass(cues) {
  const { loadQuran, findAnchor } = await import('../backend/keywordMatcher.js');
  const { createState, processWhisperResult } = await import('../backend/anchorStateMachine.js');
  loadQuran();
  let state = createState();
  const locks = [];
  let window = '';
  for (const cue of cues) {
    window = `${window} ${cue.text}`.trim();
    if (window.split(/\s+/).length < 3) continue;
    const next = processWhisperResult(window, state, { preferredSurah: 0 });
    const { matches } = findAnchor(window, 0);
    const top = matches[0];
    if (next.mode === 'LOCKED' && (next.surah !== state.surah || next.ayah !== state.ayah || state.mode !== 'LOCKED')) {
      locks.push({
        at: cue.t0,
        verse: `${next.surah}:${next.ayah}`,
        text: window.slice(0, 80),
        score: top?.score,
      });
      console.log(`[captions] LOCK ${next.surah}:${next.ayah} @ ${cue.t0}  "${window.slice(0, 60)}"`);
    }
    state = next;
    if (window.split(/\s+/).length > 24) window = cue.text;
  }
  return locks;
}

async function pipelinePass(pcmPath, { mode, seconds, source }) {
  const { AudioPipeline } = await import('../backend/audioPipelineV4.js');
  const { loadQuran } = await import('../backend/keywordMatcher.js');
  loadQuran();
  const events = [];
  const transcripts = [];
  const pipeline = new AudioPipeline({
    audioSource: source,
    whisperOpts: {
      provider: 'groq',
      groqApiKey: groqKey(),
    },
    onStateUpdate: (msg) => {
      if (!msg) return;
      if (msg.type === 'state' || msg.mode || msg.surah) {
        events.push({ t: Date.now(), ...msg });
      }
      if (msg.mode === 'LOCKED' || msg.type === 'LOCKED') {
        console.log(`[pipeline] LOCK ${msg.surah}:${msg.ayah}  ${msg.arabic || msg.english || ''}`);
      }
    },
    onStatus: (s) => {
      if (s?.component === 'search' || s?.type) return;
    },
    onError: (err) => console.error('[pipeline] error', err),
  });
  if (mode === 'practice') pipeline.setPracticeMode(true);
  else pipeline.setTaraweehMode(true);
  pipeline.start();

  const chunkBytes = 3200; // 100 ms
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
  return { events, transcripts, sentBytes: sent, elapsedSec: elapsed };
}

async function main() {
  const url = process.argv.find((a) => /^https?:\/\//.test(a));
  if (!url) {
    console.error('Usage: node scripts/replay-youtube-recitation.js <youtube-url> [--mode taraweeh|practice] [--seconds 180] [--source simulator|g2|browser]');
    process.exit(1);
  }
  const mode = arg('--mode', 'taraweeh');
  const seconds = parseInt(arg('--seconds', '180'), 10);
  const source = arg('--source', 'simulator');
  const workDir = join(tmpdir(), `taraweeh-yt-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  const { pcmOut, workDir: dir } = await downloadAudio(url, workDir);

  const vttFiles = [];
  try {
    const { readdirSync } = await import('fs');
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.vtt')) vttFiles.push(join(dir, f));
    }
  } catch (_) {}

  const report = { url, mode, seconds, source, captionLocks: [], pipeline: null, workDir: dir };
  if (vttFiles.length) {
    console.log(`[replay] caption file ${vttFiles[0]}`);
    const cues = parseVttCues(readFileSync(vttFiles[0], 'utf8'));
    report.captionLocks = await matcherPass(cues);
    console.log(`[replay] caption matcher locks: ${report.captionLocks.length}`);
  } else {
    console.log('[replay] no captions on this video — matcher-only pass skipped');
  }

  if (!groqKey()) {
    console.log('[replay] No GROQ_API_KEY / SHARED_GROQ_KEY — skip live STT pipeline pass');
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`[replay] report ${join(dir, 'report.json')}`);
    return;
  }

  console.log(`[replay] pipeline ${mode} ${seconds}s source=${source}`);
  report.pipeline = await pipelinePass(pcmOut, { mode, seconds, source });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[replay] report ${join(dir, 'report.json')}`);
}

main().catch((err) => {
  console.error('[replay] failed:', err.message);
  process.exit(1);
});
