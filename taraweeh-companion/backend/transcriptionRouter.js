/**
 * Transcription router — Groq / Deepgram / ElevenLabs / OpenAI with sticky failover.
 *
 * Default provider is env-configured: TRANSCRIPTION_PROVIDER=auto (default),
 * groq, deepgram, elevenlabs, openai, gemini, or whisper.
 *
 * Per-session override: whisperOpts.provider + per-provider keys, or sharedMode.
 */
import { transcribeWithWhisper } from './whisperProvider.js';
import { transcribeWithGemini, closeGeminiSession } from './geminiProvider.js';
import { transcribeWithGroq } from './groqProvider.js';
import { transcribeWithOpenAI } from './openaiProvider.js';
import { transcribeWithDeepgram, probeDeepgramKey } from './deepgramProvider.js';
import { transcribeWithElevenLabs, probeElevenLabsKey } from './elevenlabsProvider.js';
import { isRetryableStatus } from './httpRetry.js';

export const PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'auto').toLowerCase();
export const STT_CHAIN = ['groq', 'deepgram', 'elevenlabs', 'openai'];

const cooldowns = new Map(); // provider -> untilMs

console.log(`[Transcription] Default provider: ${PROVIDER}`);

export function sharedKeyAvailability() {
  return {
    groq: !!(process.env.SHARED_GROQ_KEY || '').trim(),
    openai: !!(process.env.SHARED_OPENAI_KEY || '').trim(),
    deepgram: !!(process.env.SHARED_DEEPGRAM_KEY || '').trim(),
    elevenlabs: !!(process.env.SHARED_ELEVENLABS_KEY || '').trim(),
  };
}

export function collectKeys(whisperOpts = {}) {
  const opts = (whisperOpts && typeof whisperOpts === 'object') ? whisperOpts : {};
  const shared = {
    groq: (process.env.SHARED_GROQ_KEY || '').trim(),
    openai: (process.env.SHARED_OPENAI_KEY || '').trim(),
    deepgram: (process.env.SHARED_DEEPGRAM_KEY || '').trim(),
    elevenlabs: (process.env.SHARED_ELEVENLABS_KEY || '').trim(),
  };
  const byok = {
    groq: (opts.groqApiKey || (opts.provider === 'groq' ? opts.apiKey : '') || '').trim(),
    openai: (opts.openaiApiKey || (opts.provider === 'openai' ? opts.apiKey : '') || '').trim(),
    deepgram: (opts.deepgramApiKey || (opts.provider === 'deepgram' ? opts.apiKey : '') || '').trim(),
    elevenlabs: (opts.elevenlabsApiKey || (opts.provider === 'elevenlabs' ? opts.apiKey : '') || '').trim(),
  };
  if (opts.sharedMode) {
    return {
      groq: byok.groq || shared.groq,
      openai: byok.openai || shared.openai,
      deepgram: byok.deepgram || shared.deepgram,
      elevenlabs: byok.elevenlabs || shared.elevenlabs,
    };
  }
  return byok;
}

export function failoverAvailable(whisperOpts = {}) {
  const keys = collectKeys(whisperOpts);
  return STT_CHAIN.filter((p) => keys[p]).length >= 2;
}

function isCooling(provider) {
  const until = cooldowns.get(provider) || 0;
  return until > Date.now();
}

function setCooldown(provider, retryAfterMs) {
  const wait = Math.max(5000, Math.min(retryAfterMs || 15000, 60000));
  cooldowns.set(provider, Date.now() + wait);
  return wait;
}

export function _resetCooldownsForTests() {
  cooldowns.clear();
}

function buildChain(preferred) {
  const start = STT_CHAIN.includes(preferred) ? preferred : 'groq';
  return [start, ...STT_CHAIN.filter((p) => p !== start)];
}

function shouldRetry(err) {
  if (!err) return false;
  if (err.retryable) return true;
  if (isRetryableStatus(err.status)) return true;
  return /HTTP 429|rate.?limit|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message || '');
}

async function callProvider(name, pcmBuffer, apiKey, emit) {
  switch (name) {
    case 'groq':
      return transcribeWithGroq(pcmBuffer, apiKey, emit);
    case 'deepgram':
      return transcribeWithDeepgram(pcmBuffer, apiKey, emit);
    case 'elevenlabs':
      return transcribeWithElevenLabs(pcmBuffer, apiKey, emit);
    case 'openai':
      return transcribeWithOpenAI(pcmBuffer, apiKey, emit);
    default:
      throw new Error(`Unknown STT provider: ${name}`);
  }
}

