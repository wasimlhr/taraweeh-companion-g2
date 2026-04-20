/**
 * Taraweeh Companion Backend — WebSocket server with AudioPipeline per client.
 * Overlapping chunks, parallel transcription, auto-advance when locked.
 * v5.0.2 — back-correction cooldown, higher snap-back threshold, stronger fast/slow modes
 */
import 'dotenv/config';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';
import express from 'express';
import { WebSocketServer } from 'ws';
import { loadQuran } from './keywordMatcher.js';
import { closeTranscription, PROVIDER } from './transcriptionRouter.js';
import { AudioPipeline as AudioPipelineV3 } from './audioPipelineV3.js';
import { AudioPipeline as AudioPipelineV4 } from './audioPipelineV4.js';
import { probeWhisperEndpoint } from './whisperProvider.js';

const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SAMPLE_RATE = 16000;
const MOBILE_ONLY_MODE = process.env.MOBILE_ONLY_MODE === 'true';
const ENDPOINT_ON_DEMAND_ENABLED = process.env.ENDPOINT_ON_DEMAND_ENABLED === 'true';
const ALLOWED_PIPELINES = new Set(['v3', 'v4']);
const LOCAL_TRANSLATION_LANGS = new Set(['', 'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv']);

let lastEndpointLifecycle = {
  component: 'model',
  status: 'unknown',
  provider: 'unknown',
  source: 'startup',
  updatedAt: Date.now(),
};

loadQuran();

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const app = express();

function sanitizePipelineVersion(version) {
  const v = String(version || '').toLowerCase().trim();
  return ALLOWED_PIPELINES.has(v) ? v : 'v4';
}

function sanitizeTranslationLang(lang) {
  const normalized = (lang && String(lang).trim()) || '';
  return LOCAL_TRANSLATION_LANGS.has(normalized) ? normalized : '';
}

function buildWhisperOpts(opts = {}) {
  const hasWhisperOverrides = opts.whisperProvider || opts.whisperEndpointUrl || opts.whisperApiKey || opts.hfToken;
  const ep = opts.whisperEndpointUrl || '';
  const isModalUrl = /modal\.run|modal\.com/i.test(ep);
  return hasWhisperOverrides
    ? {
        provider: opts.whisperProvider || undefined,
        endpointUrl: ep || undefined,
        apiKey: opts.whisperApiKey || opts.hfToken || HF_TOKEN || undefined,
        modalKey: isModalUrl ? (opts.whisperApiKey || opts.hfToken) : undefined,
        modalSecret: opts.whisperModalSecret || undefined,
      }
    : HF_TOKEN ? { apiKey: HF_TOKEN } : null;
}

function updateEndpointLifecycle(status, source = 'runtime') {
  if (!status || status.component !== 'model') return;
  lastEndpointLifecycle = {
    ...lastEndpointLifecycle,
    ...status,
    source,
    updatedAt: Date.now(),
  };
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(join(rootDir, 'app', 'index.html'));
});
app.get('/api/status', (req, res) => {
  const ep = process.env.WHISPER_ENDPOINT_URL || '';
  const isModal = /modal\.run|modal\.com/i.test(ep);
  const isHF = /huggingface\.cloud|endpoints\.huggingface/i.test(ep);
  const modelName = ep ? (isModal ? 'whisper-quran (Modal)' : isHF ? 'whisper-quran-v1 (HF)' : 'whisper-quran') : 'whisper-quran-v1 (HF Public)';
  res.json({
    hfConfigured: !!HF_TOKEN,
    geminiConfigured: !!GEMINI_KEY,
    provider: PROVIDER,
    model: modelName,
    endpoint: ep ? 'dedicated' : 'public-api',
    endpointOnDemandEnabled: ENDPOINT_ON_DEMAND_ENABLED,
    mobileOnlyMode: MOBILE_ONLY_MODE,
    probeOnInit: process.env.WHISPER_PROBE_ON_INIT !== 'false',
    allowedPipelines: ['v3', 'v4'],
    translationSource: 'local-bundled',
    allowedTranslationLangs: ['', 'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv'],
    endpointLifecycle: lastEndpointLifecycle,
  });
});

app.get('/api/endpoint/warmup', async (req, res) => {
  if (!ENDPOINT_ON_DEMAND_ENABLED) {
    return res.status(403).json({
      ok: false,
      message: 'Endpoint on-demand warmup is disabled. Set ENDPOINT_ON_DEMAND_ENABLED=true to enable.',
    });
  }

  try {
    let latest = null;
    await probeWhisperEndpoint({ ...(buildWhisperOpts({}) || {}), forceProbe: true }, (s) => {
      latest = s;
      updateEndpointLifecycle(s, 'warmup');
    });
    res.json({
      ok: true,
      lifecycle: latest || lastEndpointLifecycle,
      endpointLifecycle: lastEndpointLifecycle,
    });
  } catch (err) {
    const message = err?.message || 'Endpoint warmup failed';
    updateEndpointLifecycle({ component: 'model', status: 'error', message }, 'warmup');
    res.status(500).json({
      ok: false,
      message,
      endpointLifecycle: lastEndpointLifecycle,
    });
  }
});
app.use(express.static(rootDir));

const httpServer = createHttpServer(app);

// HTTPS server — needed for getUserMedia on LAN (browser blocks mic on http://<ip>)
const certsDir = join(__dirname, 'certs');
const certPath = join(certsDir, 'cert.pem');
const keyPath = join(certsDir, 'key.pem');
let httpsServer = null;
if (existsSync(certPath) && existsSync(keyPath)) {
  httpsServer = createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, app);
}

