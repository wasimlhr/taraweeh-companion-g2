const DEFAULT_TIMEOUT_MS = 30_000;

export class ProviderTimeoutError extends Error {
  constructor(provider, timeoutMs) {
    super(`${provider} request timed out after ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
    this.code = 'PROVIDER_TIMEOUT';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export function requestSignal(provider, parentSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('Pipeline cancelled'));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ProviderTimeoutError(provider, timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
    classify(error) {
      if (timedOut) return new ProviderTimeoutError(provider, timeoutMs);
      if (parentSignal?.aborted) {
        const cancelled = new Error(`${provider} request cancelled`);
        cancelled.name = 'AbortError';
        cancelled.code = 'PROVIDER_CANCELLED';
        return cancelled;
      }
      return error;
    },
  };
}

export async function fetchWithDeadline(provider, url, init = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const request = requestSignal(provider, options.signal, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: request.signal });
  } catch (error) {
    throw request.classify(error);
  } finally {
    request.cleanup();
  }
}

export function delayWithSignal(ms, signal, provider = 'Provider') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error(`${provider} request cancelled`);
      error.name = 'AbortError'; error.code = 'PROVIDER_CANCELLED';
      reject(error); return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() { cleanup(); resolve(); }
    function aborted() {
      cleanup();
      const error = new Error(`${provider} request cancelled`);
      error.name = 'AbortError'; error.code = 'PROVIDER_CANCELLED';
      reject(error);
    }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
