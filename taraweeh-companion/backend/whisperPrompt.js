/**
 * Whisper `prompt` for Quranic recitation.
 * Groq and OpenAI both honour OpenAI's transcription prompt: same language as
 * the audio, used as vocabulary / continuation bias — not as an instruction.
 */

export const QURAN_WHISPER_PROMPT =
  'القرآن الكريم. تلاوة. بسم الله الرحمن الرحيم الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين.';

const PROMPT_MAX_CHARS = 400;

/**
 * @param {{ lastTranscript?: string, ayahText?: string }} [opts]
 * @returns {string}
 */
export function buildWhisperPrompt(opts = {}) {
  const parts = [QURAN_WHISPER_PROMPT];
  const ayah = String(opts.ayahText || '').trim();
  const last = String(opts.lastTranscript || '').trim();
  if (ayah) parts.push(ayah);
  if (last && last !== ayah) parts.push(last);
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, PROMPT_MAX_CHARS);
}
