/**
 * Gemini Live API provider — streams PCM directly for real-time transcription.
 * Model: gemini-2.0-flash-live-001
 * No WAV conversion needed — accepts raw PCM.
 */
import { GoogleGenAI } from '@google/genai';
import { ProviderTimeoutError, requestSignal } from './requestControl.js';

const GEMINI_MODEL = 'gemini-2.0-flash-live-001';

let ai = null;
function getClient() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

async function openSession() {
  console.log('[Gemini] Opening isolated Live API session...');
  const client = getClient();
  const liveSession = await client.live.connect({
      model: GEMINI_MODEL,
      config: {
        responseModalities: ['TEXT'],
        inputAudioTranscription: {},
        systemInstruction: {
          parts: [{
            text: 'You are transcribing Quran recitation in Arabic. Return only the Arabic text you hear, nothing else. If you hear silence or non-speech, return an empty string.',
          }],
        },
      },
  });
  console.log('[Gemini] Isolated Live session ready');
  return liveSession;
}

async function collectTranscription(liveSession, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let transcription = '';
    const timer = setTimeout(() => reject(new ProviderTimeoutError('Gemini receive', timeoutMs)), timeoutMs);

    (async () => {
      try {
        for await (const msg of liveSession.receive()) {
          if (msg.serverContent?.inputTranscription?.text) {
            transcription += msg.serverContent.inputTranscription.text;
          }
          if (msg.serverContent?.turnComplete) {
            clearTimeout(timer);
            resolve(transcription.trim());
            return;
          }
        }
      } catch (err) {
        console.error('[Gemini] Receive error:', err.message);
        session = null;
        clearTimeout(timer);
        resolve(transcription.trim());
      }
    })();
  });
}

/**
 * Transcribe via Gemini Live API — streams PCM directly.
 * @param {Buffer} pcmBuffer - Raw PCM S16LE 16kHz mono
 * @returns {Promise<{text: string, provider: string}>}
 */
export async function transcribeWithGemini(pcmBuffer, options = {}) {
  const request = requestSignal('Gemini', options.signal, options.timeoutMs || 30_000);
  let liveSession = null;
  const aborted = new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
  try {
    const connecting = openSession();
    connecting.then((opened) => { if (request.signal.aborted) opened.close().catch(() => {}); }).catch(() => {});
    liveSession = await Promise.race([connecting, aborted]);
    if (request.signal.aborted) throw request.signal.reason;
    const work = (async () => {
      await liveSession.sendRealtimeInput({ audio: { data: pcmBuffer.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      await liveSession.sendClientContent({ turns: [], turnComplete: true });
      return collectTranscription(liveSession, options.timeoutMs || 15_000);
    })();
    const text = await Promise.race([work, aborted]);
    console.log(`[Gemini] "${text.substring(0, 80)}"`);
    return { text, provider: 'gemini' };
  } catch (error) {
    throw request.classify(error);
  } finally {
    request.cleanup();
    try { await liveSession?.close(); } catch (_) {}
  }
}

export async function closeGeminiSession() {
  // Sessions are request-scoped so there is no process-global stream to close.
}
