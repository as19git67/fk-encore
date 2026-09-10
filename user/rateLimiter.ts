import { APIError } from "encore.dev/api";
import { currentRequest } from "encore.dev";

console.log("[boot] user/rateLimiter.ts: all imports resolved");

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store – replace with Encore Cache (Redis) for multi-instance deployments
const store = new Map<string, RateLimitEntry>();

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Whether X-Forwarded-For / X-Real-IP may be believed.
 *
 * These are client-supplied unless a reverse proxy overwrites them, so
 * trusting them by default let anyone mint a fresh rate-limit bucket per
 * request just by varying a header. Off unless the deployment states that it
 * terminates behind a proxy that sets them.
 */
function trustsProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

/**
 * Identify the calling client, or null when there is no trustworthy signal.
 *
 * Returning null rather than a placeholder is deliberate: a shared "unknown"
 * bucket is worse than no bucket, because one caller exhausting it locks out
 * everyone else. Callers should skip the IP-scoped limit when this is null
 * and rely on a limit scoped to the thing being attacked (an account, a key)
 * instead — see loginLogic.
 */
export function getClientIp(): string | null {
  const req = currentRequest();
  if (req?.type !== "api-call" || !trustsProxyHeaders()) return null;

  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const val = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    // Left-most entry is the originating client; the rest are proxies.
    const first = val.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    const val = Array.isArray(realIp) ? realIp[0] : realIp;
    if (val.trim()) return val.trim();
  }
  return null;
}

export interface RateLimitOpts {
  /** Default: 10. */
  maxAttempts?: number;
  /** Default: 15 minutes. */
  windowMs?: number;
  /**
   * Custom error message when the limit is hit. The computed
   * Retry-After seconds are appended automatically.
   */
  message?: string;
}

/**
 * Enforce a sliding-window rate limit keyed by `key`. The original
 * auth path passed an IP here; newer callers (finance) key by
 * composite like `"tan-complete:<uuid>"` — see
 * docs/finance-rate-limiting.md §2 for the contract.
 *
 * Throws APIError.resourceExhausted (HTTP 429) with a message that
 * tells the caller how many seconds to wait.
 */
export function checkRateLimit(
  key: string,
  opts: RateLimitOpts = {},
): void {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (entry.count >= maxAttempts) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const base =
      opts.message ??
      `Too many attempts. Try again in ${formatDuration(windowMs)}.`;
    throw APIError.resourceExhausted(
      `${base} Retry after ${retryAfterSec}s.`,
    );
  }

  entry.count += 1;
}

/** Reset the counter for a key on successful authentication / action. */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

/** Periodic cleanup to prevent unbounded memory growth. */
export function purgeExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}

/**
 * Test-only reset — clears the whole store so tests don't leak state
 * through the in-memory Map. Not intended for production code paths.
 */
export function __resetRateLimiterForTests(): void {
  store.clear();
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}h`;
  }
  return `${minutes}m`;
}
