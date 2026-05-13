/**
 * Quran Companion — MentraOS Port
 *
 * Bridges the existing AudioPipelineV4 (Groq/OpenAI Whisper transcription +
 * Quran verse matching) to the MentraOS SDK, enabling real-time verse tracking
 * on any MentraOS-compatible smart glasses (Even Realities G1, Mentra Mach1,
 * Vuzix Z100, etc.).
 *
 * Architecture:
 *   MentraOS Glasses mic → session.audio.getMicrophoneStream() (raw PCM 16kHz)
 *   → AudioPipelineV4 (existing backend logic, unchanged)
 *   → onStateUpdate() → formatAndDisplay() → session.layouts.*
 */

import 'dotenv/config';
import { AppServer } from '@mentra/sdk';
import type { AppSession } from '@mentra/sdk';
import { MentraSessionBridge } from './mentraSessionBridge.js';

const PACKAGE_NAME = process.env.MENTRA_PACKAGE_NAME || 'com.taraweehcompanion.mentraos';
const API_KEY      = process.env.MENTRA_API_KEY || '';
const PORT         = Number(process.env.PORT) || 3000;

if (!API_KEY) {
  console.warn('[QuranCompanion] MENTRA_API_KEY not set — set it in .env before deploying');
}

// ── AppServer ─────────────────────────────────────────────────────────────────

const server = new AppServer({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,

  onSession: async (session: AppSession) => {
    console.log(`[QuranCompanion] New session: userId=${session.userId} sessionId=${session.sessionId}`);

    // Show a welcome message immediately while the pipeline initialises
    session.layouts.showTextWall('Quran Companion\nStarting…');

    // Create a bridge that wires the MentraOS session to AudioPipelineV4
    const bridge = new MentraSessionBridge(session);
    await bridge.start();

    // Clean up when the user closes the app
    session.events.onStop(() => {
      console.log(`[QuranCompanion] Session ended: ${session.sessionId}`);
      bridge.destroy();
    });
  },

  onError: (error: Error) => {
    console.error('[QuranCompanion] Server error:', error);
  },
});

server.start();
console.log(`[QuranCompanion] MentraOS app running on port ${PORT}`);
console.log(`[QuranCompanion] Package: ${PACKAGE_NAME}`);
