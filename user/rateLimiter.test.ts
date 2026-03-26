import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit, resetRateLimit, purgeExpiredEntries } from "./rateLimiter";
import { APIError } from "encore.dev/api";

// Reset internal store between tests by resetting + purging
beforeEach(() => {
  // Purge all entries to start fresh
  purgeExpiredEntries();
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
