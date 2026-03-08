/**
 * Whisper provider
 * Supports (checked in order):
 *   1. LOCAL  — Python whisper_server.py (USE_LOCAL_WHISPER=true)
 *   2. DEDICATED — HF/Modal/Custom endpoint (env or client opts)
 *   3. FALLBACK — HuggingFace public API: wasimlhr/whisper-quran-v1
 *
 * Client can override via opts: { provider, endpointUrl, apiKey, modalSecret }
 * provider: 'hf-public' | 'hf-dedicated' | 'modal' | 'custom'
 */
import { pcmToWav } from './pcmToWav.js';

const USE_LOCAL     = process.env.USE_LOCAL_WHISPER === 'true';
const LOCAL_URL     = process.env.LOCAL_WHISPER_URL || 'http://localhost:8000/transcribe';
const FALLBACK_URL  = 'https://router.huggingface.co/hf-inference/models/wasimlhr/whisper-quran-v1';

function getWhisperConfig(opts = {}) {
  opts = opts || {};
  const envUrl = process.env.WHISPER_ENDPOINT_URL;
  const envModalKey = process.env.MODAL_KEY;
  const envModalSecret = process.env.MODAL_SECRET;
  const envToken = process.env.HUGGINGFACE_TOKEN;

  const provider = opts.provider || (envUrl ? (envUrl.match(/modal\.run|modal\.com/i) ? 'modal' : 'hf-dedicated') : 'hf-public');
  const endpointUrl = (opts.endpointUrl || '').trim() || envUrl || null;
  const apiKey = (opts.apiKey || '').trim() || envToken || null;
  const modalKey = (opts.modalKey || '').trim() || envModalKey || null;
  const modalSecret = (opts.modalSecret || '').trim() || envModalSecret || null;

  const isModal = provider === 'modal' || (endpointUrl && /modal\.run|modal\.com/i.test(endpointUrl));
  const isCustom = provider === 'custom';

  return {
    provider: provider,
    endpointUrl,
    apiKey,
    modalKey,
    modalSecret,
    isModal,
    isCustom,
    useModalAuth: isModal && !!(modalKey && modalSecret),
  };
}

/** Call the local Python Whisper server (multipart form or raw WAV) */
async function callLocal(wavBuffer, emit = null) {
  emit?.({ component: 'model', status: 'pending' });
  const t0 = Date.now();
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
  const { text, words } = parseTranscription(data);
  const latencyMs = Date.now() - t0;
  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] Local: "${text.substring(0, 80)}" (${latencyMs}ms)${words.length > 0 ? ` [${words.length} words]` : ''}`);
  return { text, words, provider: 'local' };
}

/**
 * Normalize a single word from endpoint response to { text, start, end }.
 * Handles: { text, start, end }, { text, timestamp: [s, e] }, { text }.
 */
function normalizeWord(w) {
  if (!w || typeof w !== 'object') return null;
  const text = (w.text ?? w.word ?? '').trim();
  if (!text) return null;
  let start = null;
  let end = null;
  if (typeof w.start === 'number' && !Number.isNaN(w.start)) start = w.start;
  if (typeof w.end === 'number' && !Number.isNaN(w.end)) end = w.end;
  if (start === null && end === null && Array.isArray(w.timestamp) && w.timestamp.length >= 2) {
    start = typeof w.timestamp[0] === 'number' ? w.timestamp[0] : null;
    end = typeof w.timestamp[1] === 'number' ? w.timestamp[1] : null;
  }
  return { text, start, end };
}

/** Parse transcription from various response formats (HF, Modal, HF Inference Endpoint, pipeline) */
function parseTranscription(result) {
  if (!result || typeof result !== 'object') return { text: '', words: [] };
  const text =
    result.text ??
    result.transcription ??
    (Array.isArray(result) ? result[0]?.text : undefined) ??
    result.chunks?.[0]?.text ??
    result.segments?.[0]?.text ??
    '';

  // New style: word-level timestamps — words or chunks with { text, start, end } (or timestamp array)
  let rawWords = result.words ?? result.chunks ?? [];
  let words = rawWords.map(normalizeWord).filter(Boolean);

  // Fallback: no word-level data — generate mock timestamps so V4 word tracking still works
  if (words.length === 0 && text) {
    const textWords = String(text).trim().split(/\s+/).filter(Boolean);
    if (textWords.length > 0) {
      let currentTime = 0;
      words = textWords.map((word) => {
        const duration = 0.6 + Math.random() * 0.2;
        const start = currentTime;
        const end = currentTime + duration;
        currentTime = end;
        return { text: word, start, end };
      });
      console.log(`[Whisper] Mock timestamps for ${words.length} words (endpoint did not return word-level timestamps)`);
    }
  }

  return { text: String(text).trim(), words };
}

async function callRaw(url, wavBuffer, token, forceArabic = false, emit = null) {
  const params = new URLSearchParams();
  params.set('language', 'ar');
  params.set('task', 'transcribe');
  params.set('return_timestamps', 'true');
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url + sep + params.toString();

  emit?.({ component: 'model', status: 'pending' });

  const headers = { 'Content-Type': 'audio/wav' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const t0 = Date.now();
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

  const { text, words } = parseTranscription(result);
  const latencyMs = Date.now() - t0;

  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] "${text.substring(0, 80)}" (${latencyMs}ms)${words.length > 0 ? ` [${words.length} words]` : ''}`);
  return { text, words, provider: 'whisper' };
}

