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
 * Extract the client IP from the current Encore request context.
 * Reads X-Forwarded-For first (set by reverse proxies), then X-Real-IP.
 */
export function getClientIp(): string {
  const req = currentRequest();
  if (req?.type === "api-call") {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const val = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return val.split(",")[0].trim();
    }
    const realIp = req.headers["x-real-ip"];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }
  }
  return "unknown";
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
