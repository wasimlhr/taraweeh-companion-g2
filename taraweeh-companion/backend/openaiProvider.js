/**
 * OpenAI Whisper API provider — sends WAV audio to OpenAI's whisper-1 endpoint.
 * No RPM-level rate limits on standard tiers; pay-per-use (~$0.006/min audio).
 *
 * Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 */
import { pcmToWav } from './pcmToWav.js';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_MODEL = 'whisper-1';

/**
 * @param {Buffer} pcmBuffer    - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey       - User's OpenAI API key (sk-...)
 * @param {Function} [emit]     - status callback
 * @returns {Promise<{text: string, words: Array, provider: 'openai'}>}
 */
export async function transcribeWithOpenAI(pcmBuffer, apiKey, emit = null) {
  if (!apiKey) {
    throw new Error('OpenAI API key missing. Set it in app settings.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  const form = new FormData();
  const blob = new Blob([wav], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model', OPENAI_MODEL);
  form.append('language', 'ar');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');

  emit?.({ component: 'model', status: 'pending', provider: 'openai' });

  const t0 = Date.now();
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`;
    const retryAfterHdr = res.headers.get('retry-after') || '';
    let retryAfterSec = parseInt(retryAfterHdr, 10);
    if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
      const m = body.match(/try again in\s+(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
      if (m) retryAfterSec = Math.ceil((parseInt(m[1] || '0', 10) * 60) + parseFloat(m[2]));
    }
    const err = new Error(msg);
    err.status = res.status;
    err.retryAfterMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0) ? retryAfterSec * 1000 : 0;
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

  console.log(`[OpenAI] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'openai' };
}
