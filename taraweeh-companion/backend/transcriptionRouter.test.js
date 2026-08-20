import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from './pcmToWav.js';
import { parseRetryAfterMs, isRetryableStatus, httpError } from './httpRetry.js';
import { collectKeys, failoverAvailable, transcribe, compareProviders, _resetCooldownsForTests, STT_CHAIN } from './transcriptionRouter.js';

describe('pcmToWav', () => {
  it('writes a 44-byte WAV header plus PCM', () => {
    const pcm = Buffer.alloc(3200, 1);
    const wav = pcmToWav(pcm, 16000);
    assert.equal(wav.length, 3244);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  });
});

describe('httpRetry', () => {
  it('parses Retry-After seconds', () => {
    const res = { headers: { get: () => '12' } };
    assert.equal(parseRetryAfterMs(res, ''), 12000);
  });
  it('parses try-again body text', () => {
    const res = { headers: { get: () => '' } };
    assert.equal(parseRetryAfterMs(res, 'Please try again in 1m5s'), 65000);
  });
  it('marks 429/503 as retryable', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(401), false);
    const err = httpError('Groq', { status: 429, headers: { get: () => '8' } }, 'rate limit');
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 8000);
  });
});

describe('collectKeys / failover', () => {
  it('prefers BYOK keys over empty shared mode', () => {
    const keys = collectKeys({
      provider: 'groq',
      groqApiKey: 'gsk_a',
      deepgramApiKey: 'dg_a',
    });
    assert.equal(keys.groq, 'gsk_a');
    assert.equal(keys.deepgram, 'dg_a');
    assert.equal(keys.openai, '');
    assert.equal(failoverAvailable({ groqApiKey: 'gsk_a', deepgramApiKey: 'dg_a' }), true);
    assert.equal(failoverAvailable({ groqApiKey: 'gsk_a' }), false);
  });
  it('exposes the STT chain in failover order', () => {
    assert.deepEqual(STT_CHAIN, ['groq', 'deepgram', 'elevenlabs', 'openai']);
  });
});

describe('transcribe failover', () => {
  it('fails over from Groq 429 to Deepgram', async () => {
    _resetCooldownsForTests();
    const groqCalls = { n: 0 };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        groqCalls.n++;
        return {
          ok: false,
          status: 429,
          headers: { get: () => '5' },
          text: async () => 'rate limit',
          json: async () => ({}),
        };
      }
      if (u.includes('api.deepgram.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '' },
          json: async () => ({
            results: { channels: [{ alternatives: [{ transcript: 'بسم الله', words: [{ word: 'بسم', start: 0, end: 0.4 }] }] }] },
          }),
        };
      }
      throw new Error('unexpected url ' + u);
    });
    try {
      const pcm = Buffer.alloc(3200, 0);
      const result = await transcribe(pcm, {
        provider: 'auto',
        groqApiKey: 'gsk_test',
        deepgramApiKey: 'dg_test',
      });
      assert.equal(result.provider, 'deepgram');
      assert.equal(result.text, 'بسم الله');
      assert.equal(groqCalls.n, 1);
    } finally {
      globalThis.fetch = origFetch;
      _resetCooldownsForTests();
    }
  });

  it('compareProviders returns per-engine results', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '' },
          json: async () => ({ text: 'from groq', words: [] }),
        };
      }
      if (u.includes('api.deepgram.com')) {
        return {
          ok: false,
          status: 401,
          headers: { get: () => '' },
          text: async () => 'bad key',
          json: async () => ({}),
        };
      }
      throw new Error('unexpected url ' + u);
    });
    try {
      const results = await compareProviders(Buffer.alloc(3200), {
        groqApiKey: 'gsk',
        deepgramApiKey: 'dg',
      });
      const groq = results.find((r) => r.provider === 'groq');
      const dg = results.find((r) => r.provider === 'deepgram');
      assert.equal(groq.ok, true);
      assert.equal(groq.text, 'from groq');
      assert.equal(dg.ok, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
