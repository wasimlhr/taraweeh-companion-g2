/**
 * Taraweeh Companion Backend — WebSocket server with AudioPipeline per client.
 * Overlapping chunks, parallel transcription, auto-advance when locked.
 * v5.0.1 — spotCheck refrain fix
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
import { AudioPipeline as AudioPipelineV1 } from './audioPipeline.js';
import { AudioPipeline as AudioPipelineV2 } from './audioPipelineV2.js';

const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SAMPLE_RATE = 16000;

loadQuran();

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const app = express();
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
  });
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

  let pipelineVersion = 'v2';

  function createPipeline(preferredSurah = 0, hfToken, geminiKey, version) {
    if (pipeline) pipeline.destroy();
    if (version) pipelineVersion = version;
    const Ctor = pipelineVersion === 'v1' ? AudioPipelineV1 : AudioPipelineV2;
    console.log(`[Init] Creating pipeline ${pipelineVersion.toUpperCase()}`);
    pipeline = new Ctor({
      preferredSurah,
      hfToken: hfToken || HF_TOKEN,
      geminiKey: geminiKey || GEMINI_KEY,
      onStateUpdate: (msg) => send(msg),
      onStatus: (s) => send({ type: 'sys_status', ...s }),
      onError: (err) => send({ type: 'error', error: err }),
    });
    send({ type: 'pipeline_version', version: pipelineVersion });
  }

  createPipeline();

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
        console.log(`[WS] msg type=${msg.type}`);
        switch (msg.type) {
          case 'init': {
            const surah = (typeof msg.preferredSurah === 'number' && msg.preferredSurah >= 1 && msg.preferredSurah <= 114)
              ? msg.preferredSurah : 0;
            const ver = msg.pipelineVersion === 'v1' ? 'v1' : 'v2';
            console.log(`[Init] preferredSurah=${surah} pipeline=${ver}`);
            createPipeline(surah, msg.hfToken, msg.geminiKey, ver);
            _binaryLogged = false;
            break;
          }
          case 'start':
            console.log(`[WS] Start → pipeline.active was ${pipeline?.active}`);
            pipeline?.start();
            break;
          case 'stop':  pipeline?.stop();  break;
          case 'reset': pipeline?.reset(); break;
          case 'audio_return': pipeline?.audioReturn(); break;
          case 'manual_advance': pipeline?.manualAdvance(); break;
          case 'manual_prev': pipeline?.manualPrev(); break;
          case 'set_fast_mode': pipeline?.setFastMode(msg.enabled); break;
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
  if (PROVIDER === 'whisper' && !HF_TOKEN) console.warn('HUGGINGFACE_TOKEN not set');
});
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS → https://localhost:${HTTPS_PORT}`);
    if (LAN_IP !== 'localhost') console.log(`HTTPS → https://${LAN_IP}:${HTTPS_PORT}  ← use this on phone (accept cert warning once)`);
  });
}

process.on('SIGTERM', async () => {
  await closeTranscription();
  httpServer.close();
});
