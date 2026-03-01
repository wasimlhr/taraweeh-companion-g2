#!/usr/bin/env node
/**
 * Test Whisper endpoint (HF or Modal) from your PC.
 * Usage:
 *   node testWhisperEndpoint.js                    # uses 1s silence (proves endpoint reachable)
 *   node testWhisperEndpoint.js path/to/audio.wav  # transcribe a WAV file (16kHz mono)
 *
 * Requires: backend/.env with HUGGINGFACE_TOKEN (and WHISPER_ENDPOINT_URL for dedicated)
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pcmToWav } from './pcmToWav.js';
import { transcribeWithWhisper, probeWhisperEndpoint } from './whisperProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function test() {
  const ep = process.env.WHISPER_ENDPOINT_URL;
  const token = process.env.HUGGINGFACE_TOKEN;
  const isModal = ep && /modal\.run|modal\.com/i.test(ep);
  const isHF = ep && /huggingface\.cloud|endpoints\.huggingface/i.test(ep);

  console.log('=== Whisper Endpoint Test ===\n');
  console.log('Config:');
  console.log('  WHISPER_ENDPOINT_URL:', ep || '(not set → HF public API)');
  console.log('  HUGGINGFACE_TOKEN:', token ? '***' + token.slice(-4) : '(not set)');
  console.log('  Detected:', ep ? (isModal ? 'Modal' : isHF ? 'HF dedicated' : 'custom') : 'HF public');
  console.log('');

  // 1. Probe
  console.log('1. Probing endpoint...');
  const opts = ep ? { endpointUrl: ep, apiKey: token, provider: isModal ? 'modal' : 'hf-dedicated', modalKey: process.env.MODAL_KEY, modalSecret: process.env.MODAL_SECRET } : { apiKey: token };
  await probeWhisperEndpoint(opts, (msg) => {
    if (msg.status === 'standby') console.log('   ✓ Reachable (HTTP', msg.httpStatus + ',', msg.latencyMs + 'ms)');
    if (msg.status === 'loading') console.log('   ⏳ Cold start, retry in', msg.retryIn + 's');
    if (msg.status === 'error') console.log('   ✗ Error:', msg.message);
  });
  console.log('');

  // 2. Transcribe
  const wavPath = process.argv[2];
  let wavBuffer;
  if (wavPath && existsSync(wavPath)) {
    wavBuffer = readFileSync(wavPath);
    console.log('2. Loaded WAV:', wavPath, '(' + wavBuffer.length + ' bytes)');
  } else {
    const silentPcm = Buffer.alloc(16000 * 2, 0); // 1 second @ 16kHz 16-bit
    wavBuffer = pcmToWav(silentPcm, 16000);
    console.log('2. Using 1s silence WAV (', wavBuffer.length, 'bytes) — endpoint reachability test');
    if (wavPath) console.log('   (file not found:', wavPath + ')');
  }

  try {
    console.log('\n3. Transcribing...');
    const result = await transcribeWithWhisper(wavBuffer, opts, (msg) => {
      if (msg.status === 'loading') process.stdout.write('   Loading... ');
      if (msg.status === 'ready') process.stdout.write('done\n');
    });
    console.log('   Result:', JSON.stringify(result.text || '(empty)'));
    console.log('   Provider:', result.provider);
    console.log('\n✓ Test passed');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  }
}

test();
