#!/usr/bin/env node
/**
 * Prove the v2.6.12 handshake flags the July Railway backend (no appVersion)
 * and accepts a current backend. Also checks Groq honouring whisperOpts.model.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { transcribeWithGroq } from '../backend/groqProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function parseAppVer(v) {
  const p = String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  return { maj: p[0] || 0, min: p[1] || 0, pat: p[2] || 0 };
}
function appVerLt(a, b) {
  const A = parseAppVer(a), B = parseAppVer(b);
  if (A.maj !== B.maj) return A.maj < B.maj;
  if (A.min !== B.min) return A.min < B.min;
  return A.pat < B.pat;
}
function noteBackendVersion(v, uiVer) {
  if (!v) return { ok: false, reason: 'missing' };
  if (appVerLt(v, uiVer)) return { ok: false, reason: 'older', backend: v };
  return { ok: true, backend: v };
}

const uiVer = pkg.version;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

console.log('[stale-backend] handshake');
const julyRailway = {
  groqConfigured: true,
  sharedKeysConfigured: true,
  provider: 'groq',
  // no appVersion — this is the live taraweeh.up.railway.app payload
};
check('July Railway status is flagged', noteBackendVersion(julyRailway.appVersion, uiVer).reason === 'missing');
check('current backend is accepted', noteBackendVersion(uiVer, uiVer).ok === true);
check('older backend is flagged', noteBackendVersion('2.6.7', uiVer).reason === 'older');
check('newer backend is accepted', noteBackendVersion('9.9.9', uiVer).ok === true);

console.log('[stale-backend] Groq model override');
const captured = {};
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  captured.url = String(url);
  captured.body = opts?.body;
  return {
    ok: true,
    json: async () => ({ text: 'بسم الله', words: [] }),
    headers: { get: () => null },
  };
};
try {
  const pcm = Buffer.alloc(16000 * 2);
  await transcribeWithGroq(pcm, 'gsk_test', null, { model: 'whisper-large-v3' });
  const modelField = captured.body && typeof captured.body.get === 'function'
    ? captured.body.get('model')
    : null;
  check('Groq form uses extra.model', modelField === 'whisper-large-v3', String(modelField));
} catch (err) {
  check('Groq model override ran', false, err.message);
} finally {
  globalThis.fetch = origFetch;
}

if (failed) {
  console.error(`[stale-backend] ${failed} check(s) failed`);
  process.exit(1);
}
console.log('[stale-backend] all checks passed');
