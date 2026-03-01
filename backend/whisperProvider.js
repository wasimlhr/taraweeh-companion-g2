/**
 * Whisper provider
 * Supports three modes (checked in order):
 *   1. LOCAL  — Python whisper_server.py on localhost:8000 (USE_LOCAL_WHISPER=true)
 *   2. DEDICATED — HuggingFace Inference Endpoint (WHISPER_ENDPOINT_URL set)
 *   3. FALLBACK — HuggingFace public API: wasimlhr/whisper-quran-v1
 */
import { pcmToWav } from './pcmToWav.js';

const USE_LOCAL     = process.env.USE_LOCAL_WHISPER === 'true';
const LOCAL_URL     = process.env.LOCAL_WHISPER_URL || 'http://localhost:8000/transcribe';
const DEDICATED_URL = process.env.WHISPER_ENDPOINT_URL;
const FALLBACK_URL  = 'https://router.huggingface.co/hf-inference/models/wasimlhr/whisper-quran-v1';

const IS_MODAL = DEDICATED_URL && /modal\.run|modal\.com/i.test(DEDICATED_URL);
const MODAL_KEY    = process.env.MODAL_KEY;
const MODAL_SECRET = process.env.MODAL_SECRET;

/** Call the local Python Whisper server (multipart form or raw WAV) */
async function callLocal(wavBuffer, emit = null) {
  emit?.({ component: 'model', status: 'pending' });
  const response = await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wavBuffer,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const body = await response.text();
    emit?.({ component: 'model', status: 'error', message: `Local ${response.status}` });
    throw new Error(`Local Whisper HTTP ${response.status}: ${body.slice(0, 100)}`);
  }
  const data = await response.json();
  const text = (data.text || '').trim();
  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] Local: "${text.substring(0, 80)}"`);
  return { text, provider: 'local' };
}

/** Parse transcription from various response formats (HF, Modal, transformers pipeline) */
function parseTranscription(result) {
  if (!result || typeof result !== 'object') return '';
  const text =
    result.text ??
    result.transcription ??
    (Array.isArray(result) ? result[0]?.text : undefined) ??
    result.chunks?.[0]?.text ??
    result.segments?.[0]?.text ??
    '';
  return String(text).trim();
}

async function callRaw(url, wavBuffer, token, forceArabic = false, emit = null) {
  const fullUrl = forceArabic && !url.includes('?')
    ? url + '?language=ar&task=transcribe'
    : url;

  emit?.({ component: 'model', status: 'pending' });

  const headers = { 'Content-Type': 'audio/wav' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(fullUrl, {
    method: 'POST',
    headers,
    body: wavBuffer,
    signal: AbortSignal.timeout(35000),
  });

  // HF/Modal cold-start: emit loading status, wait, then retry
  if (response.status === 503) {
    const retryIn = parseInt(response.headers.get('retry-after') || '20', 10);
    console.log(`[Whisper] Model loading, retrying in ${retryIn}s...`);
    emit?.({ component: 'model', status: 'loading', retryIn });
    await new Promise((r) => setTimeout(r, retryIn * 1000));
    return callRaw(url, wavBuffer, token, forceArabic, emit);
  }

  const body = await response.text();

  if (!response.ok) {
    emit?.({ component: 'model', status: 'error', message: `HTTP ${response.status}` });
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let result;
  try { result = JSON.parse(body); } catch (_) {
    throw new Error(`Non-JSON response: ${body.slice(0, 100)}`);
  }

  const text = parseTranscription(result);

  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] "${text.substring(0, 80)}"`);
  return { text, provider: 'whisper' };
}

