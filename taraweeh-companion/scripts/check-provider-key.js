#!/usr/bin/env node
/** Groq with no key must emit an error, not look Ready. */
import { transcribe } from '../backend/transcriptionRouter.js';

const events = [];
let threw = false;
try {
  await transcribe(Buffer.alloc(32000), { provider: 'groq', groqApiKey: '', sharedMode: false }, (e) => events.push(e));
} catch (err) {
  threw = /Groq API key missing/i.test(err.message || '');
}
const emitted = events.some((e) => e.component === 'model' && e.status === 'error' && e.provider === 'groq');
if (!threw || !emitted) {
  console.error('FAIL threw=', threw, 'events=', events);
  process.exit(1);
}
console.log('ok  missing Groq key emits Groq error (not Ready)');
