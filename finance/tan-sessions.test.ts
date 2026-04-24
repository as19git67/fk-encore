import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeBankcontact,
  financeTanSession,
  users,
} from "../db/schema";
import {
  cleanupExpiredTanSessions,
  completeTanSession,
} from "./tan-sessions";
import * as fintsClient from "./fints-client";
import type { DialogResult } from "./types";

vi.mock("./fints-client", async (orig) => {
  const actual = await orig<typeof import("./fints-client")>();
  return {
    ...actual,
    runSynchronize: vi.fn(),
  };
});

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (existing.length > 0) return;
  // Raw INSERT so we can pick the id explicitly — users is a serial PK.
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
  setAuth("1", []);
  vi.mocked(fintsClient.runSynchronize).mockReset();
});

async function insertSession(opts: {
  userId: number;
  bankcontactId: number;
  expiresAt?: Date;
  fintsTanRef?: string;
}): Promise<string> {
  await ensureUser(opts.userId);
  const ref = randomUUID();
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 10 * 60_000);
  await db.insert(financeTanSession).values({
    tan_reference: ref,
    user_id: opts.userId,
    bankcontact_id: opts.bankcontactId,
    banking_information: {
      bi: { systemId: "sys-stored" },
      fintsTanRef: opts.fintsTanRef ?? "fints-ref-xyz",
    },
    challenge: "stored-challenge",
    expires_at: expiresAt.toISOString(),
  });
  return ref;
}

async function insertBankcontact(): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "Test",
      blz: "12345678",
      login: "u",
      server_url: "https://x",
    })
    .returning({ id: financeBankcontact.id });
  return row.id;
}

// ---------- complete ----------

describe("finance/tan-sessions — complete (happy path)", () => {
  it("calls runSynchronize with stored bankingInformation + fintsTanRef + user TAN, then deletes the session", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({
      userId: 42,
      bankcontactId: bcId,
      fintsTanRef: "fints-ref-xyz",
    });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
      bankingInformation: { systemId: "sys-post-tan" },
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });
    expect(response).toEqual({ state: "idle" });

    expect(fintsClient.runSynchronize).toHaveBeenCalledWith(bcId, {
      tanReference: "fints-ref-xyz",
      tanAnswer: "123456",
      bankingInformation: { systemId: "sys-stored" },
    });

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(0);
  });

  it("passes undefined TAN through for decoupled methods (pushTAN)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "idle",
    });

    await completeTanSession({ tanReference: ref });

    const arg = vi.mocked(fintsClient.runSynchronize).mock.calls[0]?.[1];
    expect(arg?.tanAnswer).toBeUndefined();
  });
});

describe("finance/tan-sessions — complete (error / retry paths)", () => {
  it("updates the session with the new challenge when the bank returns tan-required again (wrong TAN)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "tan-required",
      bankingInformation: { systemId: "sys-retry" },
      tanChallenge: "Falsche TAN, bitte erneut",
      tanReference: "fints-ref-v2",
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "wrong",
    });
    expect(response.state).toBe("tan-required");
    if (response.state !== "tan-required") throw new Error("type narrow");
    expect(response.tanReference).toBe(ref); // same public handle
    expect(response.challenge).toBe("Falsche TAN, bitte erneut");

    // Session still there, banking_information + challenge updated
    const [after] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(after).toBeDefined();
    expect(after.challenge).toBe("Falsche TAN, bitte erneut");
    expect(after.banking_information).toMatchObject({
      bi: { systemId: "sys-retry" },
      fintsTanRef: "fints-ref-v2",
    });
  });

  it("deletes the session and returns error when the dialog errors out terminally", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 42, bankcontactId: bcId });
    vi.mocked(fintsClient.runSynchronize).mockResolvedValue({
      state: "error",
      errorCode: "9050",
      errorMessage: "Dialog abgebrochen",
    });

    const response = await completeTanSession({
      tanReference: ref,
      tan: "123456",
    });
    expect(response).toEqual({
      state: "error",
      errorCode: "9050",
      errorMessage: "Dialog abgebrochen",
    });

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(0);
  });
});

describe("finance/tan-sessions — complete (access & expiry)", () => {
  it("404s for an unknown tanReference without calling fints-client", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    await expect(
      completeTanSession({ tanReference: randomUUID(), tan: "x" }),
    ).rejects.toThrow(/not found/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();
  });

  it("refuses a session owned by a different user (returns the same 'not found' to prevent enumeration)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({ userId: 99, bankcontactId: bcId });

    await expect(
      completeTanSession({ tanReference: ref, tan: "x" }),
    ).rejects.toThrow(/not found/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();
  });

  it("returns deadline_exceeded for an expired session (row stays for cleanup cron)", async () => {
    setAuth("42", ["finance.accounts.manage"]);
    const bcId = await insertBankcontact();
    const ref = await insertSession({
      userId: 42,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      completeTanSession({ tanReference: ref, tan: "x" }),
    ).rejects.toThrow(/expired/);
    expect(fintsClient.runSynchronize).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, ref));
    expect(rows).toHaveLength(1);
  });

  it("requires finance.accounts.manage", async () => {
    setAuth("42", []);
    await expect(
      completeTanSession({ tanReference: randomUUID(), tan: "x" }),
    ).rejects.toThrow(/permission/);
  });
});

// ---------- cleanup cron ----------

describe("finance/tan-sessions — cleanupExpiredTanSessions", () => {
  it("deletes only rows past expires_at", async () => {
    const bcId = await insertBankcontact();
    const past = await insertSession({
      userId: 1,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() - 5_000),
    });
    const future = await insertSession({
      userId: 1,
      bankcontactId: bcId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const { deleted } = await cleanupExpiredTanSessions();
    expect(deleted).toBe(1);

    const rows = await db.select().from(financeTanSession);
    expect(rows.map((r) => r.tan_reference)).toEqual([future]);
    void past; // kept for readability of the test intent
  });
});
