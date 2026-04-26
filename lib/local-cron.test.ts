import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetLocalCron,
  dailyAtUtc,
  everyMs,
  inspectJobs,
  runJobNow,
  schedule,
  setJobEnabled,
  setLocalCronHooks,
  startLocalCron,
  type JobInspectEntry,
  type JobPersistedState,
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

  it("auto-arms a job that gets scheduled after start", async () => {
    vi.useFakeTimers();
    schedule({
      name: "test-early",
      nextFire: everyMs(1000),
      run: async () => {},
    });
    startLocalCron();

    let lateRuns = 0;
    schedule({
      name: "test-late",
      nextFire: everyMs(500),
      run: async () => {
        lateRuns++;
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(lateRuns).toBe(1);
  });

  it("ignores duplicate schedule() calls", () => {
    schedule({ name: "dup", nextFire: everyMs(1000), run: async () => {} });
    schedule({ name: "dup", nextFire: everyMs(1000), run: async () => {} });
    expect(inspectJobs().filter((j) => j.name === "dup")).toHaveLength(1);
  });
});

describe("inspectJobs", () => {
  it("exposes name, schedule label, and run counters that update after each run", async () => {
    vi.useFakeTimers();

    schedule({
      name: "inspect-tick",
      description: "tick handler",
      service: "test",
      scheduleLabel: "every 1s",
      nextFire: everyMs(1000),
      run: async () => {},
    });
    startLocalCron();

    let snapshot = inspectJobs();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      name: "inspect-tick",
      description: "tick handler",
      service: "test",
      schedule_label: "every 1s",
      status: "scheduled",
      run_count: 0,
      error_count: 0,
      last_run_at: null,
    });
    expect(snapshot[0].next_fire_at).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    snapshot = inspectJobs();
    expect(snapshot[0].run_count).toBe(1);
    expect(snapshot[0].status).toBe("ok");
    expect(snapshot[0].last_run_at).not.toBeNull();
  });

  it("captures the error message when a job throws", async () => {
    vi.useFakeTimers();

    schedule({
      name: "inspect-throw",
      nextFire: everyMs(100),
      run: async () => {
        throw new Error("kaboom");
      },
    });
    startLocalCron();

    await vi.advanceTimersByTimeAsync(100);
    const snapshot = inspectJobs();
    expect(snapshot[0].status).toBe("error");
    expect(snapshot[0].error_count).toBe(1);
    expect(snapshot[0].last_error).toBe("kaboom");
  });

  it("marks a job deactivated when nextFire returns null on first arm", () => {
    schedule({
      name: "inspect-dead",
      nextFire: () => null,
      run: async () => {},
    });
    startLocalCron();
    const [snap] = inspectJobs();
    expect(snap.status).toBe("deactivated");
    expect(snap.next_fire_at).toBeNull();
  });
});

describe("runJobNow", () => {
  it("triggers the job's handler regardless of the schedule and updates counters", async () => {
    let runs = 0;
    schedule({
      name: "manual",
      nextFire: everyMs(60_000),
      run: async () => {
        runs++;
      },
    });
    startLocalCron();

    const result = await runJobNow("manual");
    expect(runs).toBe(1);
    expect(result?.run_count).toBe(1);
    expect(result?.status).toBe("ok");
  });

  it("returns null for an unknown job", async () => {
    expect(await runJobNow("does-not-exist")).toBeNull();
  });
});

describe("setJobEnabled", () => {
  it("flips the enabled flag, marks status paused, and emits onStatusChange", async () => {
    const events: JobInspectEntry[] = [];
    setLocalCronHooks({
      onStatusChange: async (entry) => {
        events.push(entry);
      },
    });
    schedule({
      name: "toggle",
      nextFire: everyMs(60_000),
      run: async () => {},
    });
    await startLocalCron();

    const paused = await setJobEnabled("toggle", false);
    expect(paused?.enabled).toBe(false);
    expect(paused?.status).toBe("paused");

    const resumed = await setJobEnabled("toggle", true);
    expect(resumed?.enabled).toBe(true);
    expect(resumed?.status).toBe("scheduled");

    expect(events.map((e) => e.status)).toContain("paused");
    expect(events.map((e) => e.status)).toContain("scheduled");
  });

  it("paused jobs skip the handler when their timer fires", async () => {
    vi.useFakeTimers();
    let runs = 0;
    schedule({
      name: "pause-skip",
      nextFire: everyMs(100),
      run: async () => {
        runs++;
      },
    });
    await startLocalCron();
    await setJobEnabled("pause-skip", false);

    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(0);
  });

  it("returns null for an unknown job", async () => {
    expect(await setJobEnabled("nope", true)).toBeNull();
  });
});

describe("hooks", () => {
  it("hydrates entries from the load hook on first start", async () => {
    const persisted: JobPersistedState[] = [
      {
        name: "h-job",
        enabled: false,
        last_run_at: new Date("2026-04-25T12:00:00Z"),
        last_status: "ok",
        last_duration_ms: 42,
        last_error: null,
        run_count: 7,
        error_count: 1,
      },
    ];
    setLocalCronHooks({
      load: async () => persisted,
    });

    schedule({
      name: "h-job",
      nextFire: everyMs(60_000),
      run: async () => {},
    });
    await startLocalCron();

    const [snap] = inspectJobs();
    expect(snap.enabled).toBe(false);
    expect(snap.status).toBe("paused");
    expect(snap.run_count).toBe(7);
    expect(snap.error_count).toBe(1);
    expect(snap.last_duration_ms).toBe(42);
  });

  it("calls the save hook after every run with the current counters", async () => {
    vi.useFakeTimers();
    const saved: JobPersistedState[] = [];
    setLocalCronHooks({
      save: async (state) => {
        saved.push(state);
      },
    });
    schedule({
      name: "h-save",
      nextFire: everyMs(100),
      run: async () => {},
    });
    await startLocalCron();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(saved.length).toBeGreaterThanOrEqual(2);
    const last = saved[saved.length - 1];
    expect(last.name).toBe("h-save");
    expect(last.last_status).toBe("ok");
    expect(last.run_count).toBeGreaterThan(0);
  });
});
