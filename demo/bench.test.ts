/**
 * The demo household for the assistant benchmark: laid for any owner into
 * a system that holds data, the same every time for the same seed and
 * "today", never the demo of the system, and taken back without touching
 * a second household next to it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { demoRun, documents, financeAccount, financeTag, financeTransaction, meters, photos, users } from "../db/schema";
import { layBenchHousehold, removeBenchHousehold, spouseEmailFor } from "./bench";
import { planEnergy, PV_BOOKING_TAG } from "./energy";
import { planHousehold } from "./household";
import { registered } from "./registry";
import { DEFAULT_SEED } from "./run";
import { contentCounts, currentRun } from "./state";

vi.mock("../photo/scan-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../photo/scan-worker")>()),
  triggerWorkers: () => {},
}));
vi.setConfig({ testTimeout: 120_000 });

const TODAY = "2026-10-26";
let ownerId: number;
let otherId: number;

beforeAll(async () => {
  const rows = await db
    .insert(users)
    .values([
      { email: "demo-bench-owner@system.local", name: "Demo Bench", password_hash: "x" },
      { email: "demo-bench-other@system.local", name: "Demo Bench 2", password_hash: "x" },
    ])
    .returning({ id: users.id });
  [ownerId, otherId] = rows.map((r) => r.id);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [ownerId, otherId]));
});

async function bookingsOf(runId: number): Promise<number> {
  const accounts = await registered(runId, "finance_account");
  if (!accounts.length) return 0;
  return (await db.select({ id: financeTransaction.id }).from(financeTransaction).where(inArray(financeTransaction.account_id, accounts))).length;
}

describe("layBenchHousehold", () => {
  it("lays the planned household for the owner, beside any demo, and takes it back", async () => {
    const before = await contentCounts();
    const demoBefore = await currentRun();

    const a = await layBenchHousehold(ownerId, { today: TODAY });
    const plan = planHousehold(DEFAULT_SEED, "small", TODAY);
    const energy = planEnergy(DEFAULT_SEED, "small", plan);
    expect(a.summary).toMatchObject({ bookings: plan.bookings.length + energy.bookings.length, documents: 30, photos: 0, depot: 0, meters: 5, businesses: 1 });
    expect(a.notes).toContain("Depot ausgelassen");
    expect(await bookingsOf(a.runId)).toBe(a.summary.bookings);

    // The owner holds the documents; accounts and meters are registered with the run.
    const accounts = await registered(a.runId, "finance_account");
    expect(accounts.length).toBeGreaterThan(0);
    const meterIds = await registered(a.runId, "meters");
    expect(meterIds).toHaveLength(5);
    const docRows = await db.select({ user: documents.user_id }).from(documents).where(inArray(documents.id, await registered(a.runId, "documents")));
    expect(docRows).toHaveLength(30);
    expect(docRows.every((d) => d.user === ownerId)).toBe(true);
    expect(await db.select({ id: photos.id }).from(photos).where(eq(photos.user_id, ownerId))).toHaveLength(0);

    // Never the demo, never counted as content.
    expect((await currentRun())?.id ?? null).toBe(demoBefore?.id ?? null);
    expect(await contentCounts()).toEqual(before);
    const [spouse] = await db.select({ id: users.id }).from(users).where(eq(users.email, spouseEmailFor(a.runId)));
    expect(spouse).toBeDefined();

    // A second household of another owner beside the first (the demo of
    // the system stands beside them the same way): same plan, its own rows.
    const b = await layBenchHousehold(otherId, { today: TODAY });
    expect(b.summary.bookings).toBe(a.summary.bookings);
    const [pvTag] = await db.select({ id: financeTag.id }).from(financeTag).where(eq(financeTag.name, PV_BOOKING_TAG));
    expect(pvTag).toBeDefined();

    // Taking the first back leaves the second whole, its tag included.
    await removeBenchHousehold(a.runId);
    expect(await db.select().from(demoRun).where(eq(demoRun.id, a.runId))).toHaveLength(0);
    expect(await db.select({ id: financeAccount.id }).from(financeAccount).where(inArray(financeAccount.id, accounts))).toHaveLength(0);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.email, spouseEmailFor(a.runId)))).toHaveLength(0);
    expect(await bookingsOf(b.runId)).toBe(b.summary.bookings);
    expect(await db.select({ id: financeTag.id }).from(financeTag).where(eq(financeTag.id, pvTag.id))).toHaveLength(1);

    await removeBenchHousehold(b.runId);
    expect(await db.select({ id: meters.id }).from(meters).where(inArray(meters.id, meterIds))).toHaveLength(0);
    expect(await db.select({ id: documents.id }).from(documents).where(inArray(documents.user_id, [ownerId, otherId]))).toHaveLength(0);
    expect(await contentCounts()).toEqual(before);
  });

  it("refuses to take back the demo of the system", async () => {
    const [run] = await db
      .insert(demoRun)
      .values({ owner_user_id: ownerId, seed: 1, size: "small", text_source: "template", status: "done" })
      .returning({ id: demoRun.id });
    try {
      await expect(removeBenchHousehold(run.id)).rejects.toThrow("is the demo");
    } finally {
      await db.delete(demoRun).where(eq(demoRun.id, run.id));
    }
  });
});
