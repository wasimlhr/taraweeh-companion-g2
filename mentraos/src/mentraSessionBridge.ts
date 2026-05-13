/**
 * MentraSessionBridge
 *
 * Wires a MentraOS AppSession to the existing AudioPipelineV4 (unchanged from
 * the Even G2 backend). The bridge:
 *
 *   1. Reads raw PCM audio from session.audio.getMicrophoneStream()
 *   2. Feeds it into AudioPipelineV4.ingest() exactly as the WebSocket server did
 *   3. Receives pipeline state updates via onStateUpdate callback
 *   4. Forwards them to DisplayFormatter → session.layouts.*
 *   5. Maps MentraOS button/gesture events to pipeline control commands
 *      (manual advance, prev, fast/slow mode, taraweeh mode)
 *
 * The AudioPipelineV4 and all supporting modules (keywordMatcher, verseData,
 * transcriptionRouter, etc.) are imported directly from the existing backend —
 * no code duplication.
 */

import type { AppSession } from '@mentra/sdk';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { DisplayFormatter } from './displayFormatter.js';
import type { DisplayMode, PipelineMsg } from './displayFormatter.js';

// ── Resolve paths to the existing backend ────────────────────────────────────
// mentraos/ sits next to taraweeh-companion/ at the repo root.
// We import the pipeline JS files directly (they are plain ESM .js).

const __dirname = dirname(fileURLToPath(import.meta.url));
// From mentraos/src/ → ../../taraweeh-companion/backend/
const BACKEND_DIR = resolve(__dirname, '..', '..', 'taraweeh-companion', 'backend');

// Dynamic imports so TypeScript doesn't try to type-check the JS backend files.
// We cast to `any` and use them via their documented runtime API.
async function importBackend() {
  const [
    { AudioPipeline: AudioPipelineV4 },
    { loadQuran },
    { buildMushafIndex },
  ] = await Promise.all([
    import(join(BACKEND_DIR, 'audioPipelineV4.js')),
    import(join(BACKEND_DIR, 'keywordMatcher.js')),
    import(join(BACKEND_DIR, 'mushafIndex.js')),
  ]);
  return { AudioPipelineV4, loadQuran, buildMushafIndex };
}

// ── Config helpers ────────────────────────────────────────────────────────────

function buildWhisperOpts() {
  const endpointUrl = process.env.WHISPER_ENDPOINT_URL || '';
  const isModalUrl  = /modal\.run|modal\.com/i.test(endpointUrl);
  const HF_TOKEN    = process.env.HUGGINGFACE_TOKEN;

  return {
    provider: endpointUrl ? (isModalUrl ? 'modal' : 'hf-dedicated') : 'hf-public',
    endpointUrl: endpointUrl || undefined,
    apiKey: HF_TOKEN || undefined,
    modalKey:    isModalUrl ? (process.env.MODAL_KEY    || undefined) : undefined,
    modalSecret: isModalUrl ? (process.env.MODAL_SECRET || undefined) : undefined,
  };
}

function resolveTranscriptionOpts(): Record<string, unknown> {
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  const groqKey   = (process.env.GROQ_API_KEY   || '').trim();
  const sharedGroq   = (process.env.SHARED_GROQ_KEY   || '').trim();
  const sharedOpenAI = (process.env.SHARED_OPENAI_KEY || '').trim();

  let whisperOpts = buildWhisperOpts();

  if (openaiKey) {
    return { ...whisperOpts, provider: 'openai', apiKey: openaiKey };
  }
  if (groqKey) {
    return { ...whisperOpts, provider: 'groq', apiKey: groqKey };
  }
  if (sharedGroq || sharedOpenAI) {
    return { ...whisperOpts, provider: 'groq', apiKey: '', sharedMode: true };
  }
  // No key configured — pipeline will error on first transcription attempt
  console.warn('[Bridge] No transcription API key configured. Set GROQ_API_KEY or OPENAI_API_KEY in .env');
  return { ...whisperOpts, provider: 'groq', apiKey: '' };
}

// ── Bridge ────────────────────────────────────────────────────────────────────

export class MentraSessionBridge {
  private session: AppSession;
  private pipeline: any = null;
  private formatter: DisplayFormatter;
  private displayMode: DisplayMode;
  private audioStream: any = null;
  private destroyed = false;

  constructor(session: AppSession) {
    this.session = session;
    this.displayMode = (process.env.DISPLAY_MODE as DisplayMode) || 'both';
    this.formatter = new DisplayFormatter(session, this.displayMode);
  }

  async start(): Promise<void> {
    // 1. Load Quran data (idempotent — cached after first call)
    const { AudioPipelineV4, loadQuran, buildMushafIndex } = await importBackend();
    loadQuran();
    try { buildMushafIndex(); } catch (_) {}

    // 2. Build pipeline options
    const preferredSurah = Number(process.env.DEFAULT_SURAH) || 0;
    const pipelineVersion = process.env.PIPELINE_VERSION || 'v4';
    const translationLang = process.env.TRANSLATION_LANG || '';
    const whisperOpts = resolveTranscriptionOpts();
    const geminiKey = process.env.GEMINI_API_KEY || '';

    // 3. Create the pipeline (same constructor as the WebSocket server uses)
    this.pipeline = new AudioPipelineV4({
      preferredSurah,
      translationLang,
      whisperOpts,
      geminiKey: geminiKey || undefined,
      onStateUpdate: (msg: PipelineMsg) => {
        if (!this.destroyed) this.formatter.handle(msg);
      },
      onStatus: (s: PipelineMsg) => {
        if (!this.destroyed) this.formatter.handle(s);
      },
      onError: (err: string) => {
        console.error('[Pipeline] Error:', err);
        if (!this.destroyed) {
          this.session.layouts.showTextWall(`Pipeline error:\n${err}`);
        }
      },
    });

    // 4. Wire up button/gesture controls
    this.registerControls();

    // 5. Start the pipeline
    this.pipeline.start();

    // 6. Connect the microphone stream
    await this.connectMicrophone();

    console.log(`[Bridge] Pipeline started (${pipelineVersion}, surah=${preferredSurah || 'auto'}, lang=${translationLang || 'en'})`);
  }

