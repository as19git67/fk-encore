import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { acquireSlot, releaseSlot, pollSlot } from "./api";
import { waiterCount } from "./waiters";

// Wire the `~encore/clients` aiqueue stub (from vitest.setup.ts) to the REAL
// api handlers so withAiSlot exercises the actual DB + waiter registry. The
// api() wrapper is already mocked to return the bare handler, so these are
// plain async functions operating on the real test database.
vi.mock("~encore/clients", async () => {
  const real = await vi.importActual<typeof import("./api")>("./api");
  return {
    aiqueue: {
      acquireSlot: (req: unknown) => real.acquireSlot(req as any),
      pollSlot: (req: unknown) => real.pollSlot(req as any),
      releaseSlot: (req: unknown) => real.releaseSlot(req as any),
      cancelSlot: (req: unknown) => real.cancelSlot(req as any),
    },
  };
});

// Imported after the mock so it binds to the wired client.
import { withAiSlot, AiSlotTimeoutError } from "./slot-helper";

beforeEach(async () => {
  await db.execute(sql`DELETE FROM ai_model_slot`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withAiSlot push wakeup", () => {
  it("runs immediately when a slot is free", async () => {
    let ran = false;
    const result = await withAiSlot("llm", 2, "test:free", async () => {
      ran = true;
      return "ok";
    });
    expect(ran).toBe(true);
    expect(result).toBe("ok");
    // Slot released in finally.
    const rows = await db.execute<{ c: number }>(
      sql`SELECT COUNT(*)::int AS c FROM ai_model_slot`,
    );
    expect(rows.rows[0].c).toBe(0);
    expect(waiterCount()).toBe(0);
  });

  it("wakes a waiting caller the moment the holder releases (no fallback poll)", async () => {
    // Fallback poll is 30s by default; if the waiter only ran via fallback the
    // test would time out. Completing quickly proves the push wakeup fired.
    // Hold the active slot open until we've observed the waiter registered.
    const holderGate = deferred();
    const holderStarted = deferred();
    const holder = withAiSlot("llm", 2, "test:holder", async () => {
      holderStarted.resolve();
      await holderGate.promise;
    });
    await holderStarted.promise;

    // Start the waiter; it will acquire (waiting) and register.
    let waiterRan = false;
    const waiter = withAiSlot("llm", 2, "test:waiter", async () => {
      waiterRan = true;
      return "done";
    });

    // Wait until the waiter has registered in the in-process registry.
    await vi.waitFor(() => expect(waiterCount()).toBe(1), { timeout: 2000 });
    expect(waiterRan).toBe(false);

    // Release the holder → promotes + wakes the waiter.
    holderGate.resolve();
    await holder;

    const started = Date.now();
    await expect(waiter).resolves.toBe("done");
    expect(waiterRan).toBe(true);
    // Comfortably under the 30s fallback interval.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(waiterCount()).toBe(0);
  });

  it("wakes the higher-priority waiter first", async () => {
    const holderGate = deferred();
    const holderStarted = deferred();
    const holder = withAiSlot("llm", 2, "test:holder", async () => {
      holderStarted.resolve();
      await holderGate.promise;
    });
    await holderStarted.promise;

    const order: string[] = [];
    const low = withAiSlot("llm", 3, "test:low", async () => {
      order.push("low");
    });
    const high = withAiSlot("llm", 1, "test:high", async () => {
      order.push("high");
    });

    await vi.waitFor(() => expect(waiterCount()).toBe(2), { timeout: 2000 });

    holderGate.resolve();
    await holder;
    await high;
    await low;

    expect(order).toEqual(["high", "low"]);
    expect(waiterCount()).toBe(0);
  });

  it("times out and cleans up when the slot never frees", async () => {
    const holderGate = deferred();
    const holderStarted = deferred();
    const holder = withAiSlot("llm", 2, "test:holder", async () => {
      holderStarted.resolve();
      await holderGate.promise;
    });
    await holderStarted.promise;

    let waiterRan = false;
    const waiter = withAiSlot(
      "llm",
      2,
      "test:waiter",
      async () => {
        waiterRan = true;
      },
      150, // short timeout
    );

    await expect(waiter).rejects.toBeInstanceOf(AiSlotTimeoutError);
    expect(waiterRan).toBe(false);
    // The waiting row was cancelled; only the holder remains.
    const rows = await db.execute<{ c: number }>(
      sql`SELECT COUNT(*)::int AS c FROM ai_model_slot WHERE model_name = 'llm'`,
    );
    expect(rows.rows[0].c).toBe(1);
    expect(waiterCount()).toBe(0);

    holderGate.resolve();
    await holder;
  });

  it("makes progress via the fallback poll when the wakeup is lost", async () => {
    // Shrink the fallback interval, then promote the waiter directly in the DB
    // WITHOUT going through releaseSlot's wakeWaiter. The registry is never
    // notified, so the only path to progress is the waiter's own fallback poll.
    vi.stubEnv("AI_QUEUE_FALLBACK_POLL_MS", "50");

    const first = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "test:holder",
    });
    expect(first.status).toBe("active");

    let waiterRan = false;
    const waiter = withAiSlot("llm", 2, "test:waiter", async () => {
      waiterRan = true;
      return "via-fallback";
    });

    await vi.waitFor(() => expect(waiterCount()).toBe(1), { timeout: 2000 });

    // Promote the waiter directly in the DB, bypassing releaseSlot's wakeWaiter
    // so the ONLY way the waiter can notice is its fallback poll.
    await db.execute(sql`
      UPDATE ai_model_slot SET status = 'waiting' WHERE id = ${first.slotId}
    `);
    await db.execute(sql`DELETE FROM ai_model_slot WHERE id = ${first.slotId}`);
    await db.execute(sql`
      UPDATE ai_model_slot SET status = 'active', activated_at = NOW()
      WHERE model_name = 'llm' AND status = 'waiting'
    `);

    await expect(waiter).resolves.toBe("via-fallback");
    expect(waiterRan).toBe(true);
    expect(waiterCount()).toBe(0);
  });
});
