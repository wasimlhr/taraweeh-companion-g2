/**
 * Deepgram Nova-3 Arabic STT — pre-recorded listen API.
 * Arabic is served by `nova-3` (with `language=ar`) and by Deepgram's hosted
 * `whisper-large`; `nova-2` and `base` reject Arabic outright.
 *
 * Docs: https://developers.deepgram.com/docs/models-languages-overview
 */
import { httpError } from './httpRetry.js';
import { fetchWithDeadline } from './requestControl.js';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';

/**
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey
 * @param {Function} [emit]
 * @param {{ model?: string }} [extra]
 * @returns {Promise<{text: string, words: Array, provider: 'deepgram'}>}
 */
export async function transcribeWithDeepgram(pcmBuffer, apiKey, emit = null, extra = {}) {
  if (!apiKey) {
    throw new Error('Deepgram API key missing. Set it in app settings or SHARED_DEEPGRAM_KEY.');
  }

  const useModel = extra.model || DEEPGRAM_MODEL;
  // Raw PCM avoids building a WAV header on every request.
  const params = new URLSearchParams({
    model: useModel,
    language: 'ar',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'false',
    smart_format: 'false',
  });

  emit?.({ component: 'model', status: 'pending', provider: 'deepgram' });

  const t0 = Date.now();
  const res = await fetchWithDeadline('Deepgram', `${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/raw',
    },
    body: pcmBuffer,
  }, { signal: extra.signal, timeoutMs: extra.timeoutMs });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = httpError('Deepgram', res, body);
    emit?.({
      component: 'model',
      status: 'error',
      provider: 'deepgram',
      message: body.slice(0, 100),
      retryAfterMs: err.retryAfterMs,
      httpStatus: res.status,
    });
    throw err;
  }

  const data = await res.json();
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready', provider: 'deepgram', latencyMs });

  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  const text = String(alt.transcript || '').trim();
  const words = [];
  if (Array.isArray(alt.words)) {
    for (const w of alt.words) {
      const word = String(w.word || w.punctuated_word || '').trim();
      if (!word) continue;
      words.push({ word, start: +w.start || 0, end: +w.end || 0 });
    }
  }

  console.log(`[Deepgram:${useModel}] ${latencyMs}ms  pcm=${pcmBuffer.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'deepgram' };
}

export async function probeDeepgramKey(apiKey, options = {}) {
  const res = await fetchWithDeadline('Deepgram probe', 'https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${apiKey}` },
  }, options);
  const body = await res.text().catch(() => '');
  if (!res.ok) throw httpError('Deepgram', res, body);
  let projects = 0;
  try { projects = JSON.parse(body)?.projects?.length || 0; } catch { /* ignore */ }
  return { ok: true, projects };
}
