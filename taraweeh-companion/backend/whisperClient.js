/**
 * Whisper client — uses dedicated HuggingFace Inference Endpoint.
 * Model: tarteel-ai/whisper-base-ar-quran on AWS us-east-1
 * Fallback: openai/whisper-large-v3 on HF serverless
 */

const ENDPOINT_URL = process.env.WHISPER_ENDPOINT_URL
  || 'https://r6pubw0kxkgps2e9.us-east-1.aws.endpoints.huggingface.cloud';

const FALLBACK_URL = 'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3';

function getToken(hfToken) {
  return hfToken || process.env.HUGGINGFACE_TOKEN;
}

async function callEndpoint(url, wavBuffer, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'audio/wav',
    },
    body: wavBuffer,
    signal: AbortSignal.timeout(30000),
  });

  if (response.status === 503) {
    const wait = parseInt(response.headers.get('retry-after') || '20', 10) * 1000;
    console.log(`[Whisper] Endpoint waking up, retrying in ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
    return callEndpoint(url, wavBuffer, token);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  const result = await response.json();
  console.log('[Whisper] Transcribed:', result.text?.substring(0, 80));
  return result.text || '';
}

/**
 * Transcribe a WAV buffer. Tries dedicated Tarteel endpoint first, falls back to whisper-large-v3.
 * @param {Buffer} wavBuffer - WAV file buffer (16kHz, 16-bit, mono)
 * @param {string} [hfToken] - HuggingFace token override (or uses env)
 * @returns {Promise<string>} Transcribed Arabic text
 */
export async function transcribeWithWhisper(wavBuffer, hfToken) {
  const token = getToken(hfToken);
  if (!token) throw new Error('HUGGINGFACE_TOKEN required');

  if (ENDPOINT_URL) {
    try {
      return await callEndpoint(ENDPOINT_URL, wavBuffer, token);
    } catch (err) {
      console.warn('[Whisper] Dedicated endpoint failed:', err.message, '— trying fallback');
    }
  }

  return await callEndpoint(FALLBACK_URL, wavBuffer, token);
}
