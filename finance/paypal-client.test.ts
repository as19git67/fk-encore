import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeBankcontact,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
} from "../db/schema";
import {
  encryptCredentialBundle,
  decryptCredentialBundle,
  type PaypalCredentials,
} from "./encryption";
import {
  fetchPaypalBalances,
  fetchPaypalTransactions,
  getPaypalAccessToken,
  loadPaypalBankcontact,
  PaypalClientError,
  type PaypalFetcher,
} from "./paypal-client";

// Same drain-from-leaves pattern as bankcontacts.test.ts — FK
// RESTRICTs from finance_transaction → finance_account →
// finance_bankcontact bite otherwise.
beforeEach(async () => {
  await db.execute(sql`DELETE FROM finance_transaction_embedding`);
  await db.delete(financeTagTransaction);
  await db.delete(financeTransaction);
  await db.delete(financeAccountBalance);
  await db.delete(financeTanSession);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
});

/**
 * Insert a paypal bankcontact row and return its id. Defaults aim at
 * "happy path PayPal sandbox connection with refresh token cached".
 */
async function insertPaypalBankcontact(
  overrides: Partial<typeof financeBankcontact.$inferInsert> = {},
  bundle: PaypalCredentials = {
    kind: "paypal",
    refreshToken: "rt-test",
  },
): Promise<number> {
  const [row] = await db
    .insert(financeBankcontact)
    .values({
      name: "PayPal Sandbox",
      access_type: "paypal",
      paypal_environment: "sandbox",
      paypal_client_id: "PAYER123",
      credentials_encrypted: encryptCredentialBundle(bundle),
      ...overrides,
    })
    .returning();
  return row.id;
}

