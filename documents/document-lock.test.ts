import { describe, it, expect } from "vitest";
import { withDocumentLock, _documentLocksIdle } from "./document-lock";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("withDocumentLock", () => {
  it("serializes calls for the same document id", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const task = (n: number) =>
      withDocumentLock(42, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // Yield so an unserialized implementation would interleave here.
        await tick(5);
        order.push(n);
        active -= 1;
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(maxActive).toBe(1); // never two critical sections at once
    expect(order).toEqual([1, 2, 3]); // FIFO order preserved
  });

  it("allows different document ids to run concurrently", async () => {
    let active = 0;
    let maxActive = 0;

    const task = (id: number) =>
      withDocumentLock(id, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick(5);
        active -= 1;
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(maxActive).toBeGreaterThan(1); // distinct ids overlap
  });

  it("returns the callback's resolved value", async () => {
    const v = await withDocumentLock(7, async () => "result");
    expect(v).toBe("result");
  });

  it("propagates the callback's rejection to that caller only", async () => {
    const results: string[] = [];

    const failing = withDocumentLock(9, async () => {
      await tick(2);
      throw new Error("boom");
    }).catch((e) => {
      results.push(`err:${(e as Error).message}`);
    });

    // Queued behind the failing one — must still run despite the failure.
    const following = withDocumentLock(9, async () => {
      results.push("ran");
    });

    await Promise.all([failing, following]);
    expect(results).toEqual(["err:boom", "ran"]);
  });

  it("drains its bookkeeping once all work for an id settles", async () => {
    await withDocumentLock(123, async () => {
      await tick(1);
    });
    // Give the finally-cleanup microtask a chance to run.
    await tick(1);
    expect(_documentLocksIdle()).toBe(true);
  });
});
