/**
 * OpenAI Whisper API provider — sends WAV audio to OpenAI's whisper-1 endpoint.
 * No RPM-level rate limits on standard tiers; pay-per-use (~$0.006/min audio).
 *
 * Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 */
import { pcmToWav } from './pcmToWav.js';

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
// gpt-4o-mini-transcribe is the default: measured on real recitations it is
// ~3x faster than whisper-1 (366-455ms vs 1249-1854ms), half the price
// ($0.003 vs $0.006/min) and tracked at least as well. It does not return word
// timestamps — the gpt-4o-* models reject verbose_json with HTTP 400 — but the
// display timer re-phases from the transcript text rather than from timestamps,
// so tracking holds. whisper-1 remains selectable for word-timestamp output.
const OPENAI_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
// Only the legacy Whisper path supports verbose_json and timestamp granularities.
const supportsTimestamps = (model) => !/^gpt-/.test(model);

/**
 * @param {Buffer} pcmBuffer    - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey       - User's OpenAI API key (sk-...)
 * @param {Function} [emit]     - status callback
 * @returns {Promise<{text: string, words: Array, provider: 'openai'}>}
 */
export async function transcribeWithOpenAI(pcmBuffer, apiKey, emit = null, model = '') {
  if (!apiKey) {
    throw new Error('OpenAI API key missing. Set it in app settings.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  const form = new FormData();
  const blob = new Blob([wav], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  const useModel = model || OPENAI_MODEL;
  const wantTimestamps = supportsTimestamps(useModel);
  form.append('model', useModel);
  form.append('language', 'ar');
  form.append('response_format', wantTimestamps ? 'verbose_json' : 'json');
  if (wantTimestamps) {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
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

  console.log(`[OpenAI:${useModel}] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'openai' };
}
