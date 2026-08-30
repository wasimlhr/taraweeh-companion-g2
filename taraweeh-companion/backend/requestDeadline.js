/**
 * One deadline for a WHOLE provider request — connect, headers, AND body.
 *
 * `AbortSignal.timeout()` inside the fetch init would cover the body too, but
 * it cannot be combined with the pipeline's destroy signal on Node 18 (no
 * AbortSignal.any), so both are funnelled through one controller here.
 *
 * Contract: call `done()` only after the response body has been fully
 * consumed (a `finally` around fetch + res.json()/res.text()). Clearing the
 * timer when headers arrive would leave a stalled body read running forever
 * with nothing able to cancel it.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export function providerDeadline(extra = {}) {
  const timeoutMs = (Number.isFinite(extra.timeoutMs) && extra.timeoutMs > 0)
    ? extra.timeoutMs : DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Provider request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  const parent = extra.signal;
  const onParentAbort = () => controller.abort(parent.reason || new Error('Request cancelled'));
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}
