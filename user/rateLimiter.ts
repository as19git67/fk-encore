import { APIError } from "encore.dev/api";
import { currentRequest } from "encore.dev";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store – replace with Encore Cache (Redis) for multi-instance deployments
const store = new Map<string, RateLimitEntry>();

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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

/**
 * Enforce a sliding-window rate limit keyed by IP address.
 * Throws HTTP 429 when the limit is exceeded.
 */
export function checkRateLimit(ip: string): void {
  const now = Date.now();
  const entry = store.get(ip);

  if (!entry || entry.resetAt < now) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  if (entry.count >= MAX_ATTEMPTS) {
    throw APIError.resourceExhausted(
      "Too many authentication attempts. Try again in 15 minutes."
    );
  }

  entry.count += 1;
}

/**
 * Reset the counter for an IP on successful authentication.
 */
export function resetRateLimit(ip: string): void {
  store.delete(ip);
}

/**
 * Periodic cleanup to prevent unbounded memory growth.
 */
export function purgeExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}
