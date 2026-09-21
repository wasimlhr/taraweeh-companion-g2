#!/usr/bin/env node
/**
 * Drive a whole taraweeh through the real backend, end to end, without an API
 * key or a microphone.
 *
 * Everything downstream of the ASR is genuine: a WebSocket client streams PCM
 * into the live server, the pipeline buffers it, gates it on voice activity,
 * opens a search window, and calls the transcription provider. Only the
 * provider itself is a stand-in — a local HTTP server that answers with a
 * scripted sequence of what an imam actually says, so the cue detection,
 * debouncing, voting, state machine, rak'ah counting and WebSocket emission
 * all run for real.
 *
 *   node scripts/replay-prayer-session.js [--rakat=4] [--json]
 *
 * Exits non-zero if the rak'ah count or the posture sequence comes out wrong,
 * so it doubles as a smoke test of the whole chain.
 */
import { createServer } from 'http';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

// ws lives in backend/node_modules, which is where the server it drives runs.
const { WebSocket } = createRequire(new URL('../backend/package.json', import.meta.url))('ws');

// fileURLToPath, not URL.pathname: on Windows the latter hands back
// "/C:/projects/..." with a leading slash, which spawn cannot use as a cwd.
const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const TARGET_RAKAT = parseInt(argOf('rakat', '4'), 10);
const JSON_OUT = args.includes('--json');
const ASR_PORT = parseInt(argOf('asr-port', '8199'), 10);
const BACKEND_PORT = parseInt(argOf('port', '3199'), 10);

const TAKBEER = 'الله أكبر';
const TASMEE = 'سمع الله لمن حمده';
const TASLEEM = 'السلام عليكم ورحمة الله';
const FATIHA_1 = 'الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين';
const FATIHA_2 = 'إياك نعبد وإياك نستعين اهدنا الصراط المستقيم';
const FATIHA_3 = 'صراط الذين أنعمت عليهم غير المغضوب عليهم ولا الضالين';
const SURAH = 'قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد';

/**
 * One rak'ah as a microphone would hear it. `gapMs` is the silence that
 * follows each utterance — the time the imam spends bowing, prostrating or
 * drawing breath.
 */
function rakahScript() {
  return [
    { text: FATIHA_1, gapMs: 1500 },
    { text: FATIHA_2, gapMs: 1500 },
    { text: FATIHA_3, gapMs: 2000 },
    { text: SURAH,    gapMs: 2000 },
    { text: TAKBEER,  gapMs: 6000 },   // qiyam   → ruku'   (then he is bowing)
    { text: TASMEE,   gapMs: 4000 },   // ruku'   → i'tidal
    { text: TAKBEER,  gapMs: 6000 },   // i'tidal → sujud 1
    { text: TAKBEER,  gapMs: 3000 },   // sujud 1 → jalsah
    { text: TAKBEER,  gapMs: 6000 },   // jalsah  → sujud 2
    { text: TAKBEER,  gapMs: 3000 },   // sujud 2 → next rak'ah
  ];
}

/** Flatten the script onto an absolute timeline of utterance start times. */
function buildTimeline(rakat) {
  const out = [];
  let t = 1000;
  const push = (u) => {
    const spokenMs = Math.max(700, u.text.split(/\s+/).length * 330);
    out.push({ text: u.text, atMs: t, endMs: t + spokenMs });
    t += spokenMs + u.gapMs;
  };
  for (let i = 0; i < rakat; i++) {
    rakahScript().forEach(push);
    // Taraweeh is prayed two at a time, with a tasleem closing each pair.
    if ((i + 1) % 2 === 0) push({ text: TASLEEM, gapMs: 6000 });
  }
  return out;
}

// ── Stand-in ASR ────────────────────────────────────────────────────────────
// Transcribes the audio window it was actually given: the WAV length says how
// many seconds of tape this is, and the reply is whatever the timeline says
// was spoken during them. That reproduces the behaviour that matters most —
// a growing search buffer re-reporting one takbeer across several windows.

let asrCalls = 0;
let startedAt = 0;
const timeline = buildTimeline(TARGET_RAKAT);
const timelineEndMs = timeline.length ? timeline[timeline.length - 1].endMs : 0;

function transcribeWindow(bodyBytes) {
  const windowMs = Math.max(500, Math.round(((bodyBytes - 44) / 2 / SR) * 1000));
  const now = Date.now() - startedAt;
  const from = now - windowMs;
  const hits = timeline.filter((u) => u.endMs > from && u.atMs <= now);
  return hits.map((u) => u.text).join(' ').trim();
}

const asr = createServer((req, res) => {
  let bytes = 0;
  req.on('data', (c) => { bytes += c.length; });
  req.on('end', () => {
    asrCalls += 1;
    const text = transcribeWindow(bytes);
    const words = text ? text.split(/\s+/).map((w, i) => ({ word: w, start: i * 0.33, end: i * 0.33 + 0.3 })) : [];
    const body = JSON.stringify({ text, words });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
});

// ── Synthetic audio ─────────────────────────────────────────────────────────
// The pipeline gates on voice activity and resets its search buffer after a
// hangover of silence, so the tape has to have the same shape as the prayer:
// energy while something is being said, room tone while the imam is bowing.
// Feeding continuous noise instead would stretch every search window and make
// the tracker look laggy for reasons that have nothing to do with it.

const SR = 16000;
const FRAME_MS = 200;
const FRAME_SAMPLES = (SR * FRAME_MS) / 1000;
let phase = 0;

function isSpeaking(atMs) {
  return timeline.some((u) => atMs >= u.atMs && atMs <= u.endMs);
}

function audioFrame(atMs) {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  const speaking = isSpeaking(atMs);
  const amp = speaking ? 0.22 : 0.0006;   // room tone sits under the voice gate
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    phase += (2 * Math.PI * 180) / SR;
    const tone = speaking ? Math.sin(phase) * amp : 0;
    const noise = (Math.random() - 0.5) * (speaking ? 0.06 : amp);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((tone + noise) * 32767))), i * 2);
  }
  return buf;
}

