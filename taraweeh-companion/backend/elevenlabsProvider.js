/**
 * ElevenLabs Scribe v2 speech-to-text.
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */
import { pcmToWav } from './pcmToWav.js';
import { httpError } from './httpRetry.js';
import { providerDeadline } from './requestDeadline.js';

const ELEVEN_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVEN_MODEL = 'scribe_v2';

/**
 * @param {Buffer} pcmBuffer
 * @param {string} apiKey
 * @param {Function} [emit]
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [extra]
 * @returns {Promise<{text: string, words: Array, provider: 'elevenlabs'}>}
 */
export async function transcribeWithElevenLabs(pcmBuffer, apiKey, emit = null, extra = {}) {
  if (!apiKey) {
    throw new Error('ElevenLabs API key missing. Set it in app settings or SHARED_ELEVENLABS_KEY.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  const form = new FormData();
  const blob = new Blob([wav], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model_id', ELEVEN_MODEL);
  form.append('language_code', 'ara');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');

  emit?.({ component: 'model', status: 'pending', provider: 'elevenlabs' });

  const t0 = Date.now();
  const deadline = providerDeadline(extra);
  let data;
  try {
    const res = await fetch(ELEVEN_URL, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: deadline.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = httpError('ElevenLabs', res, body);
      emit?.({
        component: 'model',
        status: 'error',
        provider: 'elevenlabs',
        message: body.slice(0, 100),
        retryAfterMs: err.retryAfterMs,
        httpStatus: res.status,
      });
      throw err;
    }

    data = await res.json();
  } finally {
    deadline.done();
  }
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready', provider: 'elevenlabs', latencyMs });

  const text = String(data.text || '').trim();
  const words = [];
  if (Array.isArray(data.words)) {
    for (const w of data.words) {
      if (w?.type && w.type !== 'word') continue;
      const word = String(w.text || w.word || '').trim();
      if (!word) continue;
      words.push({ word, start: +w.start || 0, end: +w.end || 0 });
    }
  }

  console.log(`[ElevenLabs] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'elevenlabs' };
}

export async function probeElevenLabsKey(apiKey) {
  const res = await fetch('https://api.elevenlabs.io/v1/user', {
    headers: { 'xi-api-key': apiKey },
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw httpError('ElevenLabs', res, body);
  let email = '';
  try { email = JSON.parse(body)?.email || ''; } catch { /* ignore */ }
  return { ok: true, email };
}
