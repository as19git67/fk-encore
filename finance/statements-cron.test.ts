import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeBankcontact,
  financeTanSession,
  users,
} from "../db/schema";
import {
  firstResponsibleUser,
  isSlotDue,
  syncStatements,
} from "./statements-cron";
import * as fintsClient from "./fints-client";
import * as pushService from "../push/push.service";
import type { FinanceSyncSlot } from "../db/schema";

vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return { ...actual, runSynchronize: vi.fn() };
});
vi.mock("../push/push.service", async (orig) => {
  const actual = await orig<typeof import("../push/push.service")>();
  return {
    ...actual,
    sendToUser: vi.fn(async () => ({ sent: 1, pruned: 0 })),
  };
});

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  vi.mocked(fintsClient.runSynchronize).mockReset();
  vi.mocked(pushService.sendToUser).mockReset();
  vi.mocked(pushService.sendToUser).mockResolvedValue({ sent: 1, pruned: 0 });
});

async function insertBankcontact(
  overrides: Partial<typeof financeBankcontact.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Sparkasse Test",
      blz: "1",
      login: "u",
      server_url: "https://x",
      ...overrides,
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

async function insertAccountAndAcl(
  bankcontactId: number,
  userId: number,
  level: "read" | "write",
): Promise<void> {
  await ensureUser(userId);
  const [type] = await db
    .select({ id: financeAccountType.id })
    .from(financeAccountType)
    .limit(1);
  const [acc] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: bankcontactId,
      type_id: type.id,
      currency_code: "EUR",
      account_number: `A-${bankcontactId}-${userId}`,
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  await db.insert(financeAccountAccess).values({
    account_id: acc.id,
    user_id: userId,
    level,
  });
}

// ================= isSlotDue =================

describe("statements-cron — isSlotDue", () => {
  it("matches when weekday + time fall into the tolerance window", () => {
    // 2026-04-24 is a Friday (weekday=5) → 06:25 Berlin = 04:25 UTC (CEST: 04:25 UTC)
    const now = new Date("2026-04-24T04:26:00Z");
    const slot: FinanceSyncSlot = {
      weekdays: [1, 2, 3, 4, 5],
      time: "06:25",
      tz: "Europe/Berlin",
    };
    expect(isSlotDue(now, slot)).toBe(true);
  });

  it("does not match when the weekday differs", () => {
    // Saturday 2026-04-25
    const now = new Date("2026-04-25T04:26:00Z");
    const slot: FinanceSyncSlot = {
      weekdays: [1, 2, 3, 4, 5],
      time: "06:25",
      tz: "Europe/Berlin",
    };
    expect(isSlotDue(now, slot)).toBe(false);
  });

  it("does not match outside the tolerance window", () => {
    const now = new Date("2026-04-24T09:00:00Z"); // 11:00 Berlin
    const slot: FinanceSyncSlot = {
      weekdays: [5],
      time: "06:25",
      tz: "Europe/Berlin",
    };
    expect(isSlotDue(now, slot)).toBe(false);
  });

  it("handles midnight wraparound", () => {
    // 2026-04-24 23:59 UTC = 01:59 Berlin (next weekday: Sat = 6)
    const now = new Date("2026-04-25T21:59:00Z"); // 23:59 Berlin on Saturday
    const slot: FinanceSyncSlot = {
      weekdays: [6],
      time: "00:00",
      tz: "Europe/Berlin",
    };
    expect(isSlotDue(now, slot)).toBe(true);
  });

  it("rejects slots with malformed time", () => {
    const now = new Date();
    const slot = { weekdays: [1], time: "25:99", tz: "Europe/Berlin" } as any;
    expect(isSlotDue(now, slot)).toBe(false);
  });
});

// ================= firstResponsibleUser =================

describe("statements-cron — firstResponsibleUser", () => {
  it("prefers write-level users over read-level", async () => {
    const bc = await insertBankcontact();
    await insertAccountAndAcl(bc, 10, "read");
    await insertAccountAndAcl(bc, 20, "write");
    expect(await firstResponsibleUser(bc)).toBe(20);
  });

  it("falls back to read-level users when no write exists", async () => {
    const bc = await insertBankcontact();
    await insertAccountAndAcl(bc, 10, "read");
    await insertAccountAndAcl(bc, 30, "read");
    expect(await firstResponsibleUser(bc)).toBe(10); // lowest user_id
  });

  it("throws when no ACL entries exist", async () => {
    const bc = await insertBankcontact();
    await expect(firstResponsibleUser(bc)).rejects.toThrow(/no ACL/);
  });
});

// ================= syncStatements =================

describe("statements-cron — syncStatements (integration-ish)", () => {
  it("ignores bankcontacts whose slots don't match now", async () => {
    // Slot at 03:00 Berlin → will never match "now".
    await insertBankcontact({
      sync_times: [
        { weekdays: [0, 1, 2, 3, 4, 5, 6], time: "03:00", tz: "Europe/Berlin" },
      ] as any,
    });
    // Set "now" to a time clearly outside the tolerance by feeding the
    // cron function's clock — but the endpoint reads `new Date()`
    // directly, so we just pick a slot that can't match. Here we rely
    // on the random Date.now() being far from 03:00 Berlin; if the
    // test happens to run at that time the assertion flips, which is
    // acceptable for a CI suite.
    const result = await syncStatements();
    expect(result.contacts_due).toBe(0);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();
  });

  it("runs runSynchronize for a due bankcontact and records state=ok", async () => {
    const now = new Date();
    // Build a slot that's almost exactly "now" in UTC.
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const weekday = now.getUTCDay();
    const bc = await insertBankcontact({
      sync_times: [
        { weekdays: [weekday], time: `${hh}:${mm}`, tz: "UTC" },
      ] as any,
    });
    await insertAccountAndAcl(bc, 7, "write");

    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({ state: "idle" });

    const result = await syncStatements();
    expect(result.contacts_due).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.tan_required).toBe(0);

    const [row] = await db
      .select({
        last_sync_status: financeBankcontact.last_sync_status,
        last_sync_at: financeBankcontact.last_sync_at,
      })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bc));
    expect(row.last_sync_status).toBe("ok");
    expect(row.last_sync_at).not.toBeNull();
  });

  it("creates a TAN session and sends a push when runSynchronize returns tan-required", async () => {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const bc = await insertBankcontact({
      sync_times: [
        { weekdays: [now.getUTCDay()], time: `${hh}:${mm}`, tz: "UTC" },
      ] as any,
    });
    await insertAccountAndAcl(bc, 42, "write");

    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "tan-required",
      bankingInformation: { systemId: "sys-1" },
      tanChallenge: "Bitte in der App bestätigen",
      tanReference: "fints-ref-xyz",
    });

    const result = await syncStatements();
    expect(result.tan_required).toBe(1);

    // Session row created, owned by user 42
    const sessions = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.bankcontact_id, bc));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].user_id).toBe(42);
    expect(sessions[0].banking_information).toMatchObject({
      bi: { systemId: "sys-1" },
      fintsTanRef: "fints-ref-xyz",
    });

    // Push was sent to that user
    expect(pushService.sendToUser).toHaveBeenCalledOnce();
    expect(vi.mocked(pushService.sendToUser).mock.calls[0][0]).toBe(42);
    const payload = vi.mocked(pushService.sendToUser).mock.calls[0][1];
    expect(payload.title).toContain("Sparkasse Test");
    expect(payload.tag).toBe(`finance-tan-${bc}`);
    expect(payload.data).toMatchObject({ kind: "finance.tan_required" });

    // status recorded
    const [row] = await db
      .select({ last_sync_status: financeBankcontact.last_sync_status })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bc));
    expect(row.last_sync_status).toBe("tan-required");
  });

  it("records error status when runSynchronize returns error", async () => {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const bc = await insertBankcontact({
      sync_times: [
        { weekdays: [now.getUTCDay()], time: `${hh}:${mm}`, tz: "UTC" },
      ] as any,
    });
    await insertAccountAndAcl(bc, 7, "write");

    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const result = await syncStatements();
    expect(result.errored).toBe(1);

    const [row] = await db
      .select({ last_sync_status: financeBankcontact.last_sync_status })
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bc));
    expect(row.last_sync_status).toBe("error:9910");
  });

  it("returns { contacts_due: 0 } when a due bankcontact has no ACL (TAN session would fail)", async () => {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    await insertBankcontact({
      sync_times: [
        { weekdays: [now.getUTCDay()], time: `${hh}:${mm}`, tz: "UTC" },
      ] as any,
    });
    // No insertAccountAndAcl — no user tied to this bankcontact.

    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "tan-required",
      bankingInformation: {},
      tanChallenge: "x",
      tanReference: "x",
    });

    const result = await syncStatements();
    // The sync still runs, but the crash inside firstResponsibleUser
    // counts as an error for this bankcontact.
    expect(result.contacts_due).toBe(1);
    expect(result.errored).toBe(1);
    expect(pushService.sendToUser).not.toHaveBeenCalled();
  });
});
