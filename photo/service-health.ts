/**
 * External ML-service health monitor.
 *
 * Tracks reachability of the three external services:
 *   - insightface  (face detection)
 *   - embedding    (CLIP / DINOv2)
 *   - landmark     (Grounding DINO)
 *
 * Each service is pinged at a configurable interval.
 * Workers that depend on a service can call `assertServiceAvailable()` or
 * check `isServiceAvailable()` before starting work.  When a service comes
 * back up after being marked as down the relevant scan-workers are woken
 * automatically.
 */

export type ExternalServiceName = "insightface" | "embedding" | "landmark";

export interface ServiceHealthStatus {
  name: ExternalServiceName;
  available: boolean;
  lastChecked: string | null; // ISO timestamp
  lastError: string | null;
}

// ─── configuration ────────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.HEALTH_CHECK_INTERVAL_MS ?? "600000",
  10,
);
const HEALTH_CHECK_TIMEOUT_MS = parseInt(
  process.env.HEALTH_CHECK_TIMEOUT_MS ?? "60000",
  10,
);

const serviceUrls: Record<ExternalServiceName, string> = {
  insightface:
    process.env.INSIGHTFACE_SERVICE_URL ?? "http://localhost:8000",
  embedding:
    process.env.EMBEDDING_SERVICE_URL ?? "http://localhost:8001",
  landmark:
    process.env.LANDMARK_SERVICE_URL ?? "http://localhost:8002",
};

// ─── state ────────────────────────────────────────────────────────────────────

interface ServiceState {
  available: boolean;
  lastChecked: Date | null;
  lastError: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

const state = new Map<ExternalServiceName, ServiceState>([
  ["insightface", { available: false, lastChecked: null, lastError: null, timer: null }],
  ["embedding",   { available: false, lastChecked: null, lastError: null, timer: null }],
  ["landmark",    { available: false, lastChecked: null, lastError: null, timer: null }],
]);

// Callbacks to invoke when a previously-down service comes back up.
const recoveryCallbacks: Array<(name: ExternalServiceName) => void> = [];

// ─── public API ───────────────────────────────────────────────────────────────

/** Returns true if the service is currently considered reachable. */
export function isServiceAvailable(name: ExternalServiceName): boolean {
  return state.get(name)?.available ?? false;
}

/**
 * Throws a ServiceUnavailableError if the service is not reachable.
 * Scan-worker job handlers can call this at the top of their work so the job
 * is deferred (not failed) until the service recovers.
 */
export function assertServiceAvailable(name: ExternalServiceName): void {
  if (!isServiceAvailable(name)) {
    throw new ServiceUnavailableError(name);
  }
}

/** Error class distinguishable from generic job failures. */
export class ServiceUnavailableError extends Error {
  constructor(public readonly serviceName: ExternalServiceName) {
    super(`External service '${serviceName}' is not available`);
    this.name = "ServiceUnavailableError";
  }
}

/** Register a callback to be invoked whenever a service recovers. */
export function onServiceRecovered(cb: (name: ExternalServiceName) => void): void {
  recoveryCallbacks.push(cb);
}

/** Snapshot of all service health states for the API response. */
export function getAllServiceHealthStatuses(): ServiceHealthStatus[] {
  return Array.from(state.entries()).map(([name, s]) => ({
    name,
    available: s.available,
    lastChecked: s.lastChecked?.toISOString() ?? null,
    lastError: s.lastError,
  }));
}

// ─── health-check logic ───────────────────────────────────────────────────────

async function checkService(name: ExternalServiceName): Promise<void> {
  const s = state.get(name)!;
  const url = `${serviceUrls[name]}/health`;
  const wasAvailable = s.available;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      s.available = true;
      s.lastError = null;
    } else {
      s.available = false;
      s.lastError = `HTTP ${res.status}`;
    }
  } catch (err: any) {
    s.available = false;
    s.lastError = err?.message ?? String(err);
  }

  s.lastChecked = new Date();

  if (!wasAvailable && s.available) {
    console.log(`[service-health] '${name}' is now available – waking workers`);
    for (const cb of recoveryCallbacks) {
      try { cb(name); } catch { /* ignore */ }
    }
  } else if (wasAvailable && !s.available) {
    console.warn(`[service-health] '${name}' became unavailable: ${s.lastError}`);
  }
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start periodic health-checks for all external services.
 * Safe to call multiple times (idempotent).
 */
export function startHealthChecks(): void {
  for (const [name, s] of state.entries()) {
    if (s.timer) continue; // already running

    // First check immediately (non-blocking)
    void checkService(name);

    s.timer = setInterval(() => void checkService(name), HEALTH_CHECK_INTERVAL_MS);
  }
  console.log(
    `[service-health] health-checks started (interval=${HEALTH_CHECK_INTERVAL_MS}ms, timeout=${HEALTH_CHECK_TIMEOUT_MS}ms)`,
  );
}

export function stopHealthChecks(): void {
  for (const s of state.values()) {
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }
}

