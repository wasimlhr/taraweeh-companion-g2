/**
 * Groq free-tier headroom for a measured request pattern.
 *
 * The limit that actually bites is not requests per minute, it is audio seconds
 * per hour, because Groq bills a 10-second minimum per request:
 *
 *   "Minimum Billed Length: 10 seconds. If you submit a request less than this,
 *    you will still be billed for 10 seconds."
 *   https://console.groq.com/docs/speech-to-text
 *
 * So a 6-second window costs the same quota as a 10-second one, and 12 requests
 * a minute spends the entire hourly allowance in exactly one hour.
 */
export const GROQ_FREE = {
  rpm: 20,
  rpd: 2000,
  ash: 7200,          // audio seconds per hour
  asd: 28800,         // audio seconds per day
  minBilledSec: 10,
};

export function quotaProjection(calls, elapsedMs) {
  const minutes = elapsedMs / 60000;
  const rpm = calls.length / minutes;
  const billedSec = calls.reduce(
    (sum, c) => sum + Math.max(GROQ_FREE.minBilledSec, c.windowMs / 1000), 0);
  const billedPerMin = billedSec / minutes;
  const ashUsed = billedPerMin * 60;
  return {
    rpm,
    reqPerHour: rpm * 60,
    billedPerMin,
    ashUsed,
    ashPct: (ashUsed / GROQ_FREE.ash) * 100,
    rpmPct: (rpm / GROQ_FREE.rpm) * 100,
    // How long a continuous session can run before the hourly audio allowance
    // is gone. Anything under 60 means 429s inside the first hour.
    minutesToAsh: billedPerMin > 0 ? GROQ_FREE.ash / billedPerMin : Infinity,
    reqIn90Min: rpm * 90,
    rpdPct: ((rpm * 90) / GROQ_FREE.rpd) * 100,
    wastedPct: billedSec > 0
      ? (1 - calls.reduce((s, c) => s + Math.min(GROQ_FREE.minBilledSec, c.windowMs / 1000), 0) / billedSec) * 100
      : 0,
  };
}

export function quotaReport(out, calls, elapsedMs) {
  if (!calls.length) { out('Groq free tier      : no requests'); return; }
  const q = quotaProjection(calls, elapsedMs);
  const verdict = q.minutesToAsh >= 90 ? 'ok for a 90min session'
    : q.minutesToAsh >= 60 ? `429s after ~${q.minutesToAsh.toFixed(0)}min`
      : `429s after only ~${q.minutesToAsh.toFixed(0)}min`;
  out(`Groq RPM            : ${q.rpm.toFixed(1)} of 20 (${q.rpmPct.toFixed(0)}%)`);
  out(`Groq audio-sec/hour : ${Math.round(q.ashUsed)} of 7200 (${q.ashPct.toFixed(0)}%) — ${verdict}`);
  out(`  billed at 10s min : ${q.wastedPct.toFixed(0)}% of that quota is padding on sub-10s windows`);
  out(`Groq req in 90min   : ${Math.round(q.reqIn90Min)} of 2000/day (${q.rpdPct.toFixed(0)}%)`);
}
