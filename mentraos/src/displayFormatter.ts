/**
 * Display Formatter — converts AudioPipelineV4 state update messages into
 * MentraOS layout calls.
 *
 * MentraOS glasses have a small HUD display. We keep text concise:
 *   - SEARCHING: show "Listening…" + top candidate if available
 *   - LOCKED:    show Arabic verse + transliteration or translation
 *   - RESUMING:  show "Re-syncing…"
 *   - LOST:      show "Lost — speak clearly"
 *   - TARAWEEH:  show rakat/position overlay
 */

import type { AppSession } from '@mentra/sdk';

// ── Types mirrored from AudioPipelineV4 state messages ───────────────────────

export type DisplayMode = 'arabic' | 'translation' | 'both';

export interface LockedVerse {
  surah: number;
  ayah: number;
  surahName: string;
  ayahTotal: number;
  arabic: string;
  transliteration: string;
  translation: string;
  translationGlasses?: string;
}

export interface StateUpdateMsg {
  type: 'state_update';
  state: 'SEARCHING' | 'LOCKED' | 'RESUMING' | 'LOST' | 'TARAWEEH';
  lockedVerse?: LockedVerse;
  candidates?: Array<{ surah: number; ayah: number; score: number; arabic: string }>;
  taraweehPosition?: string;
  taraweehPositionLatin?: string;
  rakat?: number;
  confidence?: number;
}

export interface SysStatusMsg {
  type: 'sys_status';
  component: string;
  status: string;
  provider?: string;
  message?: string;
}

export type PipelineMsg = StateUpdateMsg | SysStatusMsg | { type: string; [key: string]: unknown };

// ── Formatter ─────────────────────────────────────────────────────────────────

export class DisplayFormatter {
  private session: AppSession;
  private displayMode: DisplayMode;
  private lastState: string = '';
  private lastAyahKey: string = '';

  constructor(session: AppSession, displayMode: DisplayMode = 'both') {
    this.session = session;
    this.displayMode = displayMode;
  }

  /** Handle any message from the pipeline and update the glasses display. */
  handle(msg: PipelineMsg): void {
    switch (msg.type) {
      case 'state_update':
        this.handleStateUpdate(msg as StateUpdateMsg);
        break;
      case 'sys_status':
        this.handleSysStatus(msg as SysStatusMsg);
        break;
      // Ignore other message types (pipeline_version, pong, etc.)
    }
  }

  private handleStateUpdate(msg: StateUpdateMsg): void {
    const { state, lockedVerse, candidates, taraweehPosition, taraweehPositionLatin, rakat } = msg;

    switch (state) {
      case 'SEARCHING': {
        // Show top candidate if we have one, otherwise just "Listening…"
        const top = candidates?.[0];
        if (top && top.score > 0.3) {
          const ref = `${top.surah}:${top.ayah}`;
          // Truncate Arabic to ~60 chars for the small display
          const arabic = truncate(top.arabic, 60);
          this.session.layouts.showDoubleTextWall(
            `Listening… (${ref})`,
            arabic,
          );
        } else {
          this.session.layouts.showTextWall('Listening…\nRecite to begin tracking');
        }
        this.lastState = 'SEARCHING';
        break;
      }

      case 'LOCKED': {
        if (!lockedVerse) break;
        const ayahKey = `${lockedVerse.surah}:${lockedVerse.ayah}`;

        // Avoid redundant display updates for the same ayah
        if (ayahKey === this.lastAyahKey && this.lastState === 'LOCKED') break;
        this.lastAyahKey = ayahKey;
        this.lastState = 'LOCKED';

        this.showLockedVerse(lockedVerse);
        break;
      }

      case 'RESUMING': {
        if (lockedVerse) {
          // Show last known verse dimmed with a re-syncing indicator
          const ref = `${lockedVerse.surahName} ${lockedVerse.surah}:${lockedVerse.ayah}`;
          this.session.layouts.showDoubleTextWall(
            `Re-syncing… (${ref})`,
            truncate(lockedVerse.arabic, 80),
          );
        } else {
          this.session.layouts.showTextWall('Re-syncing…\nKeep reciting');
        }
        this.lastState = 'RESUMING';
        break;
      }

      case 'LOST': {
        this.session.layouts.showTextWall('Lost track\nSpeak clearly or pause briefly');
        this.lastState = 'LOST';
        this.lastAyahKey = '';
        break;
      }

      case 'TARAWEEH': {
        // Taraweeh overlay: show rakat position
        const pos = taraweehPosition || '';
        const posLatin = taraweehPositionLatin || '';
        const rakatStr = rakat !== undefined ? `Rakat ${rakat}` : '';
        const lines = [pos, posLatin, rakatStr].filter(Boolean).join('\n');
        this.session.layouts.showTextWall(lines || 'Taraweeh Mode');
        this.lastState = 'TARAWEEH';
        break;
      }
    }
  }

  private showLockedVerse(verse: LockedVerse): void {
    const ref = `${verse.surahName} ${verse.surah}:${verse.ayah}/${verse.ayahTotal}`;

    switch (this.displayMode) {
      case 'arabic': {
        // Reference card: title = surah:ayah, body = Arabic
        this.session.layouts.showReferenceCard(
          ref,
          truncate(verse.arabic, 120),
        );
        break;
      }

      case 'translation': {
        // Reference card: title = surah:ayah, body = translation
        const translation = verse.translationGlasses || verse.translation;
        this.session.layouts.showReferenceCard(
          ref,
          truncate(translation, 140),
        );
        break;
      }

      case 'both':
      default: {
        // Double text wall: top = Arabic, bottom = translation
        // If transliteration is available, prefer it over raw translation for bottom
        // (easier to follow along phonetically)
        const bottom = verse.transliteration
          ? truncate(verse.transliteration, 100)
          : truncate(verse.translationGlasses || verse.translation, 100);

        this.session.layouts.showDoubleTextWall(
          // Top: Arabic (right-to-left — MentraOS renders as-is)
          truncate(verse.arabic, 80),
          // Bottom: transliteration or translation + reference
          `${bottom}\n— ${ref}`,
        );
        break;
      }
    }
  }

  private handleSysStatus(msg: SysStatusMsg): void {
    // Only surface critical errors to the display; routine status is logged only
    if (msg.status === 'error' && msg.component === 'model') {
      const text = msg.message || 'Transcription error';
      this.session.layouts.showTextWall(`Error: ${text}\nCheck API key settings`);
    }
    // 'ready', 'standby', 'loading' etc. are silent — don't interrupt the verse display
  }

  /** Update display mode at runtime (e.g. from a button press). */
  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    // Force re-render on next state update by clearing the last ayah key
    this.lastAyahKey = '';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}
