import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeAnomaly,
  financeBankcontact,
  financeRecurringMandate,
  financeTagTransaction,
  financeTanSession,
  financeTransaction,
} from "../db/schema";
import {
  addCadence,
  cadenceOf,
  endOfMonth,
  expectedDates,
  isEnded,
  isIsoDate,
  listUpcomingDebits,
} from "./upcoming-debits";

// ── next-date computation ──────────────────────────────────────────────────

describe("cadenceOf", () => {
  it("snaps observed means to calendar cadences", () => {
    expect(cadenceOf(30)).toEqual({ months: 1 });
    expect(cadenceOf(31)).toEqual({ months: 1 });
    expect(cadenceOf(91)).toEqual({ months: 3 });
    expect(cadenceOf(182)).toEqual({ months: 6 });
    expect(cadenceOf(365)).toEqual({ months: 12 });
    expect(cadenceOf(14)).toEqual({ days: 14 });
    expect(cadenceOf(45)).toEqual({ days: 45 });
  });
});

describe("addCadence", () => {
  it("keeps the day of month and clamps to the month's end", () => {
    expect(addCadence("2026-01-31", { months: 1 }, 1)).toBe("2026-02-28");
    // Counted from the anchor each time, so the clamp does not stick.
    expect(addCadence("2026-01-31", { months: 1 }, 2)).toBe("2026-03-31");
    expect(addCadence("2024-02-29", { months: 12 }, 1)).toBe("2025-02-28");
    expect(addCadence("2026-11-15", { months: 3 }, 1)).toBe("2027-02-15");
    expect(addCadence("2026-10-30", { days: 7 }, 1)).toBe("2026-11-06");
  });
});

describe("expectedDates", () => {
  const today = "2026-10-15";

  it("monthly: the next date inside the window", () => {
    expect(expectedDates({ lastSeen: "2026-09-20", intervalDays: 30, from: today, until: "2026-10-31", today }))
      .toEqual([{ date: "2026-10-20", overdue: false }]);
  });

  it("monthly: a series already booked this month is not expected again", () => {
    expect(expectedDates({ lastSeen: "2026-10-01", intervalDays: 31, from: today, until: "2026-10-31", today }))
      .toEqual([]);
  });

  it("monthly on the 1st does not drift into the previous month", () => {
    // 30-day steps from 1 Sep would land on 31 Oct and count it twice this year.
    expect(expectedDates({ lastSeen: "2026-09-01", intervalDays: 30, from: "2026-10-16", until: "2026-10-31", today }))
      .toEqual([]);
  });

  it("quarterly", () => {
    expect(expectedDates({ lastSeen: "2026-08-01", intervalDays: 92, from: today, until: "2026-12-31", today }))
      .toEqual([{ date: "2026-11-01", overdue: false }]);
  });

  it("yearly", () => {
    expect(expectedDates({ lastSeen: "2025-12-05", intervalDays: 365, from: today, until: "2026-12-31", today }))
      .toEqual([{ date: "2026-12-05", overdue: false }]);
  });

  it("a series due twice in a long window", () => {
    expect(expectedDates({ lastSeen: "2026-09-28", intervalDays: 30, from: today, until: "2026-12-31", today }))
      .toEqual([
        { date: "2026-10-28", overdue: false },
        { date: "2026-11-28", overdue: false },
        { date: "2026-12-28", overdue: false },
      ]);
  });

  it("weekly yields every week", () => {
    expect(expectedDates({ lastSeen: "2026-10-12", intervalDays: 7, from: today, until: "2026-10-31", today })
      .map((d) => d.date)).toEqual(["2026-10-19", "2026-10-26"]);
  });

  it("a booking a few days late is still expected, as overdue", () => {
    expect(expectedDates({ lastSeen: "2026-09-10", intervalDays: 30, from: today, until: "2026-10-31", today }))
      .toEqual([{ date: "2026-10-10", overdue: true }]);
  });

  it("past the grace the late booking is skipped and the next one counts", () => {
    expect(expectedDates({ lastSeen: "2026-08-01", intervalDays: 30, from: today, until: "2026-11-30", today }))
      .toEqual([{ date: "2026-11-01", overdue: false }]);
  });

  it("no overdue entry for a window in the future", () => {
    expect(expectedDates({ lastSeen: "2026-09-10", intervalDays: 30, from: "2026-11-01", until: "2026-11-30", today }))
      .toEqual([{ date: "2026-11-10", overdue: false }]);
  });
});

