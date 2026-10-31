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
  financeAccount,
  financeAccountAccess,
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
    .values({ owner_user_id: adminId, seed: 4711, size, text_source: "template", status: "running", stage: "household" })
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
    expect(run.summary).toEqual({ users: 1, accounts: 4, bookings: 40 });
    expect(run.progress.bookings).toEqual({ done: 40, total: 40 });

    const accounts = await registered(runId, "finance_account");
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

  it("takes back exactly what it wrote", async () => {
    const runId = await fileDirect();
    await executeRun(runId, { today: "2026-10-26" });
    const accounts = await registered(runId, "finance_account");

    await removeRun(runId);

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
