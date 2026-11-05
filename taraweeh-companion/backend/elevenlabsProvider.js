/**
 * ElevenLabs Scribe v2 Realtime, adapted to the pipeline's buffered request
 * shape. Raw PCM is split into short WebSocket chunks and manually committed;
 * the final timestamp event is normalized to { text, words, provider }.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */
import WebSocket from 'ws';
import { httpError } from './httpRetry.js';
import { providerDeadline } from './requestDeadline.js';

const ELEVEN_WS_URL = process.env.ELEVENLABS_TRANSCRIBE_URL
  || 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'scribe_v2_realtime';
const PCM_CHUNK_BYTES = 8_000; // 250 ms of mono PCM S16LE at 16 kHz

function realtimeUrl(model) {
  const query = new URLSearchParams({
    model_id: model,
    audio_format: 'pcm_16000',
    language_code: 'ara',
    commit_strategy: 'manual',
    include_timestamps: 'true',
  });
  return `${ELEVEN_WS_URL}?${query}`;
}

function elevenLabsRealtimeError(data = {}) {
  const type = String(data.message_type || data.type || 'elevenlabs_error');
  const message = String(data.error || data.message || type);
  const status = /rate|throttl/.test(type) ? 429
    : /auth|key/.test(type) ? 401
      : /quota/.test(type) ? 402 : 0;
  const err = new Error(`ElevenLabs ${type}: ${message}`);
  err.code = type;
  err.status = status;
  err.quotaExhausted = /quota/.test(type);
  err.retryable = !err.quotaExhausted && (status === 429 || /queue|resource|transcriber/.test(type));
  return err;
}

export function normalizeElevenLabsTranscript(data = {}, fallbackText = '') {
  const words = [];
  for (const item of Array.isArray(data.words) ? data.words : []) {
    if (item?.type && item.type !== 'word') continue;
    const word = String(item?.text || item?.word || '').trim();
    if (!word) continue;
    words.push({
      word,
      start: Math.max(0, Number(item.start) || 0),
      end: Math.max(0, Number(item.end) || 0),
    });
  }
  return { text: String(data.text || fallbackText || '').trim(), words };
}

/**
 * @param {Buffer} pcmBuffer Raw PCM S16LE 16 kHz mono
 * @param {string} apiKey
 * @param {Function} [emit]
 * @param {{ prompt?: string, model?: string, signal?: AbortSignal, timeoutMs?: number, WebSocketImpl?: typeof WebSocket }} [extra]
 * @returns {Promise<{text: string, words: Array, provider: 'elevenlabs'}>}
 */
export async function transcribeWithElevenLabs(pcmBuffer, apiKey, emit = null, extra = {}) {
  if (!apiKey) throw new Error('ElevenLabs API key missing. Set it in app settings or SHARED_ELEVENLABS_KEY.');

  const useModel = extra.model || ELEVEN_MODEL;
  const WebSocketImpl = extra.WebSocketImpl || WebSocket;
  const deadline = providerDeadline(extra);
  const t0 = Date.now();
  emit?.({ component: 'model', status: 'pending', provider: 'elevenlabs' });

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let committedText = '';
      const ws = new WebSocketImpl(realtimeUrl(useModel), {
        headers: { 'xi-api-key': apiKey },
      });

      const cleanup = () => deadline.signal.removeEventListener('abort', onAbort);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.terminate?.(); } catch { /* ignore */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const finish = (data) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close?.(1000); } catch { /* ignore */ }
        resolve(normalizeElevenLabsTranscript(data, committedText));
      };
      const onAbort = () => fail(deadline.signal.reason || new Error('ElevenLabs request aborted'));
      deadline.signal.addEventListener('abort', onAbort, { once: true });

      ws.on('open', () => {
        const chunks = [];
        for (let offset = 0; offset < pcmBuffer.length; offset += PCM_CHUNK_BYTES) {
          chunks.push(pcmBuffer.subarray(offset, Math.min(offset + PCM_CHUNK_BYTES, pcmBuffer.length)));
        }
        if (!chunks.length) chunks.push(Buffer.alloc(0));
        chunks.forEach((chunk, index) => {
          const message = {
            message_type: 'input_audio_chunk',
            audio_base_64: chunk.toString('base64'),
            sample_rate: 16000,
          };
          if (index === 0 && extra.prompt) message.previous_text = String(extra.prompt).slice(-50);
          if (index === chunks.length - 1) message.commit = true;
          ws.send(JSON.stringify(message));
        });
      });
      ws.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch { return fail(new Error('ElevenLabs returned invalid JSON')); }
        const type = String(data.message_type || data.type || '');
        if (type === 'committed_transcript') {
          committedText = String(data.text || '').trim();
          return;
        }
        if (type === 'committed_transcript_with_timestamps') return finish(data);
        if (type === 'warning' || type === 'session_started' || type === 'partial_transcript') return;
        if (type.includes('error') || type.includes('rate_limit') || type.includes('quota') || data.error) {
          return fail(elevenLabsRealtimeError(data));
        }
      });
      ws.on('error', fail);
      ws.on('close', (code, reason) => {
        if (!settled) fail(new Error(`ElevenLabs WebSocket closed (${code}): ${String(reason || '')}`));
      });
    });

    const latencyMs = Date.now() - t0;
    emit?.({ component: 'model', status: 'ready', provider: 'elevenlabs', latencyMs });
    console.log(`[ElevenLabs:${useModel}] ${latencyMs}ms  pcm=${pcmBuffer.length}B  words=${result.words.length}  text="${result.text.slice(0, 80)}${result.text.length > 80 ? '…' : ''}"`);
    return { ...result, provider: 'elevenlabs' };
  } catch (err) {
    emit?.({ component: 'model', status: 'error', provider: 'elevenlabs', message: String(err.message || err).slice(0, 100), httpStatus: err.status || 0 });
    throw err;
  } finally {
    deadline.done();
  }
}

export async function probeElevenLabsKey(apiKey) {
  const deadline = providerDeadline({ timeoutMs: 15_000 });
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': apiKey },
      signal: deadline.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw httpError('ElevenLabs', res, body);
    let email = '';
    try { email = JSON.parse(body)?.email || ''; } catch { /* ignore */ }
    return { ok: true, email };
  } finally {
    deadline.done();
  }
}
