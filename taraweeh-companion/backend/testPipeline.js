#!/usr/bin/env node
/**
 * End-to-end pipeline test: WAV → Whisper → Gemini → Fuzzy match.
 * Run from backend: node testPipeline.js
 * Requires: backend/.env with HUGGINGFACE_TOKEN (and optionally GEMINI_API_KEY)
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pcmToWav } from './pcmToWav.js';
import { transcribeWithWhisper } from './whisperClient.js';
import { classifyIslamicSpeech } from './geminiClient.js';
import { fuzzySearch, shouldLock, loadQuran } from './fuzzyMatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function test() {
  console.log('=== Pipeline Test ===\n');

  loadQuran();

  const wavPath = join(__dirname, '../test/sample-fatiha.wav');
  let wavBuffer;
  if (existsSync(wavPath)) {
    wavBuffer = readFileSync(wavPath);
    console.log('1. Loaded WAV:', wavBuffer.length, 'bytes');
  } else {
    const silentPcm = Buffer.alloc(96000, 0);
    wavBuffer = pcmToWav(silentPcm, 16000);
    console.log('1. Silent WAV:', wavBuffer.length, 'bytes');
  }

  try {
    console.log('\n2. Tarteel Whisper...');
    const text = await transcribeWithWhisper(wavBuffer);
    console.log('   Result:', text || '(empty)');

    if (text?.trim()) {
      if (process.env.GEMINI_API_KEY) {
        console.log('\n3. Gemini classification...');
        const cls = await classifyIslamicSpeech(text);
        console.log('   Result:', cls);
      }
      console.log('\n4. Fuzzy match...');
      const candidates = fuzzySearch(text);
      console.log('   Top:', candidates[0]);
      console.log('   Lock:', shouldLock(candidates));
    }
  } catch (err) {
    console.error('\nError:', err.message);
  }
}

test();
