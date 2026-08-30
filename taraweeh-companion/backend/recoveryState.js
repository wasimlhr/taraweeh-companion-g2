/**
 * Client-carried recovery state, validated before it may seed a pipeline.
 *
 * The client stores whatever the backend last emitted and echoes it on the
 * next init, so a position survives reconnects and backend restarts without
 * any cross-user server state (the old /tmp file restored one user's position
 * into ANY user's fresh pipeline on a shared host).
 *
 * Range checks alone are not enough — surah 1 has 7 ayahs, so {surah:1,
 * ayah:250} passes a 1..300 bound yet renders a blank verse; the ayah must
 * actually exist in the corpus.
 */
import { getAyah } from './keywordMatcher.js';

export const RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;

export function validRecoveryState(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const surah = Number(value.surah);
  const ayah = Number(value.ayah);
  const pace = Number(value.pace) || 0;
  const ts = Number(value.ts);
  if (!Number.isInteger(surah) || !Number.isInteger(ayah)) return null;
  if (!Number.isFinite(ts) || ts > now + 60_000 || now - ts > RECOVERY_MAX_AGE_MS) return null;
  if (!getAyah(surah, ayah)) return null;
  return { surah, ayah, pace: Math.max(0, Math.min(pace, 60_000)), ts };
}
