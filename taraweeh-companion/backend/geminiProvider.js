/**
 * Gemini Live API provider — streams PCM directly for real-time transcription.
 * Model: gemini-2.0-flash-live-001
 * No WAV conversion needed — accepts raw PCM.
 */
import { GoogleGenAI } from '@google/genai';

const GEMINI_MODEL = 'gemini-2.0-flash-live-001';

let ai = null;
let session = null;
let sessionPromise = null;

function getClient() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

async function getSession() {
  if (session) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    console.log('[Gemini] Opening Live API session...');
    const client = getClient();

    session = await client.live.connect({
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

    console.log('[Gemini] Live session ready');
    sessionPromise = null;

    session.on?.('close', () => {
      console.log('[Gemini] Session closed, will reopen on next chunk');
      session = null;
    });

    return session;
  })();

  return sessionPromise;
}

async function collectTranscription(liveSession, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let transcription = '';
    const timer = setTimeout(() => resolve(transcription), timeoutMs);

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
export async function transcribeWithGemini(pcmBuffer) {
  const liveSession = await getSession();
  const base64Audio = pcmBuffer.toString('base64');

  await liveSession.sendRealtimeInput({
    audio: {
      data: base64Audio,
      mimeType: 'audio/pcm;rate=16000',
    },
  });

  await liveSession.sendClientContent({
    turns: [],
    turnComplete: true,
  });

  const text = await collectTranscription(liveSession);
  console.log(`[Gemini] "${text.substring(0, 80)}"`);
  return { text, provider: 'gemini' };
}

export async function closeGeminiSession() {
  if (session) {
    try { await session.close(); } catch (_) {}
    session = null;
  }
}
