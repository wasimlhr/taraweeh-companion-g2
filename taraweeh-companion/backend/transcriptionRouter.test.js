import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from './pcmToWav.js';
import { parseRetryAfterMs, isRetryableStatus, httpError } from './httpRetry.js';
import { collectKeys, resolveProvider, transcribe, compareProviders, STT_ENGINES } from './transcriptionRouter.js';
import { buildWhisperPrompt, stripWhisperPromptEcho } from './whisperPrompt.js';
import { loadQuran } from './keywordMatcher.js';
import { createState, processWhisperResult } from './anchorStateMachine.js';

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

describe('whisperPrompt', () => {
  it('uses last transcript only — does not quote Fatiha or تلاوة', () => {
    const prompt = buildWhisperPrompt({ lastTranscript: 'الحمد لله رب العالمين' });
    assert.equal(prompt, 'الحمد لله رب العالمين');
    assert.equal(prompt.includes('تلاوة'), false);
    assert.equal(buildWhisperPrompt({}), '');
  });
  it('strips Groq prompt-echo so quiet audio cannot lock Fatiha', () => {
    assert.equal(stripWhisperPromptEcho('تلاوة. بسم الله الرحمن الرحيم.'), 'بسم الله الرحمن الرحيم.');
    assert.equal(stripWhisperPromptEcho('تلاوة.'), '');
    assert.equal(stripWhisperPromptEcho('القرآن الكريم. تلاوة. بسم الله الرحمن الرحيم.'), 'بسم الله الرحمن الرحيم.');
  });
});

describe('collectKeys / resolveProvider', () => {
  it('prefers BYOK keys over empty shared mode', () => {
    const keys = collectKeys({
      provider: 'groq',
      groqApiKey: 'gsk_a',
      openaiApiKey: 'sk_a',
    });
    assert.equal(keys.groq, 'gsk_a');
    assert.equal(keys.openai, 'sk_a');
    assert.equal(keys.deepgram, '');
  });
  it('lists independent engines with Groq and OpenAI first', () => {
    assert.deepEqual(STT_ENGINES, ['groq', 'openai', 'deepgram', 'elevenlabs']);
  });
  it('auto picks Groq when both Groq and OpenAI keys exist — never a chain', () => {
    assert.equal(resolveProvider('auto', { groq: 'gsk', openai: 'sk' }), 'groq');
    assert.equal(resolveProvider('openai', { groq: 'gsk', openai: 'sk' }), 'openai');
    assert.equal(resolveProvider('groq', { groq: 'gsk', openai: 'sk' }), 'groq');
  });
});