/** Call Modal web endpoint (no HF Bearer; optional Modal proxy auth; language=ar) */
async function callModal(url, wavBuffer, emit = null) {
  const fullUrl = url.includes('?') ? url : url + '?language=ar&task=transcribe';

  emit?.({ component: 'model', status: 'pending' });

  const headers = { 'Content-Type': 'audio/wav' };
  if (MODAL_KEY && MODAL_SECRET) {
    headers['Modal-Key'] = MODAL_KEY;
    headers['Modal-Secret'] = MODAL_SECRET;
  }

  const response = await fetch(fullUrl, {
    method: 'POST',
    headers,
    body: wavBuffer,
    signal: AbortSignal.timeout(35000),
  });

  if (response.status === 503) {
    const retryIn = parseInt(response.headers.get('retry-after') || '20', 10);
    console.log(`[Whisper] Modal cold-start, retrying in ${retryIn}s...`);
    emit?.({ component: 'model', status: 'loading', retryIn });
    await new Promise((r) => setTimeout(r, retryIn * 1000));
    return callModal(url, wavBuffer, emit);
  }

  const body = await response.text();

  if (!response.ok) {
    emit?.({ component: 'model', status: 'error', message: `HTTP ${response.status}` });
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let result;
  try { result = JSON.parse(body); } catch (_) {
    throw new Error(`Non-JSON response: ${body.slice(0, 100)}`);
  }

  const text = parseTranscription(result);

  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] Modal: "${text.substring(0, 80)}"`);
  return { text, provider: 'whisper' };
}

/**
 * Proactive health check — called on WS connect so the frontend immediately
 * knows which provider is configured and whether the endpoint is reachable.
 * Does NOT send audio; just pings the URL with a lightweight request.
 */
export async function probeWhisperEndpoint(hfToken, emit) {
  const token = hfToken || process.env.HUGGINGFACE_TOKEN;

  // Determine which provider will be used
  let provider, url;
  if (USE_LOCAL) {
    provider = 'local'; url = LOCAL_URL;
  } else if (DEDICATED_URL) {
    provider = 'dedicated'; url = DEDICATED_URL;
  } else {
    provider = 'fallback'; url = FALLBACK_URL;
  }

  emit({ component: 'model', status: 'probing', provider, url: url.replace(/\/\/.*@/, '//***@') });
  console.log(`[Whisper] Probing ${provider} → ${url}`);

  try {
    const headers = { 'Content-Type': 'audio/wav' };
    if (provider === 'dedicated' && IS_MODAL) {
      if (MODAL_KEY && MODAL_SECRET) {
        headers['Modal-Key'] = MODAL_KEY;
        headers['Modal-Secret'] = MODAL_SECRET;
      }
    } else if (provider !== 'local' && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const t0 = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: Buffer.alloc(0),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - t0;

    if (res.status === 503) {
      const retryIn = parseInt(res.headers.get('retry-after') || '30', 10);
      emit({ component: 'model', status: 'loading', provider, retryIn, latencyMs });
      console.log(`[Whisper] Probe: ${provider} loading (retry ${retryIn}s, ${latencyMs}ms)`);
      return;
    }

    // Any response (even 400/422 for empty body) means the endpoint is alive
    emit({ component: 'model', status: 'standby', provider, latencyMs, httpStatus: res.status });
    console.log(`[Whisper] Probe: ${provider} reachable (HTTP ${res.status}, ${latencyMs}ms)`);
  } catch (err) {
    emit({ component: 'model', status: 'error', provider, message: err.message.slice(0, 100) });
    console.warn(`[Whisper] Probe: ${provider} unreachable — ${err.message}`);
  }
}

function isNoise(text) {
  if (!text || text.trim().length < 2) return true;
  const t = text.replace(/[\u064B-\u065F\s]/g, ''); // strip diacritics + spaces
  // Repeated character hallucination
  if (/(.)\1{5,}/.test(t)) return true;
  // Must contain at least one Arabic character
  if (!/[\u0600-\u06FF]/.test(text)) {
    console.log(`[Whisper] Non-Arabic rejected: "${text.slice(0, 80)}"`);
    return true;
  }
  return false;
}

export async function transcribeWithWhisper(pcmBuffer, hfToken, emit = null) {
  const wavBuffer = pcmToWav(pcmBuffer, 16000);

  // ── Mode 1: Local Python Whisper server (fastest, no rate limits) ──────────
  if (USE_LOCAL) {
    try {
      console.log(`[Whisper] Local → ${wavBuffer.length}B`);
      const result = await callLocal(wavBuffer, emit);
      if (!isNoise(result.text)) return result;
      console.log(`[Whisper] Local noise/empty — falling through to HF`);
    } catch (err) {
      console.warn(`[Whisper] Local failed: ${err.message} — falling back to HF`);
      emit?.({ component: 'model', status: 'fallback', message: 'Local server unavailable' });
    }
  }

  const token = hfToken || process.env.HUGGINGFACE_TOKEN;

  // ── Mode 2: Dedicated endpoint (HF or Modal) ─────────────────────────────────
  if (DEDICATED_URL) {
    try {
      console.log(`[Whisper] Dedicated (${IS_MODAL ? 'Modal' : 'HF'}) → ${wavBuffer.length}B`);
      const result = IS_MODAL
        ? await callModal(DEDICATED_URL, wavBuffer, emit)
        : await callRaw(DEDICATED_URL, wavBuffer, token, false, emit);
      if (!isNoise(result.text)) return result;
      console.log(`[Whisper] Dedicated noise/empty — trying fallback`);
      emit?.({ component: 'model', status: 'fallback', message: 'Dedicated returned noise' });
    } catch (err) {
      console.warn(`[Whisper] Dedicated failed: ${err.message}`);
      emit?.({ component: 'model', status: 'fallback', message: err.message.slice(0, 80) });
    }
  }

  // ── Mode 3: HuggingFace public fallback ────────────────────────────────────
  if (!token) throw new Error('HUGGINGFACE_TOKEN required for HF fallback');
  console.log(`[Whisper] Fallback → ${wavBuffer.length}B`);
  return await callRaw(FALLBACK_URL, wavBuffer, token, true, emit);
}
