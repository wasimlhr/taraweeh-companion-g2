/**
 * Deepgram provider — sends WAV audio to Deepgram's pre-recorded listen endpoint.
 *
 * Returns word-level timestamps natively, which the display pacing relies on.
 * Arabic is served by `nova-3` (with `language=ar`) and by Deepgram's hosted
 * `whisper-large`; `nova-2` and `base` reject Arabic outright.
 *
 * Docs: https://developers.deepgram.com/reference/pre-recorded
 */
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';

/**
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @param {string} apiKey    - Deepgram API key
 * @param {Function} [emit]  - status callback
 * @returns {Promise<{text: string, words: Array, provider: 'deepgram'}>}
 */
export async function transcribeWithDeepgram(pcmBuffer, apiKey, emit = null, model = '') {
  if (!apiKey) {
    throw new Error('Deepgram API key missing. Set it in app settings.');
  }

  // Deepgram accepts raw PCM directly when told the encoding, which avoids
  // building a WAV header on every request.
  const params = new URLSearchParams({
    model: model || DEEPGRAM_MODEL,
    language: 'ar',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'false',
    smart_format: 'false',
  });

  emit?.({ component: 'model', status: 'pending', provider: 'deepgram' });

  const t0 = Date.now();
  const res = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/raw' },
    body: pcmBuffer,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const msg = `Deepgram HTTP ${res.status}: ${body.slice(0, 200)}`;
    const retryAfterSec = parseInt(res.headers.get('retry-after') || '', 10);
    const err = new Error(msg);
    err.status = res.status;
    err.retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    emit?.({
      component: 'model', status: 'error', provider: 'deepgram',
      message: body.slice(0, 100), retryAfterMs: err.retryAfterMs, httpStatus: res.status,
    });
    throw err;
  }

  const data = await res.json();
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready', provider: 'deepgram', latencyMs });

  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  const text = (alt?.transcript || '').trim();
  const words = [];
  for (const w of alt?.words || []) {
    if (w && w.word) words.push({ word: String(w.word).trim(), start: +w.start, end: +w.end });
  }

  console.log(`[Deepgram] ${latencyMs}ms  model=${model || DEEPGRAM_MODEL}  pcm=${pcmBuffer.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'deepgram' };
}
