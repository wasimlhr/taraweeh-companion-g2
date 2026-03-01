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
 * @param {string} [hfToken] - HuggingFace token override (whisper only)
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function transcribe(pcmBuffer, hfToken, emit = null) {
  switch (PROVIDER) {
    case 'gemini':
      return transcribeWithGemini(pcmBuffer);
    case 'whisper':
    default:
      return transcribeWithWhisper(pcmBuffer, hfToken, emit);
  }
}

export async function closeTranscription() {
  if (PROVIDER === 'gemini') {
    await closeGeminiSession();
  }
}