describe("isEnded", () => {
  it("a series silent for more than three intervals has ended", () => {
    expect(isEnded("2026-06-01", 30, "2026-10-15")).toBe(true);
    expect(isEnded("2026-08-01", 30, "2026-10-15")).toBe(false);
    expect(isEnded("2025-12-05", 365, "2026-10-15")).toBe(false);
  });
});

describe("date helpers", () => {
  it("endOfMonth and isIsoDate", () => {
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2026-12-31")).toBe("2026-12-31");
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("15.10.2026")).toBe(false);
  });
});

// ── endpoint ───────────────────────────────────────────────────────────────

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`,
  );
}

async function insertAccount(label: string, closed = false): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({
      type_id: type.id,
      currency_code: "EUR",
      account_number: `AN-${label}`,
      label,
      closed_at: closed ? "2026-01-01T00:00:00Z" : null,
    })
    .returning({ id: financeAccount.id });
  return row.id;
}

async function insertMandate(values: {
  accountId: number;
  counterparty: string;
  amount: string;
  interval: number;
  lastSeen: string;
  channel?: string | null;
  count?: number;
}): Promise<number> {
  const [row] = await db
    .insert(financeRecurringMandate)
    .values({
      account_id: values.accountId,
      counterparty: values.counterparty,
      creditor_id: "DE00ZZZ00000000000",
      mandate_ref: `REF-${values.counterparty}`,
      payment_channel: values.channel === undefined ? "direct_debit" : values.channel,
      typical_amount: values.amount,
      typical_interval_days: values.interval,
      transaction_count: values.count ?? 8,
      first_seen: "2025-01-01",
      last_seen: values.lastSeen,
    })
    .returning({ id: financeRecurringMandate.id });
  return row.id;
}

describe("GET /finance/mandates/upcoming", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00"));
    await db.delete(financeAnomaly);
    await db.delete(financeRecurringMandate);
    await db.execute(sql`DELETE FROM finance_transaction_embedding`);
    await db.delete(financeTagTransaction);
    await db.delete(financeTransaction);
    await db.delete(financeAccountBalance);
    await db.delete(financeTanSession);
    await db.delete(financeAccountAccess);
    await db.delete(financeAccount);
    await db.delete(financeBankcontact);
    await ensureUser(901);
    await ensureUser(902);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the debits due in the rest of the month with their sum", async () => {
    const giro = await insertAccount("Giro");
    await db.insert(financeAccountAccess).values({ account_id: giro, user_id: 901, level: "read" });
    await insertMandate({ accountId: giro, counterparty: "Stadtwerke Musterstadt", amount: "-84.00", interval: 30, lastSeen: "2026-09-20" });
    await insertMandate({ accountId: giro, counterparty: "Beispiel Versicherung", amount: "-32.50", interval: 91, lastSeen: "2026-07-28" });
    // Already booked this month.
    await insertMandate({ accountId: giro, counterparty: "Muster Telekom", amount: "-39.99", interval: 30, lastSeen: "2026-10-02" });
    // Ended: silent for more than three months.
    await insertMandate({ accountId: giro, counterparty: "Alter Verein", amount: "-10.00", interval: 30, lastSeen: "2026-05-01" });
    // Not a debit: income, card habit, too few bookings.
    await insertMandate({ accountId: giro, counterparty: "Arbeitgeber", amount: "2500.00", interval: 30, lastSeen: "2026-09-30" });
    await insertMandate({ accountId: giro, counterparty: "Bäckerei", amount: "-6.40", interval: 30, lastSeen: "2026-09-25", channel: "card" });
    await insertMandate({ accountId: giro, counterparty: "Neu GmbH", amount: "-9.00", interval: 30, lastSeen: "2026-09-25", count: 2 });

    setAuth("901", ["finance.view"]);
    const res = await listUpcomingDebits({});

    expect(res.from).toBe("2026-10-15");
    expect(res.until).toBe("2026-10-31");
    expect(res.items.map((i) => [i.counterparty, i.expected_date])).toEqual([
      ["Stadtwerke Musterstadt", "2026-10-20"],
      ["Beispiel Versicherung", "2026-10-28"],
    ]);
    expect(res.items[0]).toMatchObject({ account_label: "Giro", typical_amount: "-84.00", overdue: false });
    expect(res.count).toBe(2);
    expect(res.total_amount).toBe("-116.50");
  });

  it("shows only mandates on accounts the caller may read", async () => {
    const mine = await insertAccount("Mein Giro");
    const other = await insertAccount("Fremdes Giro");
    await db.insert(financeAccountAccess).values({ account_id: mine, user_id: 901, level: "read" });
    await db.insert(financeAccountAccess).values({ account_id: other, user_id: 902, level: "write" });
    await insertMandate({ accountId: mine, counterparty: "Meins", amount: "-1.00", interval: 30, lastSeen: "2026-09-20" });
    await insertMandate({ accountId: other, counterparty: "Fremd", amount: "-2.00", interval: 30, lastSeen: "2026-09-20" });

    setAuth("901", ["finance.view"]);
    expect((await listUpcomingDebits({})).items.map((i) => i.counterparty)).toEqual(["Meins"]);

    setAuth("903", ["finance.view"]);
    expect((await listUpcomingDebits({})).items).toEqual([]);

    setAuth("1", ["finance.view", "finance.admin"]);
    expect((await listUpcomingDebits({})).items.map((i) => i.counterparty).sort()).toEqual(["Fremd", "Meins"]);
  });

  it("leaves closed accounts out", async () => {
    const closed = await insertAccount("Alt", true);
    await db.insert(financeAccountAccess).values({ account_id: closed, user_id: 901, level: "read" });
    await insertMandate({ accountId: closed, counterparty: "X", amount: "-1.00", interval: 30, lastSeen: "2026-09-20" });
    setAuth("901", ["finance.view"]);
    expect((await listUpcomingDebits({})).items).toEqual([]);
  });

  it("takes an explicit window and rejects a bad one", async () => {
    const giro = await insertAccount("Giro");
    await db.insert(financeAccountAccess).values({ account_id: giro, user_id: 901, level: "read" });
    await insertMandate({ accountId: giro, counterparty: "Stadtwerke Musterstadt", amount: "-84.00", interval: 30, lastSeen: "2026-09-20" });
    setAuth("901", ["finance.view"]);

    const res = await listUpcomingDebits({ from: "2026-10-15", until: "2026-12-31" });
    expect(res.items.map((i) => i.expected_date)).toEqual(["2026-10-20", "2026-11-20", "2026-12-20"]);
    expect(res.total_amount).toBe("-252.00");

    await expect(listUpcomingDebits({ from: "2026-10-31", until: "2026-10-01" })).rejects.toThrow("until");
    await expect(listUpcomingDebits({ from: "15.10.2026" })).rejects.toThrow("YYYY-MM-DD");
    await expect(listUpcomingDebits({ from: "2026-01-01", until: "2027-12-31" })).rejects.toThrow("at most");
  });

  it("needs finance.view", async () => {
    setAuth("901", []);
    await expect(listUpcomingDebits({})).rejects.toThrow();
  });
});
