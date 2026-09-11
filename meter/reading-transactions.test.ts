import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  users,
} from "../db/schema";
import * as links from "./reading-transactions";
import * as readings from "./readings";
import { getAdvancePaymentsReport } from "./reports";

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

const ALL = ["meters.view", "meters.read_entry", "meters.manage", "finance.view"];

let ownerId: number;
let strangerId: number;
let meterId: number;
let readingId: number;
let accountId: number;
let transactionId: number;
const cleanupUserIds: number[] = [];
const cleanupAccountIds: number[] = [];

async function createUser(label: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      email: `rt-${label}-${Date.now()}-${Math.random()}@example.com`,
      name: `Link Tester ${label}`,
      password_hash: "x",
    })
    .returning({ id: users.id });
  return row.id;
}

beforeEach(async () => {
  ownerId = await createUser("owner");
  strangerId = await createUser("stranger");
  cleanupUserIds.push(ownerId, strangerId);

  const [meter] = await db
    .insert(meters)
    .values({ name: "Strom", type: "electricity", unit: "kWh", owner_user_id: ownerId })
    .returning({ id: meters.id });
  meterId = meter.id;
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: meterId, installed_at: "2024-01-01T00:00:00Z", start_value: "0" })
    .returning({ id: meterDevices.id });
  const [reading] = await db
    .insert(meterReadings)
    .values({ device_id: device.id, value: "1000", taken_at: "2025-01-01T00:00:00Z", entered_by: ownerId })
    .returning({ id: meterReadings.id });
  readingId = Number(reading.id);

  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [account] = await db
    .insert(financeAccount)
    .values({
      bankcontact_id: null,
      type_id: type!.id,
      currency_code: "EUR",
      account_number: `RT-${Date.now()}-${Math.random()}`,
      label: "Giro",
    })
    .returning({ id: financeAccount.id });
  accountId = account.id;
  cleanupAccountIds.push(accountId);
  await db.insert(financeAccountAccess).values({ account_id: accountId, user_id: ownerId, level: "write" });
  const [tx] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: "2025-01-15",
      amount: "-85.00",
      currency_code: "EUR",
      counterparty: "Beispiel Energie",
      purpose: "Abschlag Strom",
      dedupe_hash: `rt-${Date.now()}-${Math.random()}`.padEnd(64, "0"),
    })
    .returning({ id: financeTransaction.id });
  transactionId = Number(tx.id);

  setAuth(String(ownerId), ALL);
});

afterEach(async () => {
  if (cleanupAccountIds.length > 0) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, cleanupAccountIds));
    await db.delete(financeAccount).where(inArray(financeAccount.id, cleanupAccountIds.splice(0)));
  }
  for (const id of cleanupUserIds.splice(0)) {
    await db.delete(users).where(eq(users.id, id));
  }
  vi.restoreAllMocks();
});

describe("reading ↔ transaction links", () => {
  it("links, lists and unlinks a transaction on a reading", async () => {
    const linked = await links.linkReadingTransactionLink({ readingId, transactionId });
    expect(linked.linked).toBe(true);

    const list = await links.listReadingTransactionLinks({ readingId });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      transactionId,
      amount: -85,
      currencyCode: "EUR",
      counterparty: "Beispiel Energie",
      purpose: "Abschlag Strom",
    });

    // The readings list carries the count.
    const page = await readings.listReadings({ id: meterId });
    expect(page.readings[0].linkedTransactions).toBe(1);

    await links.unlinkReadingTransactionLink({ readingId, transactionId });
    expect((await links.listReadingTransactionLinks({ readingId })).items).toEqual([]);
    expect((await readings.listReadings({ id: meterId })).readings[0].linkedTransactions).toBe(0);
  });

  it("is idempotent", async () => {
    await links.linkReadingTransactionLink({ readingId, transactionId });
    const second = await links.linkReadingTransactionLink({ readingId, transactionId });
    expect(second.linked).toBe(false);
    expect((await links.listReadingTransactionLinks({ readingId })).items).toHaveLength(1);
  });

  it("refuses a transaction outside the caller's finance ACL", async () => {
    setAuth(String(strangerId), ALL);
    // The stranger cannot even see the meter.
    await expect(
      links.linkReadingTransactionLink({ readingId, transactionId }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Owner of the meter, but without access to the account.
    await db.delete(financeAccountAccess).where(eq(financeAccountAccess.account_id, accountId));
    setAuth(String(ownerId), ALL);
    await expect(
      links.linkReadingTransactionLink({ readingId, transactionId }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("hides linked transactions the caller may no longer read", async () => {
    await links.linkReadingTransactionLink({ readingId, transactionId });
    await db.delete(financeAccountAccess).where(eq(financeAccountAccess.account_id, accountId));
    expect((await links.listReadingTransactionLinks({ readingId })).items).toEqual([]);
    // finance.admin bypasses the ACL.
    setAuth(String(ownerId), [...ALL, "finance.admin"]);
    expect((await links.listReadingTransactionLinks({ readingId })).items).toHaveLength(1);
  });

  it("requires finance.view on top of the meter permissions", async () => {
    setAuth(String(ownerId), ["meters.view", "meters.read_entry"]);
    await expect(links.listReadingTransactionLinks({ readingId })).rejects.toMatchObject({
      code: "permission_denied",
    });
    setAuth(String(ownerId), ["meters.view", "finance.view"]);
    await expect(
      links.linkReadingTransactionLink({ readingId, transactionId }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("returns not_found for an unknown reading", async () => {
    await expect(
      links.listReadingTransactionLinks({ readingId: 999_999_999 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("GET /meters/reports/advance-payments", () => {
  it("sums linked payments per meter and year", async () => {
    await links.linkReadingTransactionLink({ readingId, transactionId });
    const [tx2] = await db
      .insert(financeTransaction)
      .values({
        account_id: accountId,
        booking_date: "2025-02-15",
        amount: "-85.00",
        currency_code: "EUR",
        dedupe_hash: `rt2-${Date.now()}-${Math.random()}`.padEnd(64, "0"),
      })
      .returning({ id: financeTransaction.id });
    await links.linkReadingTransactionLink({ readingId, transactionId: Number(tx2.id) });

    const report = await getAdvancePaymentsReport();
    expect(report.currency).toBe("EUR");
    const entry = report.meters.find((m) => m.meterId === meterId)!;
    expect(entry.years).toHaveLength(1);
    expect(entry.years[0]).toMatchObject({ year: 2025, paidEur: 170, transactions: 2 });
    // No tariffs and no PV set in this test → no cost model figure.
    expect(entry.years[0].actualCostEur).toBeNull();
    expect(entry.years[0].expectedSettlementEur).toBeNull();
  });

  it("omits meters without links", async () => {
    const report = await getAdvancePaymentsReport();
    expect(report.meters.find((m) => m.meterId === meterId)).toBeUndefined();
  });
});
