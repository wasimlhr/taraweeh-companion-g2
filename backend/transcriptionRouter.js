/**
 * Transcription router — switches between Whisper and Gemini based on env config.
 * TRANSCRIPTION_PROVIDER=whisper (default) or gemini
 */
import { transcribeWithWhisper } from './whisperProvider.js';
import { transcribeWithGemini, closeGeminiSession } from './geminiProvider.js';

export const PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'whisper';

console.log(`[Transcription] Using provider: ${PROVIDER}`);

/**
 * Transcribe a PCM audio chunk to Arabic text.
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @param {object|string} [whisperOpts] - { provider, endpointUrl, apiKey, modalKey, modalSecret } or legacy hfToken string
 * @param {Function} [emit] - Status callback
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function transcribe(pcmBuffer, whisperOpts, emit = null) {
  switch (PROVIDER) {
    case 'gemini':
      return transcribeWithGemini(pcmBuffer);
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
