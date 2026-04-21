/**
 * Shared fetch wrapper that enforces a request-level timeout on every call
 * to an external ML service (embedding, insightface, landmark, …).
 *
 * Why this matters for photo-view responsiveness:
 * A scan worker that is waiting on a slow ML service holds both a libuv
 * network slot and — crucially — the DB semaphore slot it acquired before
 * dispatching the job (see photo/worker-db-slots.ts). If the ML service
 * stalls indefinitely (GPU OOM, Python GIL deadlock, container hang), the
 * DB slot never frees, which eventually backs up the HTTP handlers that
 * back /photos/index. A hard timeout is the simplest way to guarantee
 * progress: the worker aborts, the slot is released, and the job is
 * retried or marked failed.
 *
 * Configuration (env):
 *   ML_RPC_TIMEOUT_MS              – default timeout for most calls (default: 60000)
 *   ML_RPC_QUICK_TIMEOUT_MS        – for latency-sensitive calls hit on
 *                                    the request path (search, parse,
 *                                    similar-groups) (default: 15000)
 *
 * Callers may still override per-call by passing an explicit timeoutMs.
 */

export const ML_RPC_TIMEOUT_MS = (() => {
  const raw = process.env.ML_RPC_TIMEOUT_MS;
  if (raw === undefined) return 60_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

export const ML_RPC_QUICK_TIMEOUT_MS = (() => {
  const raw = process.env.ML_RPC_QUICK_TIMEOUT_MS;
  if (raw === undefined) return 15_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

/**
 * Error thrown when an ML RPC exceeds its timeout. Separate from generic
 * AbortError so scan workers can distinguish it from user-triggered
 * cancellation and apply appropriate retry / defer logic.
 */
export class MlRpcTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`ML RPC to ${url} exceeded ${timeoutMs}ms`);
    this.name = "MlRpcTimeoutError";
  }
}

/**
 * Thin wrapper around fetch() that aborts after `timeoutMs` and raises a
 * `MlRpcTimeoutError` instead of the raw AbortError.
 *
 * The abort is via AbortSignal.timeout() when no caller-provided signal is
 * supplied; when one IS provided we chain a second signal so either the
 * caller or the timeout can abort the request.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = ML_RPC_TIMEOUT_MS, signal: callerSignal, ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
  }

  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (err: any) {
    // `fetch` surfaces the abort reason as an AbortError. Map the timeout
    // case to our dedicated error so callers can branch on it, but leave
    // caller-triggered aborts alone.
    if (controller.signal.aborted && !(callerSignal?.aborted)) {
      throw new MlRpcTimeoutError(input, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
