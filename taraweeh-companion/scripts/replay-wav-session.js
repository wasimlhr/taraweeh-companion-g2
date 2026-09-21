#!/usr/bin/env node
/**
 * Stream a real recording through the running backend in realtime and print
 * what the pipeline made of it.
 *
 * Unlike replay-prayer-session.js, nothing here is synthetic: real mosque
 * audio goes over the WebSocket as PCM, the pipeline's own voice gate and
 * search windows decide what to transcribe, and a real ASR answers. Point
 * GROQ_TRANSCRIBE_URL at scripts/local-whisper-server.py to run it without an
 * API key.
 *
 *   python scripts/local-whisper-server.py --model small --port 8123 &
 *   GROQ_TRANSCRIBE_URL=http://127.0.0.1:8123/v1/audio/transcriptions \
 *     node backend/server.js &
 *   node scripts/replay-wav-session.js recording.wav
 *
 * The WAV must be 16 kHz mono signed 16-bit — what the glasses send.
 *
 *   --url ws://host:port/ws   backend to drive (default ws://127.0.0.1:3001/ws)
 *   --speed 2                 faster than realtime (the posture machine is
 *                             wall-clock based, so anything but 1 distorts it)
 *   --json                    full trace as JSON instead of a table
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { setTimeout as sleep } from 'timers/promises';

const { WebSocket } = createRequire(new URL('../backend/package.json', import.meta.url))('ws');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const WAV = args.find((a) => !a.startsWith('--') && /\.(wav|pcm)$/i.test(a));
const WS_URL = argOf('url', 'ws://127.0.0.1:3001/ws');
const SPEED = Math.max(0.25, parseFloat(argOf('speed', '1')) || 1);
const JSON_OUT = args.includes('--json');

if (!WAV) {
  console.error('usage: replay-wav-session.js <16kHz-mono-s16le.wav> [--url …] [--speed 1] [--json]');
  process.exit(2);
}

const SR = 16000;
const FRAME_MS = 200;
const FRAME_BYTES = (SR * 2 * FRAME_MS) / 1000;

/** Strip the RIFF header and sanity-check the format the pipeline assumes. */
function readPcm(path) {
  const buf = readFileSync(path);
  if (buf.slice(0, 4).toString() !== 'RIFF') return buf;          // already raw PCM
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString();
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    } else if (id === 'data') {
      if (fmt && (fmt.channels !== 1 || fmt.rate !== SR || fmt.bits !== 16)) {
        console.error(`[wav] expected 16kHz mono 16-bit, got ${fmt.rate}Hz ${fmt.channels}ch ${fmt.bits}-bit`);
        console.error(`[wav] convert with: ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le out.wav`);
        process.exit(2);
      }
      return buf.slice(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in WAV');
}

const pcm = readPcm(WAV);
const durationMs = (pcm.length / 2 / SR) * 1000;

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const transitions = [];
  let report = null;
  let startedAt = Date.now();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type === 'taraweeh' && msg.prayer) {
      const p = msg.prayer;
      transitions.push(p);
      if (!JSON_OUT) {
        console.log(`  ${(Date.now() - startedAt) / 1000 | 0}s  rak'ah ${p.rakat}  `
          + `${String(p.positionLabel).padEnd(15)} ${p.reason}`);
      }
    }
    if (msg.type === 'trace_report') report = msg.report;
  });

  ws.send(JSON.stringify({
    type: 'init',
    sessionId: 'replay-wav-session',
    audioSource: 'browser',
    groqApiKey: 'local-whisper',
    transcriptionProvider: 'groq',
    pipelineVersion: 'v4',
    appVersion: 'replay-wav',
    prayerConfig: { targetRakat: 20, rakatPerSet: 2 },
  }));
  await sleep(400);
  ws.send(JSON.stringify({ type: 'start' }));
  startedAt = Date.now();

  if (!JSON_OUT) {
    console.log(`[wav] ${WAV} — ${Math.round(durationMs / 1000)}s at ${SPEED}x\n`);
  }
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(pcm.slice(off, Math.min(off + FRAME_BYTES, pcm.length)));
    await sleep(FRAME_MS / SPEED);
  }
  // Let the last window drain through the provider before asking for the trace.
  await sleep(6000);
  ws.send(JSON.stringify({ type: 'get_trace' }));
  for (let i = 0; i < 60 && !report; i++) await sleep(100);
  ws.close();

  if (!report) throw new Error('backend returned no trace report');
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return; }
  const s = report.summary;
  console.log(`\n[trace] ${s.events} events over ${Math.round(s.durationMs / 1000)}s`
    + ` — ${s.transcripts.total} transcripts (${s.transcripts.empty} empty), ${s.errors} errors`);
  console.log(`[trace] cues: ${s.cues.accepted}/${s.cues.total} acted on  ${JSON.stringify(s.cues.byKind)}`);
  if (Object.keys(s.cues.rejectedBecause).length) {
    console.log(`[trace] ignored because: ${JSON.stringify(s.cues.rejectedBecause)}`);
  }
  console.log(`[trace] transitions: ${JSON.stringify(s.prayer.byReason)}`);
  console.log(`[trace] rak'ah reached: ${s.prayer.rakatReached}\n`);

  console.log('what it heard and what it did:');
  for (const e of report.events) {
    const t = `${(e.t / 1000).toFixed(1)}s`.padStart(8);
    if (e.type === 'asr') {
      console.log(`${t}  asr     ${(e.text || '(nothing)').slice(0, 58).padEnd(60)} ${e.audioMs}ms`);
    } else if (e.type === 'cue') {
      console.log(`${t}  cue     ${e.kind} ${e.accepted ? `ACCEPTED -> ${e.to}` : `ignored: ${e.reason}`}`);
    } else if (e.type === 'prayer') {
      console.log(`${t}  prayer  ${e.from} -> ${e.to}  rak'ah ${e.rakat} (${e.reason})`);
    } else if (e.type === 'lock') {
      console.log(`${t}  lock    ${e.at} conf=${e.confidence} posture=${e.posture}`);
    } else if (e.type === 'error') {
      console.log(`${t}  error   ${e.where}: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error('[replay-wav]', e.message); process.exit(1); });
