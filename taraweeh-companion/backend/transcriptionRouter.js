/**
 * Transcription router — Groq and OpenAI are independent engines.
 * Deepgram / ElevenLabs remain optional selectable engines (never backups).
 *
 * Default provider: TRANSCRIPTION_PROVIDER=groq
 * Per-session override: whisperOpts.provider + per-provider keys, or sharedMode.
 */
import { transcribeWithWhisper } from './whisperProvider.js';
import { transcribeWithGemini, closeGeminiSession } from './geminiProvider.js';
import { transcribeWithGroq } from './groqProvider.js';
import { transcribeWithOpenAI } from './openaiProvider.js';
import { transcribeWithDeepgram, probeDeepgramKey } from './deepgramProvider.js';
import { transcribeWithElevenLabs, probeElevenLabsKey } from './elevenlabsProvider.js';

export const PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'groq').toLowerCase();
export const STT_ENGINES = ['groq', 'openai', 'deepgram', 'elevenlabs'];
/** @deprecated use STT_ENGINES — kept so older imports do not break */
export const STT_CHAIN = STT_ENGINES;

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

/**
 * Pick exactly one engine. `auto` / `shared` resolve to the first configured
 * engine (Groq, then OpenAI) — still a single engine, never a failover chain.
 */
export function resolveProvider(requested, keys = {}) {
  const req = String(requested || PROVIDER || 'groq').toLowerCase();
  if (req === 'gemini' || req === 'whisper') return req;
  if (STT_ENGINES.includes(req) && req !== 'auto') return req;
  for (const name of ['groq', 'openai', 'deepgram', 'elevenlabs']) {
    if (keys[name]) return name;
  }
  return 'groq';
}

function engineLabel(name) {
  return name === 'groq' ? 'Groq'
    : name === 'openai' ? 'OpenAI'
    : name === 'deepgram' ? 'Deepgram'
    : name === 'elevenlabs' ? 'ElevenLabs'
    : name;
}

async function callProvider(name, pcmBuffer, apiKey, emit, extra = {}) {
  switch (name) {
    case 'groq':
      return transcribeWithGroq(pcmBuffer, apiKey, emit, extra);
    case 'deepgram':
      return transcribeWithDeepgram(pcmBuffer, apiKey, emit, extra);
    case 'elevenlabs':
      return transcribeWithElevenLabs(pcmBuffer, apiKey, emit);
    case 'openai':
      return transcribeWithOpenAI(pcmBuffer, apiKey, emit, extra);
    default:
      throw new Error(`Unknown STT provider: ${name}`);
  }
}

/**
 * Transcribe a PCM audio chunk with exactly one selected engine.
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
  const name = resolveProvider(opts.provider, keys);
  const apiKey = keys[name] || '';
  if (!apiKey) {
    throw new Error(`${engineLabel(name)} API key missing. Add it in Settings, or set SHARED_${name.toUpperCase()}_KEY.`);
  }

  const extra = {};
  if (opts.prompt) extra.prompt = opts.prompt;
  if (opts.model) extra.model = opts.model;
  return callProvider(name, pcmBuffer, apiKey, emit, extra);
}

export async function compareProviders(pcmBuffer, whisperOpts, emit = null) {
  const keys = collectKeys(whisperOpts || {});
  const jobs = STT_ENGINES.filter((p) => keys[p]).map(async (name) => {
    const t0 = Date.now();
    try {
      const result = await callProvider(name, pcmBuffer, keys[name], emit, {});
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