describe('transcribe is independent', () => {
  it('uses only Groq even when OpenAI is also configured', async () => {
    const openaiCalls = { n: 0 };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '' },
          json: async () => ({ text: 'الحمد لله رب العالمين', words: [] }),
        };
      }
      if (u.includes('api.openai.com')) {
        openaiCalls.n++;
        throw new Error('OpenAI must not be called');
      }
      throw new Error('unexpected url ' + u);
    });
    try {
      const result = await transcribe(Buffer.alloc(3200), {
        provider: 'groq',
        groqApiKey: 'gsk_test',
        openaiApiKey: 'sk_test',
      });
      assert.equal(result.provider, 'groq');
      assert.equal(result.text, 'الحمد لله رب العالمين');
      assert.equal(openaiCalls.n, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not fall back to OpenAI when Groq returns 429', async () => {
    const openaiCalls = { n: 0 };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.groq.com')) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '5' },
          text: async () => 'rate limit',
          json: async () => ({}),
        };
      }
      if (u.includes('api.openai.com')) {
        openaiCalls.n++;
        return {
          ok: true,
          status: 200,
          headers: { get: () => '' },
          json: async () => ({ text: 'should not run', words: [] }),
        };
      }
      throw new Error('unexpected url ' + u);
    });
    try {
      await assert.rejects(
        () => transcribe(Buffer.alloc(3200), {
          provider: 'groq',
          groqApiKey: 'gsk_test',
          openaiApiKey: 'sk_test',
        }),
        /Groq HTTP 429/,
      );
      assert.equal(openaiCalls.n, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('OpenAI path never calls Groq', async () => {
    const groqCalls = { n: 0 };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      const u = String(url);
      if (u.includes('api.openai.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => '' },
          json: async () => ({ text: 'مالك يوم الدين', words: [] }),
        };
      }
      if (u.includes('api.groq.com')) {
        groqCalls.n++;
        throw new Error('Groq must not be called');
      }
      throw new Error('unexpected url ' + u);
    });
    try {
      const result = await transcribe(Buffer.alloc(3200), {
        provider: 'openai',
        groqApiKey: 'gsk_test',
        openaiApiKey: 'sk_test',
      });
      assert.equal(result.provider, 'openai');
      assert.equal(result.text, 'مالك يوم الدين');
      assert.equal(groqCalls.n, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('compareProviders returns per-engine results without chaining', async () => {
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
      if (u.includes('api.openai.com')) {
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
        openaiApiKey: 'sk',
      });
      const groq = results.find((r) => r.provider === 'groq');
      const oai = results.find((r) => r.provider === 'openai');
      assert.equal(groq.ok, true);
      assert.equal(groq.text, 'from groq');
      assert.equal(oai.ok, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('anchor first-lock speed', () => {
  loadQuran();
  it('locks Al-Fatiha 1:2 on the first distinctive chunk (no second-win wait)', () => {
    const state = createState();
    const next = processWhisperResult('الحمد لله رب العالمين', state, { preferredSurah: 1 });
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 1);
    assert.equal(next.ayah, 2);
  });

  it('Practice uses Taraweeh first-lock on Fatiha 1:2 (no separate matcher)', () => {
    const taraweeh = processWhisperResult('الحمد لله رب العالمين', createState(), {});
    const practice = processWhisperResult('الحمد لله رب العالمين', createState(), { practiceMode: true });
    assert.equal(taraweeh.mode, 'LOCKED');
    assert.equal(practice.mode, 'LOCKED');
    assert.equal(practice.surah, taraweeh.surah);
    assert.equal(practice.ayah, taraweeh.ayah);
    assert.equal(practice.ayah, 2);
  });

  it('Practice jumps to a newly recited verse instead of auto-advancing', () => {
    const locked = processWhisperResult('الحمد لله رب العالمين', createState(), { practiceMode: true });
    assert.equal(locked.mode, 'LOCKED');
    const jumped = processWhisperResult('قل هو الله احد', locked, { practiceMode: true });
    assert.equal(jumped.mode, 'LOCKED');
    assert.equal(jumped.surah, 112);
    assert.equal(jumped.ayah, 1);
  });

  it('Practice stays locked on empty/noise transcripts (no auto-unlock)', () => {
    const locked = processWhisperResult('الحمد لله رب العالمين', createState(), { practiceMode: true });
    assert.equal(locked.mode, 'LOCKED');
    const still = processWhisperResult('', locked, { practiceMode: true });
    assert.equal(still.mode, 'LOCKED');
    assert.equal(still.surah, 1);
    assert.equal(still.ayah, 2);
  });

  it('Practice snaps to the next recited Fatiha ayah (heard verse, not a timer)', () => {
    const locked = processWhisperResult('الحمد لله رب العالمين', createState(), { practiceMode: true });
    const next = processWhisperResult('الرحمن الرحيم', locked, { practiceMode: true });
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 1);
    assert.equal(next.ayah, 3);
  });
});

describe('live Groq Ya-Sin typos (Fatiha lock does not count)', () => {
  loadQuran();

  it('locks Ya-Sin on the exact Groq string ياسين والقرمان الهكيم', () => {
    const next = processWhisperResult('ياسين والقرمان الهكيم', createState(), {});
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 36);
    assert.notEqual(next.surah, 1);
    assert.notEqual(next.surah, 16);
  });

  it('locks Ya-Sin 36:1 on Groq first-chunk يسي', () => {
    const next = processWhisperResult('يسي', createState(), {});
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 36);
    assert.equal(next.ayah, 1);
  });

  it('locks Ya-Sin 36:3 on Groq إن لك للمرسلين', () => {
    const next = processWhisperResult('إن لك للمرسلين', createState(), {});
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 36);
    assert.equal(next.ayah, 3);
  });

  it('still locks Fatiha 1:2 and Ikhlas 112:1 on their live strings', () => {
    const fatiha = processWhisperResult('الحمد لله', createState(), {});
    assert.equal(fatiha.mode, 'LOCKED');
    assert.equal(fatiha.surah, 1);
    assert.equal(fatiha.ayah, 2);
    const ikhlas = processWhisperResult('قل هو الله أهل الله السلام', createState(), {});
    assert.equal(ikhlas.mode, 'LOCKED');
    assert.equal(ikhlas.surah, 112);
    assert.equal(ikhlas.ayah, 1);
  });

  it('does not treat الم as a distinctive opener lock', () => {
    const next = processWhisperResult('الم', createState(), {});
    assert.equal(next.mode, 'SEARCHING');
  });
});

describe('live preamble strip (isti\'adha / bismillah)', () => {
  it('does not lock 16:98 on opening isti\'adha — keeps Ya-Sin tokens', async () => {
    const { prepareMatcherText, isPreambleOnly } = await import('./whisperClean.js');
    loadQuran();
    const t = prepareMatcherText('اعوذ بالله من الشيطان الرجيم ياسين والقران الحكيم');
    assert.equal(isPreambleOnly(t), false);
    const next = processWhisperResult(t, createState(), {});
    assert.equal(next.mode, 'LOCKED');
    assert.equal(next.surah, 36);
    assert.notEqual(next.surah, 16);
    assert.notEqual(next.surah, 1);
  });

  it('treats isti\'adha-only and bismillah-only as preamble, not a verse', async () => {
    const { prepareMatcherText, isPreambleOnly } = await import('./whisperClean.js');
    assert.equal(isPreambleOnly(prepareMatcherText('اعوذ بالله من الشيطان الرجيم')), true);
    assert.equal(isPreambleOnly(prepareMatcherText('بسم الله الرحمن الرحيم')), true);
    const bismillah = processWhisperResult('بسم الله الرحمن الرحيم', createState(), {});
    assert.equal(bismillah.mode, 'SEARCHING');
  });
});
