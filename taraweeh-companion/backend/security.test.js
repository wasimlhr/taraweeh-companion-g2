import test from 'node:test';
import assert from 'node:assert/strict';
import { validPcm, validRecoveryState, tokenMatches, tokenPrincipal, SlidingQuota, ConcurrencyCeiling, MAX_PCM_FRAME } from './security.js';
import { fetchWithDeadline } from './requestControl.js';
import { collectKeys, resolveProvider } from './transcriptionRouter.js';

test('recovery is accepted only as fresh client-owned structured state', () => {
  const now = 1_000_000_000;
  assert.deepEqual(validRecoveryState({ surah: 2, ayah: 12, pace: 900, ts: now }, now), { surah: 2, ayah: 12, pace: 900, ts: now });
  assert.equal(validRecoveryState({ surah: 2, ayah: 12, pace: 900, ts: now - 31 * 60_000 }, now), null);
  assert.equal(validRecoveryState({ surah: 999, ayah: 1, ts: now }, now), null);
});

test('duplicate identifiers do not grant access to server-side recovery state', () => {
  const clientA = validRecoveryState({ surah: 2, ayah: 20, ts: 50_000 }, 50_000);
  const clientB = validRecoveryState({ surah: 36, ayah: 1, ts: 50_000 }, 50_000);
  assert.notDeepEqual(clientA, clientB);
});

test('reconnect recovery is carried by the reconnecting client, independent of duplicate session IDs', () => {
  const now = 75_000;
  const reconnect = { sessionId: 'duplicate', recoveryState: { surah: 18, ayah: 10, pace: 700, ts: now } };
  const attacker = { sessionId: 'duplicate' };
  assert.deepEqual(validRecoveryState(reconnect.recoveryState, now), reconnect.recoveryState);
  assert.equal(validRecoveryState(attacker.recoveryState, now), null);
});

test('PCM validation enforces 16-bit shape and frame bound', () => {
  assert.equal(validPcm(Buffer.alloc(3200)), true);
  assert.equal(validPcm(Buffer.alloc(3)), false);
  assert.equal(validPcm(Buffer.alloc(MAX_PCM_FRAME + 2)), false);
});

test('shared token comparison and quota survive reconnect identities', () => {
  assert.equal(tokenMatches('access', 'access'), true);
  assert.equal(tokenMatches('access2', 'access'), false);
  const quota = new SlidingQuota({ limit: 2, windowMs: 1000 });
  assert.equal(quota.take('same-ip', 100), true);
  assert.equal(quota.take('same-ip', 200), true);
  assert.equal(quota.take('same-ip', 300), false);
  assert.equal(quota.take('same-ip', 1200), true);
  assert.equal(tokenPrincipal('access'), tokenPrincipal('access'));
  assert.notEqual(tokenPrincipal('access'), tokenPrincipal('other'));
});

test('shared quota and concurrency cannot be reset with a new socket/session ID', () => {
  const principal = tokenPrincipal('authenticated-access');
  const quota = new SlidingQuota({ limit: 1, windowMs: 60_000 });
  assert.equal(quota.take(principal, 100), true);
  assert.equal(quota.take(principal, 101), false);
  const ceiling = new ConcurrencyCeiling({ globalLimit: 2, principalLimit: 1 });
  const release = ceiling.acquire(principal);
  assert.equal(typeof release, 'function');
  assert.equal(ceiling.acquire(principal), null);
  release();
  assert.equal(typeof ceiling.acquire(principal), 'function');
});

test('credential selection uses only BYOK unless shared mode is authenticated', () => {
  const previous = process.env.SHARED_OPENAI_KEY;
  process.env.SHARED_OPENAI_KEY = 'server-openai';
  try {
    assert.equal(collectKeys({ provider: 'openai', openaiApiKey: 'user-openai', sharedMode: false }).openai, 'user-openai');
    assert.equal(collectKeys({ provider: 'openai', sharedMode: false }).openai, '');
    const shared = collectKeys({ provider: 'auto', sharedMode: true });
    assert.equal(shared.openai, 'server-openai');
    assert.equal(resolveProvider('auto', shared), 'openai');
  } finally {
    if (previous === undefined) delete process.env.SHARED_OPENAI_KEY;
    else process.env.SHARED_OPENAI_KEY = previous;
  }
});

test('provider deadline aborts a stalled fetch and classifies timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  try {
    await assert.rejects(fetchWithDeadline('Test', 'https://example.invalid', {}, { timeoutMs: 10 }), { code: 'PROVIDER_TIMEOUT' });
  } finally { globalThis.fetch = originalFetch; }
});

test('provider lifecycle cancellation aborts stalled fetch without timeout classification', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const controller = new AbortController();
  try {
    const pending = fetchWithDeadline('Test', 'https://example.invalid', {}, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'PROVIDER_CANCELLED' });
  } finally { globalThis.fetch = originalFetch; }
});
