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
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @param {object|string} [whisperOpts] - { provider, endpointUrl, apiKey, modalKey, modalSecret } or legacy hfToken string
 * @param {Function} [emit] - Status callback
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function transcribe(pcmBuffer, whisperOpts, emit = null) {
  // Per-session provider override (e.g. user supplied their own API key in the app).
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
