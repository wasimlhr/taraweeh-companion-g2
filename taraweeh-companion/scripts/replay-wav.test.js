import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const { WebSocketServer } = createRequire(new URL('../backend/package.json', import.meta.url))('ws');
const run = promisify(execFile);

test('WAV replay accepts immediate init events and streams PCM before requesting its trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'taraweeh-wav-test-'));
  const file = join(dir, 'test.wav');
  const pcm = Buffer.alloc(6400, 1);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  await writeFile(file, wav);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received = [];
  server.on('connection', ws => ws.on('message', (raw, binary) => {
    if (binary) { received.push(Buffer.from(raw)); return; }
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'init') ws.send(JSON.stringify({ type: 'taraweeh',
      prayer: { rakat: 1, positionLabel: 'Standing', reason: 'init' } }));
    if (msg.type === 'get_trace') ws.send(JSON.stringify({ type: 'trace_report', report: {
      summary: { events: 0, durationMs: 0, transcripts: { total: 0, empty: 0 }, errors: 0,
        cues: { accepted: 0, total: 0, byKind: {}, rejectedBecause: {} },
        prayer: { byReason: {}, rakatReached: 1 } }, events: [],
    } }));
  }));
  try {
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL('./replay-wav-session.js', import.meta.url)),
      file, '--url', `ws://127.0.0.1:${server.address().port}`], { timeout: 15000 });
    assert.deepEqual(Buffer.concat(received), pcm);
    assert.match(stdout, /Standing\s+init/);
    assert.match(stdout, /rak'ah reached: 1/);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    await unlink(file);
    await rmdir(dir);
  }
});