  private async connectMicrophone(): Promise<void> {
    try {
      // MentraOS provides raw PCM 16kHz mono — exactly what AudioPipelineV4 expects
      this.audioStream = await this.session.audio.getMicrophoneStream();

      this.audioStream.on('data', (chunk: Buffer) => {
        if (this.pipeline && !this.destroyed) {
          // Auto-activate pipeline on first audio (mirrors WebSocket server behaviour)
          if (!this.pipeline.active) {
            this.pipeline.start();
          }
          this.pipeline.ingest(chunk);
        }
      });

      this.audioStream.on('error', (err: Error) => {
        console.error('[Bridge] Microphone stream error:', err);
        this.session.layouts.showTextWall('Microphone error\nCheck permissions');
      });

      this.audioStream.on('end', () => {
        console.log('[Bridge] Microphone stream ended');
        if (!this.destroyed) {
          this.pipeline?.stop();
        }
      });

      console.log('[Bridge] Microphone stream connected');
    } catch (err: any) {
      console.error('[Bridge] Failed to get microphone stream:', err);
      this.session.layouts.showTextWall(
        'Microphone unavailable\nGrant microphone permission in the Mentra app',
      );
    }
  }

  private registerControls(): void {
    const session = this.session;

    // ── Button controls ───────────────────────────────────────────────────────
    // Main button: single press = manual advance, long press = manual prev
    session.events.onButtonPress((data) => {
      if (this.destroyed || !this.pipeline) return;

      const { button, type } = data;

      if (button === 'main') {
        if (type === 'press') {
          // Single press → advance to next ayah
          this.pipeline.manualAdvance?.();
          console.log('[Bridge] Button: manual advance');
        } else if (type === 'long_press') {
          // Long press → go back to previous ayah
          this.pipeline.manualPrev?.();
          console.log('[Bridge] Button: manual prev');
        }
      }

      if (button === 'secondary') {
        if (type === 'press') {
          // Secondary button: cycle display mode
          this.cycleDisplayMode();
        } else if (type === 'long_press') {
          // Long press secondary: reset pipeline
          this.pipeline.reset?.();
          session.layouts.showTextWall('Reset\nListening…');
          console.log('[Bridge] Button: reset');
        }
      }

      if (button === 'volume_up' && type === 'press') {
        // Volume up: fast mode toggle
        const enabled = !this.pipeline._fastMode;
        this.pipeline.setFastMode?.(enabled);
        session.layouts.showTextWall(
          enabled ? 'Fast mode ON\nQuick advance' : 'Fast mode OFF',
          { duration: 2000 },
        );
        console.log(`[Bridge] Fast mode: ${enabled}`);
      }

      if (button === 'volume_down' && type === 'press') {
        // Volume down: slow mode toggle
        const enabled = !this.pipeline._slowMode;
        this.pipeline.setSlowMode?.(enabled);
        session.layouts.showTextWall(
          enabled ? 'Slow mode ON\nLingering display' : 'Slow mode OFF',
          { duration: 2000 },
        );
        console.log(`[Bridge] Slow mode: ${enabled}`);
      }
    });

    // ── Head gesture controls ─────────────────────────────────────────────────
    // Nod = advance, Shake = prev, Look up = toggle taraweeh mode
    session.events.onHeadGesture((data) => {
      if (this.destroyed || !this.pipeline) return;
      if (data.confidence < 0.7) return; // ignore low-confidence gestures

      switch (data.gesture) {
        case 'nod':
          this.pipeline.manualAdvance?.();
          console.log('[Bridge] Gesture: nod → advance');
          break;
        case 'shake':
          this.pipeline.manualPrev?.();
          console.log('[Bridge] Gesture: shake → prev');
          break;
        case 'look_up': {
          // Toggle taraweeh mode
          const enabled = !this.pipeline._taraweehMode;
          this.pipeline.setTaraweehMode?.(enabled);
          session.layouts.showTextWall(
            enabled ? 'Taraweeh mode ON' : 'Taraweeh mode OFF',
            { duration: 2000 },
          );
          console.log(`[Bridge] Taraweeh mode: ${enabled}`);
          break;
        }
        case 'look_down':
          // Reset rakat counter in taraweeh mode
          this.pipeline.resetRakat?.();
          session.layouts.showTextWall('Rakat reset', { duration: 1500 });
          console.log('[Bridge] Gesture: look_down → reset rakat');
          break;
      }
    });
  }

  private cycleDisplayMode(): void {
    const modes: DisplayMode[] = ['both', 'arabic', 'translation'];
    const idx = modes.indexOf(this.displayMode);
    this.displayMode = modes[(idx + 1) % modes.length];
    this.formatter.setDisplayMode(this.displayMode);

    const labels: Record<DisplayMode, string> = {
      both: 'Arabic + Transliteration',
      arabic: 'Arabic only',
      translation: 'Translation only',
    };
    this.session.layouts.showTextWall(
      `Display: ${labels[this.displayMode]}`,
      { duration: 2000 },
    );
    console.log(`[Bridge] Display mode: ${this.displayMode}`);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try { this.audioStream?.destroy?.(); } catch (_) {}
    try { this.pipeline?.destroy?.(); } catch (_) {}

    this.audioStream = null;
    this.pipeline = null;
    console.log('[Bridge] Destroyed');
  }
}
