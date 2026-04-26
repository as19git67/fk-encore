import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetLocalCron,
  dailyAtUtc,
  everyMs,
  schedule,
  startLocalCron,
} from "./local-cron";

afterEach(() => {
  _resetLocalCron();
  vi.useRealTimers();
});

describe("everyMs", () => {
  it("returns now+interval", () => {
    const after = new Date("2026-04-26T10:00:00Z");
    const next = everyMs(5 * 60_000)(after);
    expect(next?.toISOString()).toBe("2026-04-26T10:05:00.000Z");
  });
});

describe("dailyAtUtc", () => {
  it("returns today's slot when it's still in the future", () => {
    const after = new Date("2026-04-26T01:00:00Z");
    const next = dailyAtUtc(3, 0)(after);
    expect(next?.toISOString()).toBe("2026-04-26T03:00:00.000Z");
  });

  it("rolls to tomorrow when today's slot is past", () => {
    const after = new Date("2026-04-26T05:00:00Z");
    const next = dailyAtUtc(3, 0)(after);
    expect(next?.toISOString()).toBe("2026-04-27T03:00:00.000Z");
  });

  it("rolls to tomorrow when called exactly at the slot time", () => {
    const after = new Date("2026-04-26T03:00:00Z");
    const next = dailyAtUtc(3, 0)(after);
    expect(next?.toISOString()).toBe("2026-04-27T03:00:00.000Z");
  });

  it("supports a non-zero minute", () => {
    const after = new Date("2026-04-26T03:30:00Z");
    const next = dailyAtUtc(3, 45)(after);
    expect(next?.toISOString()).toBe("2026-04-26T03:45:00.000Z");
  });
});

describe("scheduler", () => {
  it("fires the registered job after the requested delay and re-arms", async () => {
    vi.useFakeTimers();
    const runs: number[] = [];

    schedule({
      name: "test-tick",
      nextFire: everyMs(1000),
      run: async () => {
        runs.push(Date.now());
      },
    });
    startLocalCron();

    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2500);
    expect(runs).toHaveLength(4);
  });

  it("logs and continues when the handler throws", async () => {
    vi.useFakeTimers();
    let attempts = 0;

    schedule({
      name: "test-throw",
      nextFire: everyMs(500),
      run: async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
      },
    });
    startLocalCron();

    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(2);
  });

  it("deactivates the job when nextFire returns null", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let calls = 0;

    schedule({
      name: "test-once",
      nextFire: () => {
        calls++;
        return calls === 1 ? new Date(Date.now() + 100) : null;
      },
      run: async () => {
        runs++;
      },
    });
    startLocalCron();

    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
  });

  it("rejects schedule() after start", () => {
    schedule({
      name: "test-early",
      nextFire: everyMs(1000),
      run: async () => {},
    });
    startLocalCron();

    expect(() =>
      schedule({
        name: "test-late",
        nextFire: everyMs(1000),
        run: async () => {},
      }),
    ).toThrow(/cannot schedule/);
  });
});
