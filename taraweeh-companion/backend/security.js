import { createHash, timingSafeEqual } from 'crypto';

export const MAX_WS_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD_BYTES) || 96 * 1024;
export const MAX_PCM_FRAME = Number(process.env.WS_MAX_PCM_FRAME_BYTES) || 64 * 1024;

export function validPcm(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= MAX_PCM_FRAME && buffer.length % 2 === 0;
}

export function validRecoveryState(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const surah = Number(value.surah);
  const ayah = Number(value.ayah);
  const pace = Number(value.pace) || 0;
  const ts = Number(value.ts);
  if (!Number.isInteger(surah) || surah < 1 || surah > 114 || !Number.isInteger(ayah) || ayah < 1 || ayah > 300) return null;
  if (!Number.isFinite(ts) || ts > now + 60_000 || now - ts > 30 * 60_000) return null;
  return { surah, ayah, pace: Math.max(0, Math.min(pace, 60_000)), ts };
}

export function tokenMatches(supplied, configured) {
  if (!configured || !supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(configured));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tokenPrincipal(token) {
  if (!token) return '';
  return createHash('sha256').update(String(token)).digest('hex');
}

export class SlidingQuota {
  constructor({ limit, windowMs }) { this.limit = limit; this.windowMs = windowMs; this.entries = new Map(); }
  take(principal, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const recent = (this.entries.get(principal) || []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) { this.entries.set(principal, recent); return false; }
    recent.push(now); this.entries.set(principal, recent); return true;
  }
}

export class ConcurrencyCeiling {
  constructor({ globalLimit, principalLimit }) {
    this.globalLimit = globalLimit;
    this.principalLimit = principalLimit;
    this.globalActive = 0;
    this.principalActive = new Map();
  }
  acquire(principal) {
    const active = this.principalActive.get(principal) || 0;
    if (this.globalActive >= this.globalLimit || active >= this.principalLimit) return null;
    this.globalActive += 1;
    this.principalActive.set(principal, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalActive -= 1;
      const remaining = (this.principalActive.get(principal) || 1) - 1;
      if (remaining > 0) this.principalActive.set(principal, remaining);
      else this.principalActive.delete(principal);
    };
  }
}
