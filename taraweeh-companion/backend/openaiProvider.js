/**
 * OpenAI transcription API — default gpt-4o-mini-transcribe (faster, cheaper).
 * whisper-1 is the only OpenAI model that returns word timestamps.
 *
 * Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 */
import { pcmToWav } from './pcmToWav.js';
import { httpError } from './httpRetry.js';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const supportsTimestamps = (model) => !/^gpt-/.test(model);

/**
 * @param {Buffer} pcmBuffer    - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey       - User's OpenAI API key (sk-...)
 * @param {Function} [emit]     - status callback
 * @param {{ prompt?: string, model?: string }} [extra]
 * @returns {Promise<{text: string, words: Array, provider: 'openai'}>}
 */
export async function transcribeWithOpenAI(pcmBuffer, apiKey, emit = null, extra = {}) {
  if (!apiKey) {
    throw new Error('OpenAI API key missing. Set it in app settings.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  const form = new FormData();
  const blob = new Blob([wav], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  const useModel = extra.model || OPENAI_MODEL;
  const wantTimestamps = supportsTimestamps(useModel);
  form.append('model', useModel);
  form.append('language', 'ar');
  form.append('response_format', wantTimestamps ? 'verbose_json' : 'json');
  if (wantTimestamps) {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
  form.append('temperature', '0');
  if (extra.prompt) form.append('prompt', extra.prompt);

  emit?.({ component: 'model', status: 'pending', provider: 'openai' });

  const t0 = Date.now();
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = httpError('OpenAI', res, body);
    emit?.({ component: 'model', status: 'error', provider: 'openai', message: body.slice(0, 100), retryAfterMs: err.retryAfterMs, httpStatus: res.status });
    throw err;
  }

  const data = await res.json();
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready', provider: 'openai', latencyMs });
  const text = (data.text || '').trim();

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

  console.log(`[OpenAI:${useModel}] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'openai' };
}
