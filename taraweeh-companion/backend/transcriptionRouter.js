/**
 * Transcription router — switches between Whisper, Gemini, and Groq.
 *
 * Default provider is env-configured: TRANSCRIPTION_PROVIDER=whisper (default), gemini, or groq.
 * Per-session override: caller can pass whisperOpts.provider='groq' with whisperOpts.apiKey
 * to use their own Groq API key without touching server env.
 */
import { transcribeWithWhisper } from './whisperProvider.js';
import { transcribeWithGemini, closeGeminiSession } from './geminiProvider.js';
import { transcribeWithGroq } from './groqProvider.js';
import { transcribeWithOpenAI } from './openaiProvider.js';

export const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'whisper';

console.log(`[Transcription] Default provider: ${PROVIDER}`);

/**
 * Transcribe a PCM audio chunk to Arabic text.
 *
 * Two modes:
 *   1. BYOK — user supplies their own Groq/OpenAI key in `whisperOpts`. No
 *      failover; if their provider 429s, the error bubbles up so they see it.
 *   2. SHARED — no user key, server uses SHARED_GROQ_KEY then falls over to
 *      SHARED_OPENAI_KEY on Groq 429 (rate limit). The failover is per-chunk
 *      and transparent to the pipeline.
 *
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @param {object|string} [whisperOpts] - { provider, apiKey, sharedMode } or legacy hfToken string
 * @param {Function} [emit] - Status callback
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function transcribe(pcmBuffer, whisperOpts, emit = null) {
  // Shared mode: server-held keys, Groq → OpenAI failover on 429.
  if (whisperOpts && typeof whisperOpts === 'object' && whisperOpts.sharedMode) {
    const sharedGroq   = (process.env.SHARED_GROQ_KEY   || '').trim();
    const sharedOpenAI = (process.env.SHARED_OPENAI_KEY || '').trim();
    if (sharedGroq) {
      try {
        return await transcribeWithGroq(pcmBuffer, sharedGroq, emit);
      } catch (err) {
        const is429 = err && (err.status === 429 || /HTTP 429|rate.?limit/i.test(err.message || ''));
        if (is429 && sharedOpenAI) {
          console.log('[Transcription] Shared Groq rate-limited — falling over to OpenAI for this chunk');
          return await transcribeWithOpenAI(pcmBuffer, sharedOpenAI, emit);
        }
        throw err;
      }
    }
    if (sharedOpenAI) {
      // No shared Groq, only OpenAI — use it directly.
      return transcribeWithOpenAI(pcmBuffer, sharedOpenAI, emit);
    }
    throw new Error('Shared mode requested but neither SHARED_GROQ_KEY nor SHARED_OPENAI_KEY env var is set');
  }

  // BYOK — caller-supplied key, no failover.
  if (whisperOpts && typeof whisperOpts === 'object' && whisperOpts.provider === 'groq') {
    return transcribeWithGroq(pcmBuffer, whisperOpts.apiKey, emit);
  }
  if (whisperOpts && typeof whisperOpts === 'object' && whisperOpts.provider === 'openai') {
    return transcribeWithOpenAI(pcmBuffer, whisperOpts.apiKey, emit);
  }

  switch (PROVIDER) {
    case 'gemini':
      return transcribeWithGemini(pcmBuffer);
    case 'groq':
      return transcribeWithGroq(pcmBuffer, process.env.GROQ_API_KEY, emit);
    case 'whisper':
    default:
      return transcribeWithWhisper(pcmBuffer, whisperOpts, emit);
  }
}

export async function closeTranscription() {
  if (PROVIDER === 'gemini') {
    await closeGeminiSession();
  }
}
