import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

const dir = dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + (process.pid % 1000);
const TOKEN = 'test-diag-token';
const BASE = `http://127.0.0.1:${PORT}`;

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HTTPS_PORT: String(PORT + 1),
      DIAG_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const onData = (c) => { out += c.toString(); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const start = Date.now();
  while (Date.now() - start < 25000) {
    if (/HTTP\s+→/.test(out)) return child;
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${out.slice(-2500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`server start timeout\n${out.slice(-2500)}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  const start = Date.now();
  while (Date.now() - start < 6000 && child.exitCode == null) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (child.exitCode == null) child.kill('SIGKILL');
}

test('analytics is token-gated and records connect/init/start/lang_pack', { timeout: 45000 }, async () => {
  const child = await startServer();
  let ws;
  try {
    const noToken = await fetch(`${BASE}/api/analytics`);
    assert.equal(noToken.status, 404);

    const badToken = await fetch(`${BASE}/api/analytics?token=wrong`);
    assert.equal(badToken.status, 404);

    const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
    assert.equal(status.liveConnections, 0);
    assert.equal(status.version, '3.4.9');
    assert.equal(status.translationSource, 'on-device-packs');

    const pack = await fetch(`${BASE}/translations/uzc.json`);
    assert.equal(pack.status, 200);
    assert.equal(pack.headers.get('access-control-allow-origin'), '*');
    const body = await pack.json();
    assert.equal(body.lang, 'uzc');
    assert.equal(body.ayahs, 6236);
    assert.match(body.verses[113][0], /инсонларнинг Парвардигоридан/);

    const missing = await fetch(`${BASE}/translations/xx.json`);
    assert.equal(missing.status, 404);

    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const sawBackend = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no backend_version after init')), 8000);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'backend_version') {
            clearTimeout(t);
            resolve();
          }
        } catch { /* ignore */ }
      });
    });
    ws.send(JSON.stringify({
      type: 'init',
      sessionId: 'sid-http-test',
      appVersion: 'v3.4.9',
      lang: 'uz',
      transcriptionProvider: 'groq',
      audioSource: 'browser',
      practiceMode: true,
      pipelineVersion: 'v4',
    }));
    await sawBackend;
    ws.send(JSON.stringify({ type: 'start' }));
    ws.send(JSON.stringify({ type: 'usage', event: 'lang_pack', lang: 'uzc', ok: true }));
    ws.send(JSON.stringify({ type: 'usage', event: 'drop_audio_here', pcm: 'nope' }));
    await new Promise((r) => setTimeout(r, 150));

    const live = await fetch(`${BASE}/api/status`).then((r) => r.json());
    assert.equal(live.liveConnections, 1);

    const snap = await fetch(`${BASE}/api/analytics?token=${TOKEN}`).then((r) => r.json());
    assert.equal(snap.live.connections, 1);
    assert.equal(snap.totals.inits, 1);
    assert.equal(snap.totals.listenStarts, 1);
    assert.equal(snap.totals.languagePacks, 1);
    assert.equal(snap.live.uniqueInstalls, 1);
    assert.equal(snap.using.translation[0].name, 'uz');
    assert.equal(snap.using.mode[0].name, 'practice');
    assert.doesNotMatch(JSON.stringify(snap), /drop_audio_here/);

    const html = await fetch(`${BASE}/api/analytics?token=${TOKEN}&format=html`).then((r) => r.text());
    assert.match(html, /Installs seen/);
    assert.match(html, />uz</);
  } finally {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* ignore */ }
    await stopServer(child);
  }
});
