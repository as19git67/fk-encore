/**
 * Loading and removing the demo household against the real database:
 * every written row is registered, the counts of the untouched check do
 * not see it, and removing it takes exactly that back. The endpoints are
 * for administrators only.
 *
 * The test database is shared by all test files, so it is not untouched
 * here; the run is filed directly and every count is compared as a delta.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  demoItem,
  demoRun,
  demoTruth,
  documents,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeDepotSecurity,
  financeTransaction,
  roles,
  userRoles,
  users,
  userSubjectPersons,
} from "../db/schema";
import { cancelDemo, getDemoStatus, removeDemo, startDemo } from "./demo";
import { DEMO_SPOUSE } from "./names";
import { registered } from "./registry";
import { removeRun } from "./remove";
import { executeRun, fileRun, DemoRefused, markInterruptedRuns } from "./run";
import { truthReport } from "./truth";
import { setQuoteProvider, type QuoteProvider } from "../finance/quote-provider";
import { DEMO_DEPOT_NUMBER } from "./securities";
import fs from "node:fs";
import { contentCounts, currentRun } from "./state";

vi.mock("~encore/auth", () => ({ getAuthData: vi.fn() }));

let adminId: number;
let memberId: number;

async function roleId(name: string): Promise<number> {
  const [has] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name));
  if (has) return has.id;
  const [row] = await db.insert(roles).values({ name, description: name }).returning({ id: roles.id });
  return row.id;
}

function authAs(userId: number) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions: ["data.manage"] } as never);
}

async function fileDirect(size: "full" | "small" = "small"): Promise<number> {
  const [row] = await db
    .insert(demoRun)
    .values({ owner_user_id: adminId, seed: 4711, size, text_source: "llm", status: "running", stage: "household" })
    .returning({ id: demoRun.id });
  return row.id;
}

beforeAll(async () => {
  const [admin] = await db
    .insert(users)
    .values({ email: "demo-admin@beispiel.test", name: "Demo Admin", password_hash: "x" })
    .returning({ id: users.id });
  adminId = admin.id;
  await db.insert(userRoles).values({ user_id: adminId, role_id: await roleId("Admin") });
  const [member] = await db
    .insert(users)
    .values({ email: "demo-member@beispiel.test", name: "Demo Member", password_hash: "x" })
    .returning({ id: users.id });
  memberId = member.id;
});

afterEach(async () => {
  // Every test leaves no demo behind, so the next one can file its own.
  const run = await currentRun();
  if (run) await removeRun(run.id);
});

describe("a demo run", () => {
  it("lays the household down, registers it, and the untouched check does not count it", async () => {
    const before = await contentCounts();
    const runId = await fileDirect();
    await executeRun(runId, { today: "2026-10-26" });

    const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
    expect(run.status).toBe("done");
    expect(run.summary).toMatchObject({ users: 1, accounts: 4, bookings: 40, documents: 30, worded: 0 });
    expect(run.progress.bookings).toEqual({ done: 40, total: 40 });
    expect(run.progress.documents).toEqual({ done: 30, total: 30 });
    // The llm-service is not there in tests: the run falls back to the templates and says so.
    expect(run.text_source).toBe("template");

    const docIds = await registered(runId, "documents");
    expect(docIds).toHaveLength(30);
    const docs = await db.select().from(documents).where(inArray(documents.id, docIds));
    // Nothing prefilled: the pipeline has to find category, sender and date itself.
    expect(docs.every((d) => d.category_id === null && d.sender === null && d.doc_date === null && d.user_id === adminId)).toBe(true);
    expect(docs.every((d) => fs.existsSync(d.disk_path))).toBe(true);
    const truths = await db.select().from(demoTruth).where(eq(demoTruth.run_id, runId));
    expect(truths.map((t) => t.document_id).sort()).toEqual([...docIds].sort());
    // Documents that go with a booking point at a booking the run wrote.
    const linked = truths.map((t) => (t.truth as { booking_id: number | null }).booking_id).filter((id): id is number => id !== null);
    expect(linked.length).toBeGreaterThan(0);
    const bookingIds = new Set((await db.select({ id: financeTransaction.id }).from(financeTransaction).where(inArray(financeTransaction.account_id, await registered(runId, "finance_account")))).map((b) => b.id));
    expect(linked.every((id) => bookingIds.has(id))).toBe(true);

    // Nothing is classified yet: everything pending, nothing counted as a miss.
    const report = await truthReport(runId);
    expect(report.documents).toBe(30);
    expect(report.pending).toBe(30);
    expect(report.fields.every((f) => f.compared === 0)).toBe(true);

    const accounts = await registered(runId, "finance_account");
    // Four household accounts; the depot is left out without a quote provider.
    expect(accounts).toHaveLength(4);
    const bookings = await db.select({ id: financeTransaction.id }).from(financeTransaction).where(inArray(financeTransaction.account_id, accounts));
    expect(bookings).toHaveLength(40);

    const [spouse] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_SPOUSE.email));
    expect(await registered(runId, "users")).toEqual([spouse.id]);
    // The joint account is the one both hold.
    const access = await db.select().from(financeAccountAccess).where(inArray(financeAccountAccess.account_id, accounts));
    const holders = new Map<number, number[]>();
    for (const a of access) holders.set(a.account_id, [...(holders.get(a.account_id) ?? []), a.user_id]);
    expect([...holders.values()].filter((h) => h.length === 2)).toHaveLength(1);

    const persons = await db.select().from(userSubjectPersons).where(eq(userSubjectPersons.user_id, spouse.id));
    expect(persons.map((p) => p.relation_kind).sort()).toEqual(["child", "self", "spouse"]);

    expect(await contentCounts()).toEqual(before);
  });

  it("builds the depot at the provider's closes when it has them, and takes it back", async () => {
    // A provider from memory: weekday closes for every fund, no network.
    const provider: QuoteProvider = {
      name: "demo-test",
      resolve: async ({ isin }) => ({ symbol: `T-${isin}`, name: null, exchange: null, currency: "EUR", securityType: "etf" }),
      history: async (symbol, range) => {
        const points: Array<{ at: string; price: number }> = [];
        if (range === "backfill") {
          for (let t = Date.parse("2026-06-01T16:00:00Z"); t <= Date.parse("2026-10-26T16:00:00Z"); t += 86_400_000) {
            const d = new Date(t).getUTCDay();
            if (d !== 0 && d !== 6) points.push({ at: new Date(t).toISOString(), price: 50 + (symbol.length % 7) });
          }
        }
        return { symbol, currency: "EUR", points };
      },
    };
    setQuoteProvider(provider);
    try {
      const runId = await fileDirect();
      await executeRun(runId, { today: "2026-10-26" });
      const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
      expect(run.status).toBe("done");
      expect(run.error).toBeNull();
      expect(run.summary).toMatchObject({ depot: 1 });

      const accounts = await registered(runId, "finance_account");
      const [depot] = await db
        .select({ id: financeAccount.id, number: financeAccount.account_number })
        .from(financeAccount)
        .innerJoin(financeAccountType, eq(financeAccountType.id, financeAccount.type_id))
        .where(and(inArray(financeAccount.id, accounts), eq(financeAccountType.kind, "depot")));
      expect(depot.number).toBe(DEMO_DEPOT_NUMBER);
      const securities = await db.select().from(financeDepotSecurity).where(eq(financeDepotSecurity.account_id, depot.id));
      expect(securities.length).toBeGreaterThan(0);
      expect(securities.every((s) => s.status === "confirmed")).toBe(true);
      const kinds = (await db.select({ kind: demoTruth.kind }).from(demoTruth).where(eq(demoTruth.run_id, runId))).map((t) => t.kind);
      expect(kinds).toContain("securities_buy");

      await removeRun(runId);
      expect(await db.select().from(financeAccount).where(eq(financeAccount.id, depot.id))).toHaveLength(0);
      expect(await db.select().from(financeDepotSecurity).where(eq(financeDepotSecurity.account_id, depot.id))).toHaveLength(0);
    } finally {
      setQuoteProvider(null);
    }
  });

  it("leaves the depot out and says why when no provider answers", async () => {
    const runId = await fileDirect();
    await executeRun(runId, { today: "2026-10-26" });
    const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
    expect(run.status).toBe("done");
    expect(run.summary).toMatchObject({ depot: 0 });
    expect(run.error).toMatch(/^Depot ausgelassen/);
  });

  it("takes back exactly what it wrote", async () => {
    const runId = await fileDirect();
    await executeRun(runId, { today: "2026-10-26" });
    const accounts = await registered(runId, "finance_account");
    const docIds = await registered(runId, "documents");
    const files = (await db.select({ path: documents.disk_path }).from(documents).where(inArray(documents.id, docIds))).map((d) => d.path);
    expect(files.length).toBe(30);

    await removeRun(runId);

    expect(await db.select().from(documents).where(inArray(documents.id, docIds))).toHaveLength(0);
    expect(files.some((f) => fs.existsSync(f))).toBe(false);

    const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
    expect(run.status).toBe("removed");
    expect(await db.select().from(financeAccount).where(inArray(financeAccount.id, accounts))).toHaveLength(0);
    expect(await db.select().from(financeTransaction).where(inArray(financeTransaction.account_id, accounts))).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.email, DEMO_SPOUSE.email))).toHaveLength(0);
    expect(await db.select().from(demoItem).where(eq(demoItem.run_id, runId))).toHaveLength(0);
    // The admin's own household persons from the demo go too; the admin stays.
    expect(await db.select().from(userSubjectPersons).where(eq(userSubjectPersons.user_id, adminId))).toHaveLength(0);
    expect(await db.select().from(users).where(eq(users.id, adminId))).toHaveLength(1);
    expect(await currentRun()).toBeNull();
  });

  it("stops at the next batch when cancelled, and what it wrote can be removed", async () => {
    const runId = await fileDirect("full");
    await db.update(demoRun).set({ status: "cancelling" }).where(eq(demoRun.id, runId));
    await executeRun(runId, { today: "2026-10-26" });
    const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
    expect(run.status).toBe("cancelled");
    const accounts = await registered(runId, "finance_account");
    expect(accounts).toHaveLength(4);
    expect(await db.select().from(financeTransaction).where(inArray(financeTransaction.account_id, accounts))).toHaveLength(0);
  });

  it("is refused while a demo exists or the system holds data", async () => {
    await fileDirect();
    await expect(fileRun(adminId)).rejects.toBeInstanceOf(DemoRefused);
    await removeRun((await currentRun())!.id);
    // The shared test database holds the member user at least.
    expect((await contentCounts()).users).toBeGreaterThan(0);
    await expect(fileRun(adminId)).rejects.toThrow(/holds data already/);
  });

  it("marks a run that a restart interrupted as failed", async () => {
    const runId = await fileDirect();
    await markInterruptedRuns();
    const [run] = await db.select().from(demoRun).where(eq(demoRun.id, runId));
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/restart/);
  });
});

describe("the demo endpoints", () => {
  it("are closed to a user without the Admin role", async () => {
    authAs(memberId);
    await expect(getDemoStatus()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(startDemo({})).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("report the state and refuse a start into a system with data", async () => {
    authAs(adminId);
    const status = await getDemoStatus();
    expect(status.untouched).toBe(false);
    expect(status.run).toBeNull();
    await expect(startDemo({})).rejects.toMatchObject({ code: "failed_precondition" });
    await expect(cancelDemo()).rejects.toMatchObject({ code: "failed_precondition" });
    await expect(removeDemo()).rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("remove a finished demo", async () => {
    authAs(adminId);
    const runId = await fileDirect();
    await executeRun(runId, { today: "2026-10-26" });
    expect((await getDemoStatus()).run?.status).toBe("done");
    const after = await removeDemo();
    expect(after.run).toBeNull();
    expect(await db.select().from(demoRun).where(and(eq(demoRun.id, runId), eq(demoRun.status, "removed")))).toHaveLength(1);
  });
});
