import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeBankcontact,
  financeTanSession,
  users,
} from "../db/schema";
import { triggerSync } from "./statements";
import * as fintsClient from "./fints-client";
import type { DialogResult } from "./types";
import { sql } from "drizzle-orm";

// Mock the wrapper — endpoint tests only care about its contract, not
// its implementation. The dedicated fints-client.test.ts covers the
// mapping logic itself.
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

function mockResult(r: DialogResult) {
  vi.mocked(fintsClient.runSynchronize).mockResolvedValue(r);
}

describe("finance/statements — triggerSync", () => {
  it("requires finance.accounts.manage", async () => {
    setAuth("1", []);
    const id = await insertBankcontact();
    await expect(triggerSync({ bankcontactId: id })).rejects.toThrow(
      /permission/,
    );
  });

  it("404s for unknown bankcontact id", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await expect(triggerSync({ bankcontactId: 999_999 })).rejects.toThrow(
      /not found/,
    );
  });

  it("returns state=idle when the dialog finishes cleanly", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const id = await insertBankcontact();
    mockResult({ state: "idle", bankingInformation: { systemId: "sys-1" } });

    const response = await triggerSync({ bankcontactId: id });
    expect(response).toEqual({ state: "idle" });

    const sessions = await db.select().from(financeTanSession);
    expect(sessions).toHaveLength(0);
  });

  it("persists a TAN session and returns tan-required with our UUID, not the FinTS handle", async () => {
    setAuth("7", ["finance.accounts.manage"]);
    await ensureUser(7);
    const id = await insertBankcontact();
    mockResult({
      state: "tan-required",
      bankingInformation: { systemId: "sys-1" },
      tanChallenge: "Bitte in pushTAN bestätigen",
      tanReference: "fints-ref-xyz",
      tanMediaName: "Pixel 7",
    });

    const response = await triggerSync({ bankcontactId: id });
    expect(response.state).toBe("tan-required");
    if (response.state !== "tan-required") throw new Error("type narrow");
    expect(response.challenge).toBe("Bitte in pushTAN bestätigen");
    expect(response.tanMediaName).toBe("Pixel 7");
    // The public reference is a UUID, not the lib-fints handle
    expect(response.tanReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.tanReference).not.toBe("fints-ref-xyz");

    const [session] = await db
      .select()
      .from(financeTanSession)
      .where(eq(financeTanSession.tan_reference, response.tanReference));
    expect(session.user_id).toBe(7);
    expect(session.bankcontact_id).toBe(id);
    expect(session.challenge).toBe("Bitte in pushTAN bestätigen");
    expect(session.banking_information).toMatchObject({
      bi: { systemId: "sys-1" },
      fintsTanRef: "fints-ref-xyz",
    });
    // expires_at ≈ now + 10 min (we allow a 1s tolerance)
    const expiresMs = new Date(session.expires_at).getTime();
    const expected = Date.now() + 10 * 60_000;
    expect(Math.abs(expiresMs - expected)).toBeLessThan(1000);
  });

  it("surfaces an error state without creating a TAN session", async () => {
    setAuth("1", ["finance.accounts.manage"]);
    await ensureUser(1);
    const id = await insertBankcontact();
    mockResult({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const response = await triggerSync({ bankcontactId: id });
    expect(response).toEqual({
      state: "error",
      errorCode: "9910",
      errorMessage: "PIN falsch",
    });

    const sessions = await db.select().from(financeTanSession);
    expect(sessions).toHaveLength(0);
  });
});
