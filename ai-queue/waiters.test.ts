import { describe, it, expect, beforeEach } from "vitest";
import {
  registerWaiter,
  unregisterWaiter,
  wakeWaiter,
  waiterCount,
} from "./waiters";

describe("waiter registry", () => {
  beforeEach(() => {
    // Drain any leftover waiters from a previous test.
    // (Each test cleans up after itself; this is belt-and-suspenders.)
    for (let i = 0; i < 1000; i++) unregisterWaiter(i);
  });

  it("resolves the registered waiter when woken", async () => {
    const p = registerWaiter(1);
    expect(waiterCount()).toBe(1);
    wakeWaiter(1);
    await expect(p).resolves.toBeUndefined();
    expect(waiterCount()).toBe(0);
  });

  it("wakeWaiter is a no-op for an unregistered slot", () => {
    expect(() => wakeWaiter(999)).not.toThrow();
    expect(waiterCount()).toBe(0);
  });

  it("unregisterWaiter is idempotent and prevents a later wakeup", async () => {
    let resolved = false;
    const p = registerWaiter(2).then(() => {
      resolved = true;
    });
    unregisterWaiter(2);
    unregisterWaiter(2); // idempotent
    expect(waiterCount()).toBe(0);
    wakeWaiter(2); // no-op now
    // Give the microtask queue a chance; the promise must still be pending.
    await Promise.resolve();
    expect(resolved).toBe(false);
    // Clean up the dangling promise reference to avoid an unhandled rejection.
    void p;
  });

  it("wakes only the targeted slot", async () => {
    let aWoke = false;
    let bWoke = false;
    const a = registerWaiter(10).then(() => {
      aWoke = true;
    });
    const b = registerWaiter(11).then(() => {
      bWoke = true;
    });
    expect(waiterCount()).toBe(2);
    wakeWaiter(10);
    await a;
    expect(aWoke).toBe(true);
    expect(bWoke).toBe(false);
    expect(waiterCount()).toBe(1);
    wakeWaiter(11);
    await b;
    expect(bWoke).toBe(true);
    expect(waiterCount()).toBe(0);
  });

  it("a double wakeup does not throw and leaves no waiter", async () => {
    const p = registerWaiter(20);
    wakeWaiter(20);
    wakeWaiter(20); // already removed — no-op
    await p;
    expect(waiterCount()).toBe(0);
  });
});
