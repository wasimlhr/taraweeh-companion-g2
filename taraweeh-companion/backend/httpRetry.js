/**
 * Shared HTTP error helpers for STT providers.
 */

export function parseRetryAfterMs(res, body = '') {
  const retryAfterHdr = res?.headers?.get?.('retry-after')
    || res?.headers?.get?.('x-ratelimit-reset')
    || '';
  let retryAfterSec = parseInt(retryAfterHdr, 10);
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
    const m = String(body).match(/try again in\s+(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
    if (m) retryAfterSec = Math.ceil((parseInt(m[1] || '0', 10) * 60) + parseFloat(m[2]));
  }
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return 0;
  return retryAfterSec * 1000;
}

export function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 529;
}

export function httpError(provider, res, body, extra = {}) {
  const status = res?.status || 0;
  const err = new Error(`${provider} HTTP ${status}: ${String(body).slice(0, 200)}`);
  err.status = status;
  err.retryAfterMs = parseRetryAfterMs(res, body);
  err.retryable = isRetryableStatus(status);
  Object.assign(err, extra);
  return err;
}
