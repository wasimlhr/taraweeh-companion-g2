/**
 * Taraweeh Companion Backend — WebSocket server with AudioPipeline per client.
 * Overlapping chunks, parallel transcription, auto-advance when locked.
 * v3.0.5 — bismillah never locks, in any mode
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
import { buildMushafIndex } from './mushafIndex.js';
import { closeTranscription, PROVIDER, sharedKeyAvailability, compareProviders, probeProviderKey, STT_ENGINES } from './transcriptionRouter.js';
import { AudioPipeline as AudioPipelineV3 } from './audioPipelineV3.js';
import { AudioPipeline as AudioPipelineV4 } from './audioPipelineV4.js';
import { probeWhisperEndpoint } from './whisperProvider.js';

const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SHARED_GROQ_KEY = (process.env.SHARED_GROQ_KEY || '').trim();
const SHARED_OPENAI_KEY = (process.env.SHARED_OPENAI_KEY || '').trim();
const SHARED_DEEPGRAM_KEY = (process.env.SHARED_DEEPGRAM_KEY || '').trim();
const SHARED_ELEVENLABS_KEY = (process.env.SHARED_ELEVENLABS_KEY || '').trim();
const HAS_ANY_SHARED_KEY = !!(SHARED_GROQ_KEY || SHARED_OPENAI_KEY || SHARED_DEEPGRAM_KEY || SHARED_ELEVENLABS_KEY);
const SAMPLE_RATE = 16000;
const MOBILE_ONLY_MODE = process.env.MOBILE_ONLY_MODE === 'true';
const ENDPOINT_ON_DEMAND_ENABLED = process.env.ENDPOINT_ON_DEMAND_ENABLED === 'true';
const ALLOWED_PIPELINES = new Set(['v3', 'v4']);
const ALLOWED_AUDIO_SOURCES = new Set(['browser', 'simulator', 'g2']);
const ALLOWED_MODELS = {
  groq: new Set(['whisper-large-v3-turbo', 'whisper-large-v3']),
  openai: new Set(['gpt-4o-mini-transcribe', 'gpt-transcribe', 'gpt-4o-transcribe', 'whisper-1']),
  deepgram: new Set(['nova-3', 'whisper-large']),
};
const LOCAL_TRANSLATION_LANGS = new Set(['', 'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv']);

let lastEndpointLifecycle = {
  component: 'model',
  status: 'unknown',
  provider: 'unknown',
  source: 'startup',
  updatedAt: Date.now(),
};

loadQuran();
try { buildMushafIndex(); } catch (e) { console.warn('[MushafIndex] build failed:', e.message); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
// Single source of truth for the version reported to clients and /api/status.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

const app = express();
app.use(express.json({ limit: '4mb' }));

// A packed .ehpk runs from the Even Hub's own origin, so every /api call is
// cross-origin. WebSockets ignore CORS, which is why transcription worked while
// "Test key" reported a network failure. The JSON POSTs send Content-Type:
// application/json, so the preflight has to be answered too.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function sanitizePipelineVersion(version) {
  const v = String(version || '').toLowerCase().trim();
  return ALLOWED_PIPELINES.has(v) ? v : 'v4';
}

function sanitizeTranslationLang(lang) {
  const normalized = (lang && String(lang).trim()) || '';
  return LOCAL_TRANSLATION_LANGS.has(normalized) ? normalized : '';
}

function sanitizeAudioSource(source) {
  const normalized = String(source || '').toLowerCase().trim();
  return ALLOWED_AUDIO_SOURCES.has(normalized) ? normalized : 'g2';
}

function sanitizeModel(provider, model) {
  const v = String(model || '').trim();
  return ALLOWED_MODELS[provider]?.has(v) ? v : '';
}

function buildWhisperOpts() {
  // Endpoint auth/config is host-managed only; never take client overrides.
  const endpointUrl = process.env.WHISPER_ENDPOINT_URL || '';
  const isModalUrl = /modal\.run|modal\.com/i.test(endpointUrl);
  return {
    provider: endpointUrl ? (isModalUrl ? 'modal' : 'hf-dedicated') : 'hf-public',
    endpointUrl: endpointUrl || undefined,
    apiKey: HF_TOKEN || undefined,
    modalKey: isModalUrl ? (process.env.MODAL_KEY || undefined) : undefined,
    modalSecret: isModalUrl ? (process.env.MODAL_SECRET || undefined) : undefined,
  };
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

function sendAppHtml(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(join(rootDir, 'app', 'index.html'));
}

app.get('/', sendAppHtml);
// EvenHub reads app.json (entrypoint: index.html) and requests /index.html
// next to it. Missing this route makes a hard-reload in the local sim blank.
app.get('/index.html', sendAppHtml);

// Bundled EvenHub SDK — index.html imports /sdk/even_hub_sdk.js. CDN fallback
// loads a different module realm than the simulator bridge and the app looks blank.
const EVENHUB_SDK = [
  join(rootDir, 'dist', 'sdk', 'even_hub_sdk.js'),
  join(rootDir, 'node_modules', '@evenrealities', 'even_hub_sdk', 'dist', 'index.js'),
].find((p) => existsSync(p));
function sendEvenHubSdk(req, res) {
  if (!EVENHUB_SDK) {
    res.status(404).type('text/plain').send('EvenHub SDK not installed');
    return;
  }
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(EVENHUB_SDK);
}
if (EVENHUB_SDK) {
  app.get('/sdk/even_hub_sdk.js', sendEvenHubSdk);
  // Page is also served at /app/index.html; relative ./sdk/... must not 404.
  app.get('/app/sdk/even_hub_sdk.js', sendEvenHubSdk);
}
app.get('/api/status', (req, res) => {
  const ep = process.env.WHISPER_ENDPOINT_URL || '';
  const usesLegacyWhisper = PROVIDER === 'whisper' && !!(ep || HF_TOKEN);
  const shared = sharedKeyAvailability();
  const modelName = usesLegacyWhisper
    ? (ep ? 'whisper-quran (dedicated)' : 'whisper-quran-v1 (legacy HF)')
    : 'independent engines: groq / openai (optional deepgram / elevenlabs)';
  res.json({
    version: APP_VERSION,
    appVersion: APP_VERSION,
    groqConfigured: shared.groq,
    openaiConfigured: shared.openai,
    deepgramConfigured: shared.deepgram,
    elevenlabsConfigured: shared.elevenlabs,
    sharedKeysConfigured: HAS_ANY_SHARED_KEY,
    sharedProviders: shared,
    geminiConfigured: !!GEMINI_KEY,
    provider: PROVIDER,
    model: modelName,
    transcription: HAS_ANY_SHARED_KEY ? 'shared-keys' : 'byok',
    sttEngines: STT_ENGINES,
    legacyWhisperConfigured: usesLegacyWhisper,
    endpointOnDemandEnabled: ENDPOINT_ON_DEMAND_ENABLED,
    mobileOnlyMode: MOBILE_ONLY_MODE,
    probeOnInit: process.env.WHISPER_PROBE_ON_INIT !== 'false',
    allowedPipelines: ['v3', 'v4'],
    allowedProviders: [...STT_ENGINES, 'auto'],
    allowedModels: Object.fromEntries(Object.entries(ALLOWED_MODELS).map(([k, v]) => [k, [...v]])),
    translationSource: 'local-bundled',
    allowedTranslationLangs: ['', 'en', 'ur', 'fr', 'es', 'id', 'tr', 'bn', 'zh', 'ru', 'sv'],
    endpointLifecycle: lastEndpointLifecycle,
  });
});

app.post('/api/transcription/test-key', async (req, res) => {
  const provider = String(req.body?.provider || '').toLowerCase();
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!STT_ENGINES.includes(provider)) {
    return res.status(400).json({ ok: false, message: 'Unknown provider' });
  }
  try {
    const result = await probeProviderKey(provider, apiKey);
    res.json({ ok: true, provider, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, provider, message: err.message || 'Key check failed' });
  }
});

app.post('/api/transcription/compare', async (req, res) => {
  const b64 = String(req.body?.pcmBase64 || '').trim();
  if (!b64) return res.status(400).json({ ok: false, message: 'pcmBase64 required' });
  let pcm;
  try {
    pcm = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ ok: false, message: 'Invalid pcmBase64' });
  }
  if (pcm.length < 3200) {
    return res.status(400).json({ ok: false, message: 'Audio too short (need ~100ms+ of 16kHz PCM)' });
  }
  const whisperOpts = {
    // Never fall back to SHARED_*_KEY here. This route is unauthenticated and
    // publicly reachable, so a shared-key fallback would let anyone spend the
    // host's Groq/OpenAI quota. Compare comes from Settings, where the user has
    // already entered their own key.
    sharedMode: false,
    groqApiKey: req.body?.groqApiKey || '',
    openaiApiKey: req.body?.openaiApiKey || '',
    deepgramApiKey: req.body?.deepgramApiKey || '',
    elevenlabsApiKey: req.body?.elevenlabsApiKey || '',
  };
  try {
    const results = await compareProviders(pcm, whisperOpts);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || 'Compare failed' });
  }
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
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      latest = null;
      await probeWhisperEndpoint({ ...(buildWhisperOpts() || {}), forceProbe: true }, (s) => {
        latest = s;
        updateEndpointLifecycle(s, 'warmup');
      });
      const status = latest?.status;
      if (status === 'standby' || status === 'ready') break;
      if (status === 'error') break;
      const retryIn = Number(latest?.retryIn || 2);
      const delayMs = Math.max(1000, Math.min(retryIn * 1000, 8000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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
// Mushaf page JSONs + Arabic font for on-device rendering on G2 glasses.
// Copied from noor-recite (GPL v3). These are lazy-fetched by the frontend.
app.use('/mushaf', express.static(join(__dirname, 'public', 'mushaf'), {
  maxAge: '7d',  // long cache — mushaf layout never changes
  setHeaders: (res) => { res.set('Access-Control-Allow-Origin', '*'); },
}));
app.use('/fonts', express.static(join(__dirname, 'public', 'fonts'), {
  maxAge: '30d',
  setHeaders: (res) => { res.set('Access-Control-Allow-Origin', '*'); },
}));

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

// Session dedup by client-supplied session ID (not IP — prod users share NAT/carrier
// IPs and would cannibalise each other). Clients send a stable per-install ID on init;
// if the SAME session ID is already connected, close the stale one. Different users
// have different IDs so they never interfere.
const _activeSessions = new Map(); // sessionId → ws

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);
  let pipeline = null;
  let sessionId = null;

  function send(msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  let pipelineVersion = 'v4';

  function createPipeline(preferredSurah = 0, opts = {}, version) {
    if (pipeline) pipeline.destroy();
    pipelineVersion = sanitizePipelineVersion(version || pipelineVersion);
    const Ctor = pipelineVersion === 'v3' ? AudioPipelineV3 : AudioPipelineV4;

    let whisperOpts = buildWhisperOpts();
    const allowedProviders = new Set(['auto', 'groq', 'openai', 'deepgram', 'elevenlabs']);
    const clientProvider = allowedProviders.has(opts?.transcriptionProvider)
      ? opts.transcriptionProvider
      : 'groq';
    const clientModel = sanitizeModel(clientProvider, opts?.transcriptionModel);
    const groqKey = (typeof opts?.groqApiKey === 'string') ? opts.groqApiKey.trim() : '';
    const openaiKey = (typeof opts?.openaiApiKey === 'string') ? opts.openaiApiKey.trim() : '';
    const deepgramKey = (typeof opts?.deepgramApiKey === 'string') ? opts.deepgramApiKey.trim() : '';
    const elevenlabsKey = (typeof opts?.elevenlabsApiKey === 'string') ? opts.elevenlabsApiKey.trim() : '';
    const hasByok = !!(groqKey || openaiKey || deepgramKey || elevenlabsKey);
    const useSharedMode = !hasByok && HAS_ANY_SHARED_KEY;

    whisperOpts = {
      ...whisperOpts,
      provider: clientProvider,
      groqApiKey: groqKey,
      openaiApiKey: openaiKey,
      deepgramApiKey: deepgramKey,
      elevenlabsApiKey: elevenlabsKey,
      sharedMode: useSharedMode,
      model: clientModel || undefined,
    };

    const selected = clientProvider === 'auto' ? 'groq' : clientProvider;
    const selectedKey = selected === 'groq' ? (groqKey || (useSharedMode ? SHARED_GROQ_KEY : ''))
      : selected === 'openai' ? (openaiKey || (useSharedMode ? SHARED_OPENAI_KEY : ''))
      : selected === 'deepgram' ? (deepgramKey || (useSharedMode ? SHARED_DEEPGRAM_KEY : ''))
      : selected === 'elevenlabs' ? (elevenlabsKey || (useSharedMode ? SHARED_ELEVENLABS_KEY : ''))
      : '';
    if (selectedKey) {
      console.log(`[Init] ${useSharedMode ? 'SHARED' : 'BYOK'} engine provider=${selected} model=${clientModel || '(default)'}`);
      send({ type: 'sys_status', component: 'model', status: 'ready', provider: selected, byok: !useSharedMode });
    } else {
      // 2.6.26 reported Ready for whichever button was lit even when that
      // engine had no key. Search then threw on every chunk with no pill
      // change, so the panel sat at 0.0s / Window 1/5.
      console.log(`[Init] No ${selected} key (byok=${hasByok} shared=${useSharedMode}) — transcribe will fail`);
      send({
        type: 'sys_status',
        component: 'model',
        status: 'error',
        provider: selected,
        message: `${selected} API key required`,
      });
    }
    const requestedTranslation = (opts.lang && String(opts.lang).trim()) || '';
    const translationLang = sanitizeTranslationLang(requestedTranslation);
    const audioSource = sanitizeAudioSource(opts.audioSource);
    if (requestedTranslation && requestedTranslation !== translationLang) {
      console.warn(`[Init] Unsupported translation "${requestedTranslation}" requested; falling back to built-in local English`);
    }

    console.log(`[Init] Creating pipeline ${pipelineVersion.toUpperCase()} translationLang=${translationLang || '(built-in)'} audioSource=${audioSource}`);
    pipeline = new Ctor({
      preferredSurah,
      translationLang,
      hfToken: HF_TOKEN,
      whisperOpts,
      audioSource,
      geminiKey: opts.geminiKey || GEMINI_KEY,
      onStateUpdate: (msg) => send(msg),
      onStatus: (s) => {
        updateEndpointLifecycle(s, 'pipeline');
        send({ type: 'sys_status', ...s });
      },
      onError: (err) => send({ type: 'error', error: err }),
    });
    // Honour client fast/slow explicitly. Slow mode now stretches the timer
    // on top of learned pace so the display lingers through slow recitations
    // instead of advancing at the naive measured rate.
    if (pipeline.setFastMode) pipeline.setFastMode(!!opts.fastMode);
    if (pipeline.setSlowMode) pipeline.setSlowMode(!!opts.slowMode);
    // Recitation mode: Practice wins if the client sent it. Default Taraweeh.
    if (opts.practiceMode && pipeline.setPracticeMode) {
      pipeline.setPracticeMode(true);
    } else if (pipeline.setTaraweehMode) {
      pipeline.setTaraweehMode(true);
      if (pipeline.setPracticeMode) pipeline.setPracticeMode(false);
    }
    console.log(`[Init] Pace: ${opts.fastMode ? 'FAST' : opts.slowMode ? 'SLOW' : 'normal'} (client), mode: ${opts.practiceMode ? 'practice' : 'taraweeh'}`);
    send({ type: 'pipeline_version', version: pipelineVersion });
    if (APP_VERSION) send({ type: 'backend_version', version: APP_VERSION });
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
            // Session dedup: if client re-opened without closing the old WS, kill it.
            const incomingSid = typeof msg.sessionId === 'string' ? msg.sessionId : '';
            if (incomingSid) {
              const stale = _activeSessions.get(incomingSid);
              if (stale && stale !== ws && stale.readyState === stale.OPEN) {
                console.log(`[WS] Session ${incomingSid.slice(0,8)}… reopened — closing stale connection`);
                try { stale.close(1000, 'superseded by new connection'); } catch (_) {}
              }
              sessionId = incomingSid;
              _activeSessions.set(sessionId, ws);
            }
            console.log(`[Init] preferredSurah=${surah} pipeline=${ver} sid=${sessionId ? sessionId.slice(0,8) : '(none)'} (client requested: ${requestedVer})`);
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
          case 'set_audio_source': pipeline?.setAudioSource?.(sanitizeAudioSource(msg.source)); break;
          case 'set_taraweeh_mode': pipeline?.setTaraweehMode(msg.enabled); break;
          case 'set_practice_mode':
          case 'set_verse_hold_mode': pipeline?.setPracticeMode?.(msg.enabled); break;
          case 'pace_nudge': pipeline?.paceNudge?.(Number(msg.factor) || 1.0); break;
          case 'reset_rakat': pipeline?.resetRakat(); break;
        }
      } catch {}
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected from ${clientIp}`);
    if (pipeline) { pipeline.destroy(); pipeline = null; }
    if (sessionId && _activeSessions.get(sessionId) === ws) _activeSessions.delete(sessionId);
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
  const shared = sharedKeyAvailability();
  if (!HAS_ANY_SHARED_KEY) {
    console.log('No SHARED_*_KEY env vars — users must supply Groq or OpenAI in app settings');
  } else {
    console.log(`Transcription shared keys: groq=${shared.groq} deepgram=${shared.deepgram} elevenlabs=${shared.elevenlabs} openai=${shared.openai}`);
  }
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