// WebSocket on both servers
const wss = new WebSocketServer({ noServer: true, path: '/ws' });
function upgradeToWs(server) {
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
upgradeToWs(httpServer);
if (httpsServer) upgradeToWs(httpsServer);

const keepaliveInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(keepaliveInterval));

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);
  let pipeline = null;

  function send(msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  let pipelineVersion = 'v4';

  function createPipeline(preferredSurah = 0, opts = {}, version) {
    if (pipeline) pipeline.destroy();
    pipelineVersion = sanitizePipelineVersion(version || pipelineVersion);
    const Ctor = pipelineVersion === 'v3' ? AudioPipelineV3 : AudioPipelineV4;

    const whisperOpts = buildWhisperOpts(opts);
    const requestedTranslation = (opts.lang && String(opts.lang).trim()) || '';
    const translationLang = sanitizeTranslationLang(requestedTranslation);
    if (requestedTranslation && requestedTranslation !== translationLang) {
      console.warn(`[Init] Unsupported translation "${requestedTranslation}" requested; falling back to built-in local English`);
    }

    console.log(`[Init] Creating pipeline ${pipelineVersion.toUpperCase()} translationLang=${translationLang || '(built-in)'}`);
    pipeline = new Ctor({
      preferredSurah,
      translationLang,
      hfToken: opts.hfToken || HF_TOKEN,
      whisperOpts,
      geminiKey: opts.geminiKey || GEMINI_KEY,
      onStateUpdate: (msg) => send(msg),
      onStatus: (s) => {
        updateEndpointLifecycle(s, 'pipeline');
        send({ type: 'sys_status', ...s });
      },
      onError: (err) => send({ type: 'error', error: err }),
    });
    // Ignore client fast/slow — learned pace handles it. Client localStorage
    // may have stale fastMode=true from old defaults.
    if (pipeline.setFastMode) pipeline.setFastMode(false);
    if (pipeline.setSlowMode) pipeline.setSlowMode(false);
    console.log(`[Init] Pace: normal (client sent: ${opts.fastMode ? 'FAST' : opts.slowMode ? 'SLOW' : 'normal'})`);
    send({ type: 'pipeline_version', version: pipelineVersion });
  }

  // Don't eagerly create — client sends 'init' message with settings.
  // Eager creation caused duplicate pipelines (old one's callbacks leaked).

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let _binaryLogged = false;
  ws.on('message', (data, isBinary) => {
    // ws library delivers ALL frames as Buffers — use isBinary flag to distinguish.
    // Without this, JSON control messages leak into the PCM audio buffer, corrupting
    // audio and inflating RMS (ASCII bytes interpreted as 16-bit PCM samples).
    if (isBinary) {
      if (!_binaryLogged) {
        console.log(`[WS] First PCM: ${data.length}B, active=${pipeline?.active}`);
        _binaryLogged = true;
      }
      if (pipeline && !pipeline.active) {
        console.log('[WS] PCM arrived before start msg — auto-activating pipeline');
        pipeline.start();
      }
      if (pipeline) pipeline.ingest(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'ping') console.log(`[WS] msg type=${msg.type}`);
        switch (msg.type) {
          case 'init': {
            const surah = (typeof msg.preferredSurah === 'number' && msg.preferredSurah >= 1 && msg.preferredSurah <= 114)
              ? msg.preferredSurah : 0;
            const requestedVer = sanitizePipelineVersion(msg.pipelineVersion);
            const ver = requestedVer;
            console.log(`[Init] preferredSurah=${surah} pipeline=${ver} (client requested: ${requestedVer})`);
            createPipeline(surah, msg, ver);
            _binaryLogged = false;
            break;
          }
          case 'start':
            console.log(`[WS] Start → pipeline.active was ${pipeline?.active}`);
            pipeline?.start();
            break;
          case 'stop':  pipeline?.stop();  break;
          case 'reset': pipeline?.reset(); break;
          case 'pause': pipeline?.pause(); break;
          case 'audio_return': pipeline?.audioReturn(); break;
          case 'ping': ws.isAlive = true; send({ type: 'pong' }); break;
          case 'manual_advance': pipeline?.manualAdvance(); break;
          case 'manual_prev': pipeline?.manualPrev(); break;
          case 'set_fast_mode': pipeline?.setFastMode(msg.enabled); break;
          case 'set_slow_mode': pipeline?.setSlowMode(msg.enabled); break;
          case 'set_taraweeh_mode': pipeline?.setTaraweehMode(msg.enabled); break;
          case 'reset_rakat': pipeline?.resetRakat(); break;
        }
      } catch {}
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected from ${clientIp}`);
    if (pipeline) { pipeline.destroy(); pipeline = null; }
  });

  send({ type: 'connected', sampleRate: SAMPLE_RATE });
});

function getLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const LAN_IP = getLanIp();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP  → http://localhost:${PORT}`);
  if (LAN_IP !== 'localhost') console.log(`HTTP  → http://${LAN_IP}:${PORT}`);
  const hasModalDedicated = /modal\.run|modal\.com/i.test(process.env.WHISPER_ENDPOINT_URL || '');
  if (PROVIDER === 'whisper' && !HF_TOKEN && !hasModalDedicated) console.warn('HUGGINGFACE_TOKEN not set (required for HF fallback)');
});
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS → https://localhost:${HTTPS_PORT}`);
    if (LAN_IP !== 'localhost') console.log(`HTTPS → https://${LAN_IP}:${HTTPS_PORT}  ← use this on phone (accept cert warning once)`);
  });
}

process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received — shutting down');
  // Close all WebSocket connections (triggers 'close' → pipeline.destroy())
  wss.clients.forEach(ws => ws.terminate());
  await closeTranscription();
  httpServer.close(() => process.exit(0));
  // Force exit after 5s if graceful close hangs
  setTimeout(() => process.exit(1), 5000).unref();
});