/** Minimal stub-Response factory. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("finance/paypal-client — loadPaypalBankcontact", () => {
  it("rejects a FinTS bankcontact", async () => {
    const [row] = await db
      .insert(financeBankcontact)
      .values({
        name: "FinTS",
        blz: "12345678",
        login: "u",
        server_url: "https://x",
      })
      .returning();
    await expect(loadPaypalBankcontact(row.id)).rejects.toMatchObject({
      name: "PaypalClientError",
      code: "wrong_access_type",
    });
  });

  it("rejects when paypal_environment is missing", async () => {
    const [row] = await db
      .insert(financeBankcontact)
      .values({
        name: "Half-configured PayPal",
        access_type: "paypal",
      })
      .returning();
    await expect(loadPaypalBankcontact(row.id)).rejects.toMatchObject({
      code: "missing_environment",
    });
  });

  it("returns the row for a configured PayPal contact", async () => {
    const id = await insertPaypalBankcontact();
    const loaded = await loadPaypalBankcontact(id);
    expect(loaded.access_type).toBe("paypal");
    expect(loaded.paypal_environment).toBe("sandbox");
  });
});

describe("finance/paypal-client — getPaypalAccessToken", () => {
  it("returns the cached token while it is still valid", async () => {
    const cachedExpires = new Date(Date.now() + 60 * 60_000).toISOString();
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt-test",
      accessToken: "cached-at",
      accessTokenExpiresAt: cachedExpires,
    });
    const fetcher: PaypalFetcher = vi.fn(async () => {
      throw new Error("should not call /oauth2/token when cache is valid");
    });
    const token = await getPaypalAccessToken(id, { fetcher });
    expect(token).toBe("cached-at");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes the token when the cached one is within the leeway window", async () => {
    // Cached token expires in 10s — inside the 60s leeway, so a
    // refresh is mandatory.
    const cachedExpires = new Date(Date.now() + 10_000).toISOString();
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt-current",
      accessToken: "stale-at",
      accessTokenExpiresAt: cachedExpires,
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1/oauth2/token");
      expect(init?.method).toBe("POST");
      const body = String(init?.body ?? "");
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=rt-current");
      return jsonResponse(200, {
        access_token: "fresh-at",
        token_type: "Bearer",
        expires_in: 32_400,
        scope: "https://uri.paypal.com/services/reporting/balances.read",
      });
    }) as unknown as PaypalFetcher;

    const token = await getPaypalAccessToken(id, { fetcher });
    expect(token).toBe("fresh-at");

    // Persisted bundle should now carry the new access token.
    const [persisted] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id));
    const bundle = decryptCredentialBundle(persisted.credentials_encrypted!);
    expect(bundle).toMatchObject({
      kind: "paypal",
      refreshToken: "rt-current",
      accessToken: "fresh-at",
    });
    if (bundle.kind !== "paypal") throw new Error("expected paypal bundle");
    expect(Date.parse(bundle.accessTokenExpiresAt!)).toBeGreaterThan(Date.now());
  });

  it("rotates the refresh token when PayPal returns a new one", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt-old",
    });
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        access_token: "fresh-at",
        expires_in: 32_400,
        refresh_token: "rt-rotated",
      }),
    ) as unknown as PaypalFetcher;
    await getPaypalAccessToken(id, { fetcher });
    const [persisted] = await db
      .select()
      .from(financeBankcontact)
      .where(eq(financeBankcontact.id, id));
    const bundle = decryptCredentialBundle(persisted.credentials_encrypted!);
    expect(bundle).toMatchObject({
      kind: "paypal",
      refreshToken: "rt-rotated",
      accessToken: "fresh-at",
    });
  });

  it("throws missing_refresh_token when the contact has no refresh token yet", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      // no refreshToken
    });
    const fetcher: PaypalFetcher = vi.fn();
    await expect(getPaypalAccessToken(id, { fetcher })).rejects.toMatchObject({
      code: "missing_refresh_token",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws on a non-200 token response", async () => {
    const id = await insertPaypalBankcontact();
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as PaypalFetcher;
    await expect(getPaypalAccessToken(id, { fetcher })).rejects.toMatchObject({
      code: "http_401",
    });
  });

  it("throws when the contact's credentials are a FinTS bundle", async () => {
    // Build a row with PayPal access_type but a FinTS-bundle blob —
    // a malformed migration / manual edit shouldn't silently work.
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt-test",
    });
    await db
      .update(financeBankcontact)
      .set({
        credentials_encrypted: encryptCredentialBundle({
          kind: "fints",
          pin: "1234",
        }),
      })
      .where(eq(financeBankcontact.id, id));
    const fetcher: PaypalFetcher = vi.fn();
    await expect(
      getPaypalAccessToken(id, { fetcher }),
    ).rejects.toMatchObject({ code: "wrong_credentials_kind" });
  });
});

describe("finance/paypal-client — fetchPaypalBalances", () => {
  it("normalises the PayPal balances response", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt-test",
      accessToken: "valid-at",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api-m.sandbox.paypal.com/v1/reporting/balances");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer valid-at",
      );
      return jsonResponse(200, {
        account_id: "ACC-1",
        as_of_time: "2026-05-23T10:00:00Z",
        balances: [
          {
            currency: "EUR",
            primary: true,
            total_balance: { currency_code: "EUR", value: "120.50" },
            available_balance: { currency_code: "EUR", value: "100.00" },
          },
          {
            currency: "USD",
            primary: false,
            total_balance: { currency_code: "USD", value: "0.00" },
            available_balance: { currency_code: "USD", value: "0.00" },
          },
        ],
      });
    }) as unknown as PaypalFetcher;

    const balances = await fetchPaypalBalances(id, { fetcher });
    expect(balances).toEqual([
      {
        currency: "EUR",
        total: "120.50",
        available: "100.00",
        primary: true,
        asOf: "2026-05-23T10:00:00Z",
      },
      {
        currency: "USD",
        total: "0.00",
        available: "0.00",
        primary: false,
        asOf: "2026-05-23T10:00:00Z",
      },
    ]);
  });

  it("targets the live API when the contact is in live mode", async () => {
    const id = await insertPaypalBankcontact(
      { paypal_environment: "live" },
      {
        kind: "paypal",
        refreshToken: "rt",
        accessToken: "live-at",
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    );
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url);
      return jsonResponse(200, { as_of_time: "2026-05-23T00:00:00Z", balances: [] });
    }) as unknown as PaypalFetcher;
    await fetchPaypalBalances(id, { fetcher });
    expect(seen[0]).toBe("https://api-m.paypal.com/v1/reporting/balances");
  });

  it("surfaces non-200 responses as PaypalClientError", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const fetcher = vi.fn(async () =>
      new Response("rate limit", { status: 429 }),
    ) as unknown as PaypalFetcher;
    await expect(
      fetchPaypalBalances(id, { fetcher }),
    ).rejects.toBeInstanceOf(PaypalClientError);
    await expect(
      fetchPaypalBalances(id, { fetcher }),
    ).rejects.toMatchObject({ code: "http_429" });
  });
});

describe("finance/paypal-client — fetchPaypalTransactions", () => {
  it("maps PayPal transaction_details into the DTO shape", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        page: 1,
        total_pages: 1,
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "TX-1",
              transaction_event_code: "T0006",
              transaction_initiation_date: "2026-05-20T10:00:00Z",
              transaction_updated_date: "2026-05-20T10:00:05Z",
              transaction_amount: { currency_code: "EUR", value: "-9.99" },
              transaction_subject: "Adobe Photoshop subscription",
              transaction_note: "Monatlich",
              transaction_status: "S",
            },
            payer_info: {
              email_address: "merchant@example.com",
              payer_name: { alternate_full_name: "Adobe Systems Inc." },
            },
          },
          {
            transaction_info: {
              transaction_id: "TX-2",
              transaction_initiation_date: "2026-05-21T08:00:00Z",
              transaction_amount: { currency_code: "EUR", value: "25.00" },
              transaction_status: "S",
            },
            payer_info: {
              payer_name: { given_name: "Anna", surname: "Schmidt" },
            },
          },
        ],
      }),
    ) as unknown as PaypalFetcher;

    const start = new Date("2026-05-20T00:00:00Z");
    const end = new Date("2026-05-21T23:59:59Z");
    const txs = await fetchPaypalTransactions(id, start, end, { fetcher });

    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({
      transactionId: "TX-1",
      bookingDate: "2026-05-20T10:00:00Z",
      valueDate: "2026-05-20T10:00:05Z",
      amount: "-9.99",
      currency: "EUR",
      purpose: "Adobe Photoshop subscription — Monatlich",
      counterparty: "Adobe Systems Inc.",
      counterpartyEmail: "merchant@example.com",
      eventCode: "T0006",
      status: "S",
    });
    expect(txs[0].raw).toMatchObject({
      transaction_info: { transaction_id: "TX-1" },
    });
    expect(txs[1]).toMatchObject({
      transactionId: "TX-2",
      counterparty: "Anna Schmidt",
      valueDate: null,
      eventCode: null,
    });
  });

  it("follows pagination across multiple pages", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const pages = [
      {
        page: 1,
        total_pages: 2,
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "TX-A",
              transaction_initiation_date: "2026-05-20T10:00:00Z",
              transaction_amount: { currency_code: "EUR", value: "1.00" },
            },
          },
        ],
      },
      {
        page: 2,
        total_pages: 2,
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "TX-B",
              transaction_initiation_date: "2026-05-20T10:01:00Z",
              transaction_amount: { currency_code: "EUR", value: "2.00" },
            },
          },
        ],
      },
    ];
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      seen.push(url);
      const u = new URL(url);
      const page = parseInt(u.searchParams.get("page") ?? "1", 10);
      return jsonResponse(200, pages[page - 1]);
    }) as unknown as PaypalFetcher;

    const txs = await fetchPaypalTransactions(
      id,
      new Date("2026-05-20T00:00:00Z"),
      new Date("2026-05-20T23:59:59Z"),
      { fetcher },
    );
    expect(txs.map((t) => t.transactionId)).toEqual(["TX-A", "TX-B"]);
    expect(seen).toHaveLength(2);
    expect(new URL(seen[0]).searchParams.get("page")).toBe("1");
    expect(new URL(seen[1]).searchParams.get("page")).toBe("2");
  });

  it("skips records without a transaction_id", async () => {
    const id = await insertPaypalBankcontact({}, {
      kind: "paypal",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        page: 1,
        total_pages: 1,
        transaction_details: [
          { transaction_info: { transaction_amount: { currency_code: "EUR", value: "1.00" } } },
          {
            transaction_info: {
              transaction_id: "TX-OK",
              transaction_initiation_date: "2026-05-20T10:00:00Z",
              transaction_amount: { currency_code: "EUR", value: "5.00" },
            },
          },
        ],
      }),
    ) as unknown as PaypalFetcher;
    const txs = await fetchPaypalTransactions(
      id,
      new Date("2026-05-20T00:00:00Z"),
      new Date("2026-05-20T23:59:59Z"),
      { fetcher },
    );
    expect(txs.map((t) => t.transactionId)).toEqual(["TX-OK"]);
  });
});