/**
 * Transcribe a PCM audio chunk to Arabic text with sticky failover.
 *
 * @param {Buffer} pcmBuffer
 * @param {object|string} [whisperOpts]
 * @param {Function} [emit]
 */
export async function transcribe(pcmBuffer, whisperOpts, emit = null) {
  const opts = (whisperOpts && typeof whisperOpts === 'object') ? whisperOpts : {};

  if (opts.provider === 'gemini' || PROVIDER === 'gemini') {
    return transcribeWithGemini(pcmBuffer);
  }
  if (opts.provider === 'whisper' || PROVIDER === 'whisper') {
    return transcribeWithWhisper(pcmBuffer, whisperOpts, emit);
  }

  const keys = collectKeys(opts);
  const requested = String(opts.provider || PROVIDER || 'auto').toLowerCase();
  const preferred = (requested === 'auto' || requested === 'shared')
    ? (opts._stickyProvider || 'groq')
    : requested;
  const chain = buildChain(preferred).filter((p) => keys[p]);

  if (!chain.length) {
    throw new Error('No transcription API key configured. Add Groq, Deepgram, ElevenLabs, or OpenAI in Settings, or set a SHARED_*_KEY env var.');
  }

  const ready = chain.filter((p) => !isCooling(p));
  const order = ready.length ? ready : chain;

  const errors = [];
  for (const name of order) {
    if (isCooling(name) && order.length > 1) {
      console.log(`[Transcription] Skipping ${name} (cooldown)`);
      continue;
    }
    try {
      const result = await callProvider(name, pcmBuffer, keys[name], emit);
      opts._stickyProvider = name;
      return result;
    } catch (err) {
      errors.push(err);
      if (shouldRetry(err) && order.length > 1) {
        const wait = setCooldown(name, err.retryAfterMs);
        console.log(`[Transcription] ${name} failed (${err.status || err.message}) — failover in ${Math.round(wait / 1000)}s cooldown`);
        emit?.({
          component: 'model',
          status: 'error',
          provider: name,
          message: `failing over (${err.status || 'error'})`,
          retryAfterMs: wait,
          httpStatus: err.status || 0,
          failover: true,
        });
        continue;
      }
      // Auth errors on a specifically chosen BYOK provider should surface.
      if (requested === name && requested !== 'auto' && !opts.sharedMode) {
        throw err;
      }
      if (order.length > 1) {
        console.log(`[Transcription] ${name} error — trying next provider: ${err.message?.slice(0, 80)}`);
        continue;
      }
      throw err;
    }
  }

  const last = errors[errors.length - 1];
  throw last || new Error('All transcription providers failed or are rate-limited');
}

export async function compareProviders(pcmBuffer, whisperOpts, emit = null) {
  const keys = collectKeys(whisperOpts || {});
  const jobs = STT_CHAIN.filter((p) => keys[p]).map(async (name) => {
    const t0 = Date.now();
    try {
      const result = await callProvider(name, pcmBuffer, keys[name], emit);
      return {
        provider: name,
        ok: true,
        latencyMs: Date.now() - t0,
        text: result.text || '',
        wordCount: (result.words || []).length,
      };
    } catch (err) {
      return {
        provider: name,
        ok: false,
        latencyMs: Date.now() - t0,
        error: err.message || String(err),
        httpStatus: err.status || 0,
      };
    }
  });
  return Promise.all(jobs);
}

export async function probeProviderKey(provider, apiKey) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('API key missing');
  switch (provider) {
    case 'groq': {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const data = await res.json();
      return { ok: true, models: (data.data || []).length };
    }
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const data = await res.json();
      return { ok: true, models: (data.data || []).length };
    }
    case 'deepgram':
      return probeDeepgramKey(key);
    case 'elevenlabs':
      return probeElevenLabsKey(key);
    default:
      throw new Error(`Cannot probe provider: ${provider}`);
  }
}

export async function closeTranscription() {
  if (PROVIDER === 'gemini') {
    await closeGeminiSession();
  }
}
