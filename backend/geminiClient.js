/**
 * Gemini client for non-Quran detection (tasbeeh, takbeer, etc.).
 * Uses @google/genai SDK. Includes retry with backoff for 429 rate limits.
 */
import { GoogleGenAI } from '@google/genai';

let defaultAi = null;

function getClient(apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (apiKey) return new GoogleGenAI({ apiKey });
  if (!defaultAi) defaultAi = new GoogleGenAI({ apiKey: key });
  return defaultAi;
}

const MAX_RETRIES = 2;

async function callWithRetry(client, params, retries = 0) {
  try {
    return await client.models.generateContent(params);
  } catch (err) {
    const is429 = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.status === 429;
    if (is429 && retries < MAX_RETRIES) {
      const retryMatch = err.message?.match(/retryDelay.*?(\d+)s/i) || err.message?.match(/retry.*?in\s+([\d.]+)s/i);
      const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) * 1000 : (retries + 1) * 3000;
      console.log(`[Gemini] Rate limited, retrying in ${wait / 1000}s (attempt ${retries + 2}/${MAX_RETRIES + 1})`);
      await new Promise(r => setTimeout(r, wait));
      return callWithRetry(client, params, retries + 1);
    }
    throw err;
  }
}

function extractJSON(raw) {
  const cleaned = (raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) try { return JSON.parse(match[0]); } catch {}
  if (/quran/i.test(cleaned)) return { isQuran: true, type: 'quran', meaning: '' };
  return null;
}

/**
 * Classify Arabic text as Quranic recitation or other Islamic speech.
 * @param {string} arabicText - Transcribed Arabic text from Whisper
 * @param {string} [apiKey] - Gemini API key (or use env)
 * @returns {Promise<{isQuran: boolean, type: string, meaning: string}>}
 */
export async function classifyIslamicSpeech(arabicText, apiKey) {
  const client = getClient(apiKey);
  if (!client) return { isQuran: true, type: 'quran', meaning: '' };

  const prompt = `Classify this Arabic text. Is it a Quran verse, or other Islamic speech (tasbeeh, takbeer, dua, etc)?
Text: "${arabicText}"
Reply with JSON only, no markdown: {"isQuran": true/false, "type": "quran"|"tasbeeh"|"takbeer"|"tahmid"|"dua"|"other", "meaning": "brief English meaning"}`;

  try {
    const response = await callWithRetry(client, {
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { temperature: 0, maxOutputTokens: 150, responseMimeType: 'application/json' },
    });

    const raw = typeof response.text === 'function' ? response.text() : response.text;
    const parsed = extractJSON(raw);
    if (parsed) {
      console.log('[Gemini]', parsed.type, '|', parsed.meaning);
      return parsed;
    }
    console.warn('[Gemini] Could not parse:', (raw || '').substring(0, 100));
    return { isQuran: true, type: 'quran', meaning: '' };
  } catch (err) {
    console.error('[Gemini]', err.message?.substring(0, 150));
    return { isQuran: true, type: 'quran', meaning: '' };
  }
}
