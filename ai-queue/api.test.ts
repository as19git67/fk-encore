import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  acquireSlot,
  releaseSlot,
  pollSlot,
  cancelSlot,
  getQueueStatus,
  cleanupStaleSlots,
} from "./api";

beforeEach(async () => {
  await db.execute(sql`DELETE FROM ai_model_slot`);
});

describe("acquireSlot", () => {
  it("grants active status when no other slot is active", async () => {
    const result = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "documents:classify",
    });
    expect(result.status).toBe("active");
    expect(result.position).toBe(0);
    expect(result.slotId).toBeGreaterThan(0);
  });

  it("returns waiting status when another slot is already active", async () => {
    const first = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "documents:classify",
    });
    expect(first.status).toBe("active");

    const second = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "finance:tag-suggest",
    });
    expect(second.status).toBe("waiting");
    expect(second.position).toBe(1);
  });

  it("allows concurrent active slots for different models", async () => {
    const llm = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "documents:classify",
    });
    const embedding = await acquireSlot({
      model: "embedding",
      priority: 2,
      requester: "photo:embedding",
    });
    expect(llm.status).toBe("active");
    expect(embedding.status).toBe("active");
  });
});

describe("releaseSlot", () => {
  it("activates the next waiting slot when released", async () => {
    const first = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "documents:classify",
    });
    const second = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "finance:tag-suggest",
    });
    expect(second.status).toBe("waiting");

    await releaseSlot({ slotId: first.slotId });

    const poll = await pollSlot({ slotId: second.slotId });
    expect(poll.status).toBe("active");
  });

  it("activates higher priority slot first", async () => {
    const first = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "documents:classify",
    });

    const lowPrio = await acquireSlot({
      model: "llm",
      priority: 3,
      requester: "finance:backfill",
    });

    const highPrio = await acquireSlot({
      model: "llm",
      priority: 1,
      requester: "finance:analysis",
    });

    expect(lowPrio.status).toBe("waiting");
    expect(highPrio.status).toBe("waiting");

    await releaseSlot({ slotId: first.slotId });

    const highPoll = await pollSlot({ slotId: highPrio.slotId });
    expect(highPoll.status).toBe("active");

    const lowPoll = await pollSlot({ slotId: lowPrio.slotId });
    expect(lowPoll.status).toBe("waiting");
  });
});

describe("pollSlot", () => {
  it("returns cancelled for non-existent slot", async () => {
    const result = await pollSlot({ slotId: 999999 });
    expect(result.status).toBe("cancelled");
  });

  it("returns correct position in queue", async () => {
    const active = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "a",
    });
    const w1 = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "b",
    });
    const w2 = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "c",
    });

    const poll1 = await pollSlot({ slotId: w1.slotId });
    expect(poll1.position).toBe(1);

    const poll2 = await pollSlot({ slotId: w2.slotId });
    expect(poll2.position).toBe(2);
  });
});

describe("cancelSlot", () => {
  it("removes a waiting slot", async () => {
    const active = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "a",
    });
    const waiting = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "b",
    });

    await cancelSlot({ slotId: waiting.slotId });

    const poll = await pollSlot({ slotId: waiting.slotId });
    expect(poll.status).toBe("cancelled");
  });

  it("does not cancel an active slot", async () => {
    const active = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "a",
    });

    await cancelSlot({ slotId: active.slotId });

    const poll = await pollSlot({ slotId: active.slotId });
    expect(poll.status).toBe("active");
  });
});

describe("getQueueStatus", () => {
  it("returns empty status for all models when no slots exist", async () => {
    const result = await getQueueStatus();
    expect(result.models).toHaveLength(4);
    for (const m of result.models) {
      expect(m.activeSlot).toBeNull();
      expect(m.waitingCount).toBe(0);
    }
  });

  it("reflects active and waiting slots", async () => {
    await acquireSlot({ model: "llm", priority: 1, requester: "a" });
    await acquireSlot({ model: "llm", priority: 2, requester: "b" });
    await acquireSlot({ model: "llm", priority: 3, requester: "c" });
    await acquireSlot({ model: "embedding", priority: 2, requester: "d" });

    const result = await getQueueStatus();

    const llm = result.models.find((m) => m.model === "llm")!;
    expect(llm.activeSlot).not.toBeNull();
    expect(llm.activeSlot!.requester).toBe("a");
    expect(llm.waitingCount).toBe(2);
    expect(llm.waitingByPriority.p2).toBe(1);
    expect(llm.waitingByPriority.p3).toBe(1);

    const emb = result.models.find((m) => m.model === "embedding")!;
    expect(emb.activeSlot).not.toBeNull();
    expect(emb.waitingCount).toBe(0);
  });
});

describe("cleanupStaleSlots", () => {
  it("cleans up slots that exceeded TTL", async () => {
    const slot = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "stale-worker",
    });
    expect(slot.status).toBe("active");

    await db.execute(sql`
      UPDATE ai_model_slot
      SET activated_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${slot.slotId}
    `);

    const result = await cleanupStaleSlots();
    expect(result.cleaned).toBe(1);

    const poll = await pollSlot({ slotId: slot.slotId });
    expect(poll.status).toBe("cancelled");
  });

  it("activates next waiting slot after cleanup", async () => {
    const stale = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "stale-worker",
    });
    const waiting = await acquireSlot({
      model: "llm",
      priority: 2,
      requester: "next-worker",
    });
    expect(waiting.status).toBe("waiting");

    await db.execute(sql`
      UPDATE ai_model_slot
      SET activated_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${stale.slotId}
    `);

    await cleanupStaleSlots();

    const poll = await pollSlot({ slotId: waiting.slotId });
    expect(poll.status).toBe("active");
  });
});

describe("priority ordering", () => {
  it("queues by priority then FIFO within same priority", async () => {
    const active = await acquireSlot({
      model: "embedding",
      priority: 2,
      requester: "active",
    });

    const p3 = await acquireSlot({
      model: "embedding",
      priority: 3,
      requester: "low",
    });
    const p2a = await acquireSlot({
      model: "embedding",
      priority: 2,
      requester: "normal-first",
    });
    const p2b = await acquireSlot({
      model: "embedding",
      priority: 2,
      requester: "normal-second",
    });
    const p1 = await acquireSlot({
      model: "embedding",
      priority: 1,
      requester: "high",
    });

    // Release active → P1 should activate (highest priority)
    await releaseSlot({ slotId: active.slotId });
    expect((await pollSlot({ slotId: p1.slotId })).status).toBe("active");

    // Release P1 → P2a should activate (same priority, earlier enqueue)
    await releaseSlot({ slotId: p1.slotId });
    expect((await pollSlot({ slotId: p2a.slotId })).status).toBe("active");

    // Release P2a → P2b should activate
    await releaseSlot({ slotId: p2a.slotId });
    expect((await pollSlot({ slotId: p2b.slotId })).status).toBe("active");

    // Release P2b → P3 should activate (last one)
    await releaseSlot({ slotId: p2b.slotId });
    expect((await pollSlot({ slotId: p3.slotId })).status).toBe("active");
  });
});
