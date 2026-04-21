/**
 * Groq Whisper provider — sends WAV audio to Groq's whisper-large-v3-turbo endpoint.
 * Used when user supplies their own Groq API key (free tier: ~6k requests/day).
 *
 * Docs: https://console.groq.com/docs/speech-text
 */
import { pcmToWav } from './pcmToWav.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

/**
 * @param {Buffer} pcmBuffer    - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey       - User's Groq API key (gsk_...)
 * @param {Function} [emit]     - status callback
 * @returns {Promise<{text: string, words: Array, provider: 'groq'}>}
 */
export async function transcribeWithGroq(pcmBuffer, apiKey, emit = null) {
  if (!apiKey) {
    throw new Error('Groq API key missing. Set it in app settings.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  const form = new FormData();
  const blob = new Blob([wav], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model', GROQ_MODEL);
  form.append('language', 'ar');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');   // word-level timestamps for silence / repeat detection
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');

  emit?.({ component: 'model', status: 'pending', provider: 'groq' });

  const t0 = Date.now();
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `Groq HTTP ${res.status}: ${body.slice(0, 200)}`;
    emit?.({ component: 'model', status: 'error', provider: 'groq', message: body.slice(0, 100) });
    throw new Error(msg);
  }

  const data = await res.json();
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready', provider: 'groq', latencyMs });
  const text = (data.text || '').trim();

  // Pull word-level timestamps for pipeline silence / repeat detection.
  // Groq verbose_json returns either top-level data.words or per-segment words.
  const words = [];
  if (Array.isArray(data.words)) {
    for (const w of data.words) {
      if (w && w.word) words.push({ word: String(w.word).trim(), start: +w.start, end: +w.end });
    }
  } else if (Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      if (Array.isArray(seg.words)) {
        for (const w of seg.words) {
          if (w && w.word) words.push({ word: String(w.word).trim(), start: +w.start, end: +w.end });
        }
      }
    }
  }

  console.log(`[Groq] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'groq' };
}

