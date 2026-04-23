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
 * Additionally, this module owns a *per-service concurrency limiter* so a
 * CPU-only host running the Python ML containers is never hit by more
 * than `ML_CONCURRENCY_<NAME>` requests in parallel. Important on weak
 * servers: without the limiter the embedding and quality workers would
 * each drive a request at the same embedding container, each taking
 * minutes, each making the other slower.
 *
 * Configuration (env):
 *   ML_RPC_TIMEOUT_MS              – default timeout for most calls (default: 600000 = 10 min)
 *   ML_RPC_QUICK_TIMEOUT_MS        – for latency-sensitive calls hit on
 *                                    the request path (search, parse,
 *                                    similar-groups) (default: 60000 = 1 min)
 *   ML_CONCURRENCY_EMBEDDING       – max parallel requests to embedding   (default: 1)
 *   ML_CONCURRENCY_INSIGHTFACE     – max parallel requests to insightface (default: 1)
 *   ML_CONCURRENCY_LANDMARK        – max parallel requests to landmark    (default: 1)
 *
 * Callers may still override per-call by passing an explicit timeoutMs.
 * Callers that should be serialized through the concurrency limiter pass
 * `queue: "embedding" | "insightface" | "landmark"`.
 */

export const ML_RPC_TIMEOUT_MS = (() => {
  const raw = process.env.ML_RPC_TIMEOUT_MS;
  if (raw === undefined) return 600_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 600_000;
})();

export const ML_RPC_QUICK_TIMEOUT_MS = (() => {
  const raw = process.env.ML_RPC_QUICK_TIMEOUT_MS;
  if (raw === undefined) return 60_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
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

// ─── per-service concurrency limiter ──────────────────────────────────────────

export type MlServiceQueueKey = "embedding" | "insightface" | "landmark";

function readConcurrency(envVar: string): number {
  const raw = process.env[envVar];
  if (raw === undefined) return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const CAPACITY: Record<MlServiceQueueKey, number> = {
  embedding: readConcurrency("ML_CONCURRENCY_EMBEDDING"),
  insightface: readConcurrency("ML_CONCURRENCY_INSIGHTFACE"),
  landmark: readConcurrency("ML_CONCURRENCY_LANDMARK"),
};

interface Semaphore {
  capacity: number;
  inUse: number;
  waiters: Array<() => void>;
}

const semaphores: Record<MlServiceQueueKey, Semaphore> = {
  embedding: { capacity: CAPACITY.embedding, inUse: 0, waiters: [] },
  insightface: { capacity: CAPACITY.insightface, inUse: 0, waiters: [] },
  landmark: { capacity: CAPACITY.landmark, inUse: 0, waiters: [] },
};

async function acquire(queue: MlServiceQueueKey, signal?: AbortSignal | null): Promise<void> {
  const s = semaphores[queue];
  if (s.inUse < s.capacity) {
    s.inUse++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const idx = s.waiters.indexOf(wake);
      if (idx >= 0) s.waiters.splice(idx, 1);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    s.waiters.push(wake);
  });
}

function release(queue: MlServiceQueueKey): void {
  const s = semaphores[queue];
  if (s.inUse <= 0) return;
  const next = s.waiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter — inUse stays the same.
    next();
    return;
  }
  s.inUse--;
}

/** Observability helper for the admin endpoint. */
export function mlQueueStats(): Record<MlServiceQueueKey, { capacity: number; inUse: number; waiting: number }> {
  return {
    embedding: { capacity: semaphores.embedding.capacity, inUse: semaphores.embedding.inUse, waiting: semaphores.embedding.waiters.length },
    insightface: { capacity: semaphores.insightface.capacity, inUse: semaphores.insightface.inUse, waiting: semaphores.insightface.waiters.length },
    landmark: { capacity: semaphores.landmark.capacity, inUse: semaphores.landmark.inUse, waiting: semaphores.landmark.waiters.length },
  };
}

/**
 * Thin wrapper around fetch() that aborts after `timeoutMs` and raises a
 * `MlRpcTimeoutError` instead of the raw AbortError.
 *
 * The abort is via AbortSignal.timeout() when no caller-provided signal is
 * supplied; when one IS provided we chain a second signal so either the
 * caller or the timeout can abort the request.
 *
 * When `queue` is set, the request waits for a slot in the per-service
 * concurrency limiter before dispatching — the timeout clock only starts
 * AFTER the slot is acquired, so a queued request cannot falsely report a
 * timeout because it waited a long time for its turn.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit & { timeoutMs?: number; queue?: MlServiceQueueKey } = {},
): Promise<Response> {
  const { timeoutMs = ML_RPC_TIMEOUT_MS, queue, signal: callerSignal, ...rest } = init;

  if (queue) {
    await acquire(queue, callerSignal);
  }

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
    // Undici's own internal timeouts (headers / body / connect) and common
    // transient socket errors surface as `TypeError: fetch failed` with the
    // real error on `err.cause`. These are retryable — the ML container is
    // slow or restarting, not permanently broken. Map them to
    // MlRpcTimeoutError so the scan-worker defers the job instead of losing
    // the photo's scan data.
    if (isTransientFetchError(err)) {
      throw new MlRpcTimeoutError(input, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (queue) release(queue);
  }
}

/** Undici/Node error codes that indicate a retryable network-level failure. */
const TRANSIENT_FETCH_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isTransientFetchError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: any = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string" && TRANSIENT_FETCH_CODES.has(current.code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