// ── Runner ──────────────────────────────────────────────────────────────────

const seen = [];
let lastRakat = 0;
let lastPosition = '';

function note(msg) {
  const snap = msg.prayer || {};
  const key = `${snap.position}#${snap.rakat}`;
  if (key === lastPosition) return;
  lastPosition = key;
  lastRakat = snap.rakat || lastRakat;
  seen.push({ position: snap.position, rakat: snap.rakat, reason: snap.reason });
  if (!JSON_OUT) {
    console.log(`  rak'ah ${String(snap.rakat).padStart(2)}  ${String(snap.positionLabel || snap.position).padEnd(15)} ${snap.reason || ''}`);
  }
}

async function main() {
  await new Promise((r) => asr.listen(ASR_PORT, '127.0.0.1', r));
  if (!JSON_OUT) console.log(`[replay] stand-in ASR on :${ASR_PORT}`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      GROQ_TRANSCRIBE_URL: `http://127.0.0.1:${ASR_PORT}/v1/audio/transcriptions`,
      SHARED_GROQ_KEY: 'replay-stand-in',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  const VERBOSE = args.includes('--verbose');
  const capture = (d) => {
    serverLog.push(d.toString());
    if (VERBOSE) process.stderr.write(d);
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  await sleep(3500);

  const ws = new WebSocket(`ws://127.0.0.1:${BACKEND_PORT}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let traceReport = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type === 'taraweeh') note(msg);
    if (msg.type === 'trace_report') traceReport = msg.report;
  });

  ws.send(JSON.stringify({
    type: 'init',
    sessionId: 'replay-prayer-session',
    audioSource: 'browser',
    groqApiKey: 'replay-stand-in',
    transcriptionProvider: 'groq',
    pipelineVersion: 'v4',
    prayerConfig: { targetRakat: TARGET_RAKAT, rakatPerSet: 2 },
  }));
  await sleep(400);
  ws.send(JSON.stringify({ type: 'start' }));
  startedAt = Date.now();

  if (!JSON_OUT) console.log(`[replay] praying ${TARGET_RAKAT} rak'ah…\n`);
  const deadline = Date.now() + timelineEndMs + 10000;
  while (Date.now() < deadline) {
    if (ws.readyState === WebSocket.OPEN) ws.send(audioFrame(Date.now() - startedAt));
    await sleep(FRAME_MS);
  }

  // Pull the backend's own trace before tearing the connection down. This is
  // the same report a user sends from the app, so exercising it here keeps the
  // diagnostics path from rotting.
  ws.send(JSON.stringify({ type: 'get_trace' }));
  for (let i = 0; i < 40 && !traceReport; i++) await sleep(100);

  ws.close();
  server.kill('SIGTERM');
  await sleep(600);
  try { server.kill('SIGKILL'); } catch (_) {}
  asr.close();

  const report = {
    targetRakat: TARGET_RAKAT,
    reachedRakat: lastRakat,
    asrCalls,
    transitions: seen,
    postures: [...new Set(seen.map((s) => s.position))],
    trace: traceReport ? traceReport.summary : null,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(traceReport ? { ...report, events: traceReport.events } : report, null, 2));
  } else {
    console.log(`\n[replay] ${seen.length} transitions, ${asrCalls} transcription calls`);
    console.log(`[replay] reached rak'ah ${lastRakat} of ${TARGET_RAKAT}`);
    if (traceReport) {
      const s = traceReport.summary;
      console.log(`\n[trace] ${s.events} events over ${Math.round(s.durationMs / 1000)}s`
        + ` — ${s.transcripts.total} transcripts (${s.transcripts.empty} empty), ${s.errors} errors`);
      console.log(`[trace] cues: ${s.cues.accepted}/${s.cues.total} acted on`
        + `  ${JSON.stringify(s.cues.byKind)}`);
      if (Object.keys(s.cues.rejectedBecause).length) {
        console.log(`[trace] ignored because: ${JSON.stringify(s.cues.rejectedBecause)}`);
      }
      console.log(`[trace] transitions: ${JSON.stringify(s.prayer.byReason)}`);
    } else {
      console.log('[trace] backend returned no report');
    }
  }

  const wanted = ['QIYAM', 'RUKU', 'ITIDAL', 'SAJDA1', 'JALSAH', 'SAJDA2', 'TASHAHHUD'];
  const missing = wanted.filter((p) => !report.postures.includes(p));
  let failed = false;
  if (missing.length) {
    console.error(`[replay] FAIL — never entered: ${missing.join(', ')}`);
    failed = true;
  }
  if (lastRakat < TARGET_RAKAT) {
    console.error(`[replay] FAIL — expected to reach rak'ah ${TARGET_RAKAT}, got ${lastRakat}`);
    failed = true;
  }
  if (failed) {
    console.error('\n--- server log tail ---\n' + serverLog.join('').split('\n').slice(-60).join('\n'));
    process.exit(1);
  }
  if (!JSON_OUT) console.log('[replay] PASS — full posture cycle and rak\'ah count reached');
  process.exit(0);
}

main().catch((err) => {
  console.error('[replay] error:', err);
  process.exit(1);
});
