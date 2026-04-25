import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimit,
  purgeExpiredEntries,
  __resetRateLimiterForTests,
} from "./rateLimiter";
import { APIError } from "encore.dev/api";

// Reset internal store between tests — hard reset so no stale entries
// from earlier tests (esp. ones using fake timers) survive.
beforeEach(() => {
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows first request from an IP", () => {
    expect(() => checkRateLimit("1.1.1.1")).not.toThrow();
  });

  it("allows up to MAX_ATTEMPTS (10) requests", () => {
    const ip = "2.2.2.2";
    for (let i = 0; i < 10; i++) {
      expect(() => checkRateLimit(ip)).not.toThrow();
    }
  });

  it("blocks the 11th request with ResourceExhausted", () => {
    const ip = "3.3.3.3";
    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip);
    }
    expect(() => checkRateLimit(ip)).toThrow();
    try {
      checkRateLimit(ip);
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).code).toBe("resource_exhausted");
    }
  });

  it("resets counter after window expires", () => {
    vi.useFakeTimers();
    const ip = "4.4.4.4";

    // Fill up limit
    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip);
    }
    expect(() => checkRateLimit(ip)).toThrow();

    // Advance past the 15-minute window
    vi.advanceTimersByTime(16 * 60 * 1000);

    // Now should be allowed again
    expect(() => checkRateLimit(ip)).not.toThrow();
  });

  it("tracks different IPs independently", () => {
    const ipA = "5.5.5.5";
    const ipB = "6.6.6.6";

    for (let i = 0; i < 10; i++) {
      checkRateLimit(ipA);
    }

    // ipA is blocked, ipB is not
    expect(() => checkRateLimit(ipA)).toThrow();
    expect(() => checkRateLimit(ipB)).not.toThrow();
  });
});

describe("resetRateLimit", () => {
  it("resets counter so IP can make requests again", () => {
    const ip = "7.7.7.7";
    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip);
    }
    expect(() => checkRateLimit(ip)).toThrow();

    resetRateLimit(ip);

    expect(() => checkRateLimit(ip)).not.toThrow();
  });

  it("is a no-op for unknown IP", () => {
    expect(() => resetRateLimit("255.255.255.255")).not.toThrow();
  });
});

describe("purgeExpiredEntries", () => {
  it("removes expired entries from the store", () => {
    vi.useFakeTimers();
    const ip = "8.8.8.8";

    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip);
    }

    // Advance past the window so entry expires
    vi.advanceTimersByTime(16 * 60 * 1000);
    purgeExpiredEntries();

    // After purge, IP can make requests as if new
    expect(() => checkRateLimit(ip)).not.toThrow();
  });

  it("does not remove non-expired entries", () => {
    vi.useFakeTimers();
    const ip = "9.9.9.9";

    for (let i = 0; i < 10; i++) {
      checkRateLimit(ip);
    }

    // Advance only partially – entry still valid
    vi.advanceTimersByTime(5 * 60 * 1000);
    purgeExpiredEntries();

    // Should still be blocked
    expect(() => checkRateLimit(ip)).toThrow();
  });
});

describe("checkRateLimit with options", () => {
  it("honours a custom maxAttempts", () => {
    const key = "opts-max:a";
    for (let i = 0; i < 3; i++) {
      expect(() =>
        checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 }),
      ).not.toThrow();
    }
    expect(() =>
      checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 }),
    ).toThrow();
  });

  it("honours a custom windowMs", () => {
    vi.useFakeTimers();
    const key = "opts-win:a";
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 });
    }
    expect(() =>
      checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 }),
    ).toThrow();

    // Just before the custom window elapses → still blocked
    vi.advanceTimersByTime(30_000);
    expect(() =>
      checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 }),
    ).toThrow();

    // Past the window → fresh counter
    vi.advanceTimersByTime(40_000);
    expect(() =>
      checkRateLimit(key, { maxAttempts: 3, windowMs: 60_000 }),
    ).not.toThrow();
  });

  it("includes Retry-After seconds and the custom message", () => {
    const key = "opts-msg:a";
    for (let i = 0; i < 2; i++) {
      checkRateLimit(key, {
        maxAttempts: 2,
        windowMs: 60_000,
        message: "custom message",
      });
    }
    try {
      checkRateLimit(key, {
        maxAttempts: 2,
        windowMs: 60_000,
        message: "custom message",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      expect((err as APIError).code).toBe("resource_exhausted");
      expect((err as APIError).message).toMatch(/custom message/);
      expect((err as APIError).message).toMatch(/Retry after \d+s/);
    }
  });

  it("tracks Finance composite keys independently from IP keys", () => {
    // Same process, different key namespaces must not interfere.
    const financeKey = "tan-complete:abc-123";
    const ipKey = "1.2.3.4";

    for (let i = 0; i < 5; i++) {
      checkRateLimit(financeKey, { maxAttempts: 5, windowMs: 60_000 });
    }
    expect(() =>
      checkRateLimit(financeKey, { maxAttempts: 5, windowMs: 60_000 }),
    ).toThrow();

    // Auth path still has its full quota.
    for (let i = 0; i < 10; i++) {
      expect(() => checkRateLimit(ipKey)).not.toThrow();
    }
  });
});

describe("__resetRateLimiterForTests", () => {
  it("clears the whole store", () => {
    const a = "reset-helper:a";
    const b = "reset-helper:b";
    for (let i = 0; i < 10; i++) checkRateLimit(a);
    for (let i = 0; i < 10; i++) checkRateLimit(b);
    expect(() => checkRateLimit(a)).toThrow();
    expect(() => checkRateLimit(b)).toThrow();

    __resetRateLimiterForTests();

    expect(() => checkRateLimit(a)).not.toThrow();
    expect(() => checkRateLimit(b)).not.toThrow();
  });
});
