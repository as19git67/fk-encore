import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeBankcontact,
  financePaypalOauthState,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
  users,
} from "../db/schema";
import {
  cleanupExpiredPaypalOauthStates,
  completeConnect,
  disconnectPaypal,
  ensurePaypalAccount,
  readPaypalCredentials,
  runStartPaypalConnect,
} from "./paypal-oauth";
import { encryptCredentialBundle } from "./encryption";
import { getAuthData } from "~encore/auth";

beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financePaypalOauthState);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
});

async function insertUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ email: "u@example.com", name: "U", password_hash: "x" })
    .returning({ id: users.id });
  return u.id;
}

async function insertPaypalBankcontact(
  env: "sandbox" | "live" = "sandbox",
): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "PayPal",
      access_type: "paypal",
      paypal_environment: env,
    })
    .returning();
  return row.id;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("paypal-oauth — runStartPaypalConnect", () => {
  it("mints a state row and returns the PayPal auth URL", async () => {
    const userId = await insertUser();
    const bcId = await insertPaypalBankcontact("sandbox");

    const result = await runStartPaypalConnect(bcId, userId);
    expect(result.state).toMatch(/^[0-9a-f]{64}$/);
    expect(result.auth_url).toContain(
      "https://www.sandbox.paypal.com/signin/authorize",
    );
    expect(result.auth_url).toContain(`state=${result.state}`);
    expect(result.auth_url).toContain("response_type=code");
    expect(result.auth_url).toContain("openid");

    const [row] = await db
      .select()
      .from(financePaypalOauthState)
      .where(eq(financePaypalOauthState.state, result.state));
    expect(row.bankcontact_id).toBe(bcId);
    expect(row.user_id).toBe(userId);
    expect(row.environment).toBe("sandbox");
  });

  it("uses the live auth host for live bankcontacts", async () => {
    const userId = await insertUser();
    const bcId = await insertPaypalBankcontact("live");
    const result = await runStartPaypalConnect(bcId, userId);
    expect(result.auth_url).toContain("https://www.paypal.com/signin/authorize");
  });

  it("drops stale state rows for the same bankcontact", async () => {
    const userId = await insertUser();
    const bcId = await insertPaypalBankcontact("sandbox");
    const first = await runStartPaypalConnect(bcId, userId);
    const second = await runStartPaypalConnect(bcId, userId);
    expect(first.state).not.toBe(second.state);

    const stillThere = await db
      .select()
      .from(financePaypalOauthState)
      .where(eq(financePaypalOauthState.bankcontact_id, bcId));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].state).toBe(second.state);
  });

  it("rejects a non-paypal bankcontact", async () => {
    const userId = await insertUser();
    const [bc] = await db
      .insert(financeBankcontact)
      .values({
        name: "FinTS",
        blz: "12345678",
        login: "u",
        server_url: "https://x",
      })
      .returning();
    await expect(runStartPaypalConnect(bc.id, userId)).rejects.toThrow(
      /not "paypal"/,
    );
  });
});

describe("paypal-oauth — completeConnect", () => {
  it("exchanges code, persists tokens, and creates the wallet account", async () => {
    const bcId = await insertPaypalBankcontact("sandbox");

    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes("/v1/oauth2/token")) {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=AUTH123");
        return jsonResponse(200, {
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 32_400,
        });
      }
      if (url.includes("/v1/identity/openidconnect/userinfo")) {
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
          "Bearer at-new",
        );
        return jsonResponse(200, { payer_id: "PAYER999" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await completeConnect(bcId, "sandbox", "AUTH123", {
      fetcher: fetcher as never,
    });

    expect(calls[0]).toContain("/v1/oauth2/token");
    expect(calls[1]).toContain("/v1/identity/openidconnect/userinfo");

    // Tokens persisted as a paypal bundle.
    const creds = await readPaypalCredentials(bcId);
    expect(creds).toMatchObject({
      kind: "paypal",
      refreshToken: "rt-new",
      accessToken: "at-new",
    });

    // paypal_client_id captured from userinfo.
    const [bc] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(bc.paypal_client_id).toBe("PAYER999");
    expect(bc.last_sync_status).toBe("ok");

    // Wallet account auto-created.
    const accounts = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, bcId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].fints_account_number).toBe("PAYER999");
    expect(accounts[0].label).toBe("PayPal PayPal");
  });

  it("does not duplicate the wallet account when reconnecting", async () => {
    const bcId = await insertPaypalBankcontact("sandbox");

    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/v1/oauth2/token")) {
        return jsonResponse(200, {
          access_token: "at1",
          refresh_token: "rt1",
          expires_in: 32_400,
        });
      }
      return jsonResponse(200, { payer_id: "P1" });
    });
    await completeConnect(bcId, "sandbox", "C1", { fetcher: fetcher as never });
    await completeConnect(bcId, "sandbox", "C2", { fetcher: fetcher as never });
    const accounts = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, bcId));
    expect(accounts).toHaveLength(1);
  });

  it("surfaces an error if PayPal returns a non-200 on the token exchange", async () => {
    const bcId = await insertPaypalBankcontact("sandbox");
    const fetcher = vi.fn(async () =>
      new Response("invalid_grant", { status: 401 }),
    );
    await expect(
      completeConnect(bcId, "sandbox", "AUTH", { fetcher: fetcher as never }),
    ).rejects.toThrow(/paypal token exchange returned 401/);
  });
});

describe("paypal-oauth — disconnectPaypal", () => {
  it("clears the stored credentials", async () => {
    const bcId = await insertPaypalBankcontact("sandbox");
    await db
      .update(financeBankcontact)
      .set({
        credentials_encrypted: encryptCredentialBundle({
          kind: "paypal",
          refreshToken: "rt",
        }),
      })
      .where(eq(financeBankcontact.id, bcId));

    vi.mocked(getAuthData).mockReturnValueOnce({
      userID: "1",
      permissions: ["finance.accounts.manage"],
    } as never);

    const resp = await disconnectPaypal({ id: bcId });
    expect(resp.disconnected).toBe(true);

    const [bc] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, bcId));
    expect(bc.credentials_encrypted).toBeNull();
    expect(bc.last_sync_status).toBe("disconnected");
  });
});

describe("paypal-oauth — ensurePaypalAccount", () => {
  it("creates the wallet account once and is idempotent", async () => {
    const bcId = await insertPaypalBankcontact("sandbox");
    const first = await ensurePaypalAccount(bcId, "PAYER42");
    const second = await ensurePaypalAccount(bcId, "PAYER42");
    expect(first).toBe(second);
    const all = await db
      .select()
      .from(financeAccount)
      .where(eq(financeAccount.bankcontact_id, bcId));
    expect(all).toHaveLength(1);
  });
});

describe("paypal-oauth — cleanupExpiredPaypalOauthStates", () => {
  it("removes only state rows whose expires_at has passed", async () => {
    const userId = await insertUser();
    const bcId = await insertPaypalBankcontact("sandbox");
    await db.insert(financePaypalOauthState).values([
      {
        state: "expired",
        bankcontact_id: bcId,
        user_id: userId,
        environment: "sandbox",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        state: "fresh",
        bankcontact_id: bcId,
        user_id: userId,
        environment: "sandbox",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    const removed = await cleanupExpiredPaypalOauthStates();
    expect(removed).toBe(1);
    const remaining = await db.select().from(financePaypalOauthState);
    expect(remaining.map((r) => r.state)).toEqual(["fresh"]);
  });
});
