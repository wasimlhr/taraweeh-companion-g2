/**
 * Whisper `prompt` for Quranic recitation.
 * Groq/OpenAI treat this as vocabulary / continuation, not an instruction.
 * Do not quote Fatiha or the word "تلاوة" here — on quiet/noisy audio Whisper
 * echoes the prompt as the transcript, which false-locks Practice on 1:1.
 */

const PROMPT_MAX_CHARS = 400;

/**
 * @param {{ lastTranscript?: string, ayahText?: string }} [opts]
 * @returns {string}
 */
export function buildWhisperPrompt(opts = {}) {
  const ayah = String(opts.ayahText || '').trim();
  const last = String(opts.lastTranscript || '').trim();
  const parts = [];
  if (ayah) parts.push(ayah);
  if (last && last !== ayah) parts.push(last);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX_CHARS);
}

/** Drop prompt-echo prefixes Groq sometimes emits on quiet simulator audio. */
export function stripWhisperPromptEcho(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  // Loop: JS \b is ASCII-only, so "القرآن الكريم. تلاوة." needs two prefix strips.
  const prefix = /^(القرآن الكريم|تلاوة)[.،:]?\s*/;
  while (prefix.test(t)) t = t.replace(prefix, '').trim();
  return t;
}