/** Call Modal web endpoint (no HF Bearer; optional Modal proxy auth; language=ar, return_timestamps=true) */
async function callModal(url, wavBuffer, modalKey, modalSecret, emit = null) {
  const params = new URLSearchParams();
  params.set('language', 'ar');
  params.set('task', 'transcribe');
  params.set('return_timestamps', 'true');
  const sep = url.includes('?') ? '&' : '?';
  const fullUrl = url + sep + params.toString();

  emit?.({ component: 'model', status: 'pending' });

  const headers = { 'Content-Type': 'audio/wav' };
  if (modalKey && modalSecret) {
    headers['Modal-Key'] = modalKey;
    headers['Modal-Secret'] = modalSecret;
  }

  const t0 = Date.now();
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
    return callModal(url, wavBuffer, modalKey, modalSecret, emit);
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

  const { text, words } = parseTranscription(result);
  const latencyMs = Date.now() - t0;

  emit?.({ component: 'model', status: 'ready' });
  console.log(`[Whisper] Modal: "${text.substring(0, 80)}" (${latencyMs}ms)${words.length > 0 ? ` [${words.length} words]` : ''}`);
  return { text, words, provider: 'whisper' };
}

/**
 * Proactive health check — called on WS connect so the frontend immediately
 * knows which provider is configured and whether the endpoint is reachable.
 * opts: { provider, endpointUrl, apiKey, modalKey, modalSecret } — from client or env
 */
export async function probeWhisperEndpoint(optsOrToken, emit) {
  const opts = typeof optsOrToken === 'object' ? optsOrToken : { apiKey: optsOrToken };
  const cfg = getWhisperConfig(opts);

  let provider, url;
  if (USE_LOCAL) {
    provider = 'local'; url = LOCAL_URL;
  } else if (cfg.endpointUrl) {
    provider = cfg.isModal ? 'modal' : cfg.isCustom ? 'custom' : 'dedicated';
    url = cfg.endpointUrl;
  } else {
    provider = 'fallback'; url = FALLBACK_URL;
  }

  emit({ component: 'model', status: 'probing', provider, url: (url || '').replace(/\/\/.*@/, '//***@') });
  console.log(`[Whisper] Probing ${provider} → ${url}`);

  try {
    const headers = { 'Content-Type': 'audio/wav' };
    if (cfg.useModalAuth) {
      headers['Modal-Key'] = cfg.modalKey;
      headers['Modal-Secret'] = cfg.modalSecret;
    } else if (provider !== 'local' && cfg.apiKey) {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
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

export async function transcribeWithWhisper(pcmBuffer, optsOrToken, emit = null) {
  const opts = typeof optsOrToken === 'object' ? optsOrToken : { apiKey: optsOrToken };
  const cfg = getWhisperConfig(opts);
  const wavBuffer = pcmToWav(pcmBuffer, 16000);

  // ── Mode 1: Local Python Whisper server ─────────────────────────────────────
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

  // ── Mode 2: Dedicated endpoint (HF / Modal / Custom) ────────────────────────
  if (cfg.endpointUrl) {
    try {
      const label = cfg.isModal ? 'Modal' : cfg.isCustom ? 'Custom' : 'HF';
      console.log(`[Whisper] Dedicated (${label}) → ${wavBuffer.length}B`);
      const result = cfg.isModal
        ? await callModal(cfg.endpointUrl, wavBuffer, cfg.modalKey, cfg.modalSecret, emit)
        : await callRaw(cfg.endpointUrl, wavBuffer, cfg.apiKey, false, emit);
      if (!isNoise(result.text)) return result;
      console.log(`[Whisper] Dedicated noise/empty — trying fallback`);
      emit?.({ component: 'model', status: 'fallback', message: 'Dedicated returned noise' });
    } catch (err) {
      console.warn(`[Whisper] Dedicated failed: ${err.message}`);
      emit?.({ component: 'model', status: 'fallback', message: err.message.slice(0, 80) });
    }
  }

  // ── Mode 3: HuggingFace public fallback ────────────────────────────────────
  if (!cfg.apiKey) throw new Error('API key required for HF public fallback');
  console.log(`[Whisper] Fallback → ${wavBuffer.length}B`);
  return await callRaw(FALLBACK_URL, wavBuffer, cfg.apiKey, true, emit);
}
