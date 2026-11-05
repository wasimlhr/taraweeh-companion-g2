/**
 * Soniox real-time Arabic STT, adapted to the pipeline's chunk request shape.
 * Each overlapping PCM window is sent as one short Soniox WebSocket stream and
 * finalized immediately; the returned tokens are normalized to the same
 * { text, words, provider } contract as the other engines.
 *
 * Docs: https://soniox.com/docs/api-reference/stt/websocket-api
 */
import WebSocket from 'ws';
import { httpError } from './httpRetry.js';
import { providerDeadline } from './requestDeadline.js';

const SONIOX_WS_URL = process.env.SONIOX_TRANSCRIBE_URL
  || 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODELS_URL = 'https://api.soniox.com/v1/models';
const SONIOX_MODEL = process.env.SONIOX_MODEL || 'stt-rt-v5';

function sonioxError(data = {}) {
  const status = Number(data.error_code) || 0;
  const type = String(data.error_type || 'soniox_error');
  const message = String(data.error_message || type);
  const err = new Error(`Soniox HTTP ${status}: ${message}`);
  err.status = status;
  err.code = type;
  err.requestId = data.request_id || '';
  err.quotaExhausted = /quota|balance|billing/.test(type) && status !== 429;
  err.retryable = !err.quotaExhausted && (status === 408 || status === 409 || status === 429 || status >= 500);
  return err;
}

export function normalizeSonioxTokens(tokens = []) {
  // Soniox can finalize protocol markers such as <end> alongside spoken
  // tokens. They indicate stream/endpoint state and must never enter Quran
  // matching, word timings, or the user-visible transcript.
  const finals = tokens.filter((token) => {
    if (!token || !token.is_final || token.translation_status === 'translation') return false;
    return !/^\s*<[^>]+>\s*$/.test(String(token.text || ''));
  });
  return {
    text: finals.map((token) => String(token.text || '')).join('').trim(),
    words: finals.map((token) => ({
      word: String(token.text || '').trim(),
      start: Math.max(0, Number(token.start_ms) || 0) / 1000,
      end: Math.max(0, Number(token.end_ms) || 0) / 1000,
    })).filter((word) => word.word),
  };
}

/**
 * @param {Buffer} pcmBuffer Raw PCM S16LE 16 kHz mono
 * @param {string} apiKey
 * @param {Function} [emit]
 * @param {{ prompt?: string, model?: string, signal?: AbortSignal, timeoutMs?: number, WebSocketImpl?: typeof WebSocket }} [extra]
 */
export async function transcribeWithSoniox(pcmBuffer, apiKey, emit = null, extra = {}) {
  if (!apiKey) throw new Error('Soniox API key missing. Set it in app settings or SHARED_SONIOX_KEY.');

  const useModel = extra.model || SONIOX_MODEL;
  const WebSocketImpl = extra.WebSocketImpl || WebSocket;
  const deadline = providerDeadline(extra);
  const t0 = Date.now();
  emit?.({ component: 'model', status: 'pending', provider: 'soniox' });

  try {
    const result = await new Promise((resolve, reject) => {
      const tokens = [];
      let settled = false;
      let finished = false;
      const ws = new WebSocketImpl(SONIOX_WS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const cleanup = () => deadline.signal.removeEventListener('abort', onAbort);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.terminate?.(); } catch { /* ignore */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(normalizeSonioxTokens(tokens));
      };
      const onAbort = () => fail(deadline.signal.reason || new Error('Soniox request aborted'));
      deadline.signal.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        const config = {
          model: useModel,
          audio_format: 'pcm_s16le',
          num_channels: 1,
          sample_rate: 16000,
          language_hints: ['ar'],
          language_hints_strict: true,
          enable_endpoint_detection: true,
        };
        if (extra.prompt) config.context = { text: String(extra.prompt).slice(0, 20_000) };
        ws.send(JSON.stringify(config));
        ws.send(pcmBuffer, { binary: true });
        ws.send('');
      });
      ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch { return fail(new Error('Soniox returned invalid JSON')); }
        if (data.error_code || data.error_type) return fail(sonioxError(data));
        if (Array.isArray(data.tokens)) tokens.push(...data.tokens);
        if (data.finished) {
          finished = true;
          finish();
        }
      });
      ws.on('error', fail);
      ws.on('close', (code, reason) => {
        if (settled) return;
        if (finished) finish();
        else fail(new Error(`Soniox WebSocket closed (${code}): ${String(reason || '')}`));
      });
    });

    const latencyMs = Date.now() - t0;
    emit?.({ component: 'model', status: 'ready', provider: 'soniox', latencyMs });
    console.log(`[Soniox:${useModel}] ${latencyMs}ms  pcm=${pcmBuffer.length}B  words=${result.words.length}  text="${result.text.slice(0, 80)}${result.text.length > 80 ? '…' : ''}"`);
    return { ...result, provider: 'soniox' };
  } catch (err) {
    emit?.({ component: 'model', status: 'error', provider: 'soniox', message: String(err.message || err).slice(0, 100), httpStatus: err.status || 0 });
    throw err;
  } finally {
    deadline.done();
  }
}

export async function probeSonioxKey(apiKey) {
  const deadline = providerDeadline({ timeoutMs: 15_000 });
  try {
    const res = await fetch(SONIOX_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: deadline.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw httpError('Soniox', res, body);
    let models = 0;
    try { models = JSON.parse(body)?.models?.length || 0; } catch { /* ignore */ }
    return { ok: true, models };
  } finally {
    deadline.done();
  }
}
