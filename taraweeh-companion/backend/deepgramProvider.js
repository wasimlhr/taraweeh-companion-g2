/**
 * Deepgram Nova-3 Arabic STT — pre-recorded listen API.
 * Docs: https://developers.deepgram.com/docs/models-languages-overview
 */
import { pcmToWav } from './pcmToWav.js';
import { httpError } from './httpRetry.js';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&language=ar&smart_format=true&punctuate=false&utterances=false';

/**
 * @param {Buffer} pcmBuffer
 * @param {string} apiKey
 * @param {Function} [emit]
 * @returns {Promise<{text: string, words: Array, provider: 'deepgram'}>}
 */
export async function transcribeWithDeepgram(pcmBuffer, apiKey, emit = null) {
  if (!apiKey) {
    throw new Error('Deepgram API key missing. Set it in app settings or SHARED_DEEPGRAM_KEY.');
  }

  const wav = pcmToWav(pcmBuffer, 16000);
  emit?.({ component: 'model', status: 'pending', provider: 'deepgram' });

  const t0 = Date.now();
  const res = await fetch(DEEPGRAM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  });

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

  console.log(`[Deepgram] ${latencyMs}ms  wav=${wav.length}B  words=${words.length}  text="${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
  return { text, words, provider: 'deepgram' };
}

export async function probeDeepgramKey(apiKey) {
  const res = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw httpError('Deepgram', res, body);
  let projects = 0;
  try { projects = JSON.parse(body)?.projects?.length || 0; } catch { /* ignore */ }
  return { ok: true, projects };
}
