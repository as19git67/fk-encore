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
  isRegular,
  isSuperseded,
  listUpcomingDebits,
  seriesProfile,
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
  it("a series that missed two cycles has ended", () => {
    expect(isEnded("2026-06-01", 30, "2026-10-15")).toBe(true);
    // One missed booking is late, not gone.
    expect(isEnded("2026-08-20", 30, "2026-10-15")).toBe(false);
    expect(isEnded("2026-08-01", 30, "2026-10-15")).toBe(true);
    expect(isEnded("2025-12-05", 365, "2026-10-15")).toBe(false);
    // Yearly, silent for two years and a bit.
    expect(isEnded("2024-09-01", 365, "2026-10-15")).toBe(true);
  });
});

describe("seriesProfile and isRegular", () => {
  it("a monthly instalment with small jitter is regular, at its latest level", () => {
    const profile = seriesProfile([
      { date: "2026-09-02", amount: -84 }, { date: "2026-08-01", amount: -84 }, { date: "2026-07-01", amount: -79 },
      { date: "2026-06-02", amount: -79 }, { date: "2026-05-01", amount: -79 }, { date: "2026-04-01", amount: -79 },
    ])!;
    expect(profile).toMatchObject({ intervalDays: 31, amountCents: -8400, count: 6 });
    expect(profile.intervalCv).toBeLessThan(0.1);
    expect(isRegular(profile)).toBe(true);
  });

  it("a shop visited whenever, for whatever, is not a series", () => {
    const profile = seriesProfile([
      { date: "2026-09-28", amount: -12.99 }, { date: "2026-09-25", amount: -149 }, { date: "2026-08-02", amount: -8.5 },
      { date: "2026-06-14", amount: -63.2 }, { date: "2026-06-10", amount: -22 }, { date: "2026-02-01", amount: -310 },
    ])!;
    expect(profile.intervalCv).toBeGreaterThan(0.3);
    expect(profile.amountCv).toBeGreaterThan(0.35);
    expect(isRegular(profile)).toBe(false);
  });

  it("regular dates with erratic amounts are not a series either", () => {
    const profile = seriesProfile([
      { date: "2026-09-01", amount: -5 }, { date: "2026-08-01", amount: -120 }, { date: "2026-07-01", amount: -40 },
      { date: "2026-06-01", amount: -9 }, { date: "2026-05-01", amount: -250 },
    ])!;
    expect(profile.intervalCv).toBeLessThan(0.1);
    expect(isRegular(profile)).toBe(false);
  });

  it("a split booking on one day is one payment; too few bookings say nothing", () => {
    const profile = seriesProfile([
      { date: "2026-09-01", amount: -30 }, { date: "2026-09-01", amount: -54 },
      { date: "2026-08-01", amount: -84 }, { date: "2026-07-01", amount: -84 },
    ])!;
    expect(profile).toMatchObject({ intervalDays: 31, amountCents: -8400, count: 3 });
    expect(seriesProfile([{ date: "2026-09-01", amount: -1 }, { date: "2026-08-01", amount: -1 }])).toBeNull();
  });
});

describe("isSuperseded", () => {
  const old = { id: 1, counterparty: "Beispiel Versicherung AG", typical_amount: "-412.00", typical_interval_days: 365, first_seen: "2021-11-10", last_seen: "2024-11-10" };
  it("a series that went on under a new mandate after it fell silent is superseded", () => {
    const successor = { id: 2, counterparty: "Beispiel Versicherung", typical_amount: "-425.00", typical_interval_days: 365, first_seen: "2025-11-12", last_seen: "2025-11-12" };
    expect(isSuperseded(old, [old, successor])).toBe(true);
    // The successor itself is not.
    expect(isSuperseded(successor, [old, successor])).toBe(false);
  });
  it("a parallel contract, another creditor or another amount is no successor", () => {
    const parallel = { ...old, id: 3, first_seen: "2023-01-05", last_seen: "2025-11-05" };
    const otherCreditor = { ...old, id: 4, counterparty: "Muster Energie GmbH", first_seen: "2025-11-12", last_seen: "2025-11-12" };
    const otherAmount = { ...old, id: 5, typical_amount: "-90.00", first_seen: "2025-11-12", last_seen: "2025-11-12" };
    expect(isSuperseded(old, [old, parallel, otherCreditor, otherAmount])).toBe(false);
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

async function insertAccount(label: string, closed = false, kind?: string): Promise<number> {
  const types = await db.select({ id: financeAccountType.id, kind: financeAccountType.kind }).from(financeAccountType);
  const type = kind ? types.find((t) => t.kind === kind)! : types.find((t) => t.kind !== "bargeld")!;
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

/** Bookings matched to a mandate by its reference, as the detector matches them. */
async function insertBookings(accountId: number, counterparty: string, bookings: Array<[string, string]>): Promise<void> {
  await db.insert(financeTransaction).values(bookings.map(([date, amount], i) => ({
    account_id: accountId,
    booking_date: date,
    amount,
    currency_code: "EUR",
    counterparty,
    mandate_ref: `REF-${counterparty}`,
    dedupe_hash: `${counterparty}-${date}-${i}`,
  })));
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

  it("narrows to direct debits or transfers, and never counts a cash account", async () => {
    const giro = await insertAccount("Giro");
    const wallet = await insertAccount("Portemonnaie", false, "bargeld");
    await db.insert(financeAccountAccess).values({ account_id: giro, user_id: 901, level: "read" });
    await db.insert(financeAccountAccess).values({ account_id: wallet, user_id: 901, level: "read" });
    await insertMandate({ accountId: giro, counterparty: "Stadtwerke Musterstadt", amount: "-84.00", interval: 30, lastSeen: "2026-09-20" });
    await insertMandate({ accountId: giro, counterparty: "Miete Beispiel GmbH", amount: "-650.00", interval: 30, lastSeen: "2026-09-28", channel: "transfer" });
    await insertMandate({ accountId: giro, counterparty: "Unbekannt", amount: "-5.00", interval: 30, lastSeen: "2026-09-22", channel: null });
    await insertMandate({ accountId: wallet, counterparty: "Markt", amount: "-20.00", interval: 7, lastSeen: "2026-10-12", channel: null });
    setAuth("901", ["finance.view"]);

    const all = await listUpcomingDebits({});
    expect(all.items.map((i) => i.counterparty)).toEqual(["Stadtwerke Musterstadt", "Unbekannt", "Miete Beispiel GmbH"]);
    expect((await listUpcomingDebits({ channel: "direct_debit" })).items.map((i) => i.counterparty)).toEqual(["Stadtwerke Musterstadt"]);
    expect((await listUpcomingDebits({ channel: "transfer" })).items.map((i) => i.counterparty)).toEqual(["Miete Beispiel GmbH"]);
    await expect(listUpcomingDebits({ channel: "cash" as never })).rejects.toThrow("channel");
  });

  it("judges a series by its bookings: a shop visited whenever is not expected, an instalment is", async () => {
    const giro = await insertAccount("Giro");
    await db.insert(financeAccountAccess).values({ account_id: giro, user_id: 901, level: "read" });
    // The detector's running average made 30 days of it; the bookings say otherwise.
    await insertMandate({ accountId: giro, counterparty: "Beispiel Versand", amount: "-45.00", interval: 30, lastSeen: "2026-09-28" });
    await insertBookings(giro, "Beispiel Versand", [
      ["2026-09-28", "-12.99"], ["2026-09-25", "-149.00"], ["2026-08-02", "-8.50"],
      ["2026-06-14", "-63.20"], ["2026-06-10", "-22.00"], ["2026-02-01", "-310.00"],
    ]);
    // The running average drifted to 33 days and 90 €; the bookings say the 1st and 84 €.
    await insertMandate({ accountId: giro, counterparty: "Stadtwerke Musterstadt", amount: "-90.00", interval: 33, lastSeen: "2026-10-01" });
    await insertBookings(giro, "Stadtwerke Musterstadt", [
      ["2026-10-01", "-84.00"], ["2026-09-01", "-84.00"], ["2026-08-03", "-84.00"],
      ["2026-07-01", "-79.00"], ["2026-06-01", "-79.00"], ["2026-05-02", "-79.00"],
    ]);

    setAuth("901", ["finance.view"]);
    const res = await listUpcomingDebits({ from: "2026-10-15", until: "2026-11-30" });
    expect(res.items.map((i) => [i.counterparty, i.expected_date, i.typical_amount, i.interval_days])).toEqual([
      ["Stadtwerke Musterstadt", "2026-11-01", "-84.00", 30],
    ]);
  });

  it("lists a series that moved to another account once, under its new mandate", async () => {
    const alt = await insertAccount("Altes Giro");
    const neu = await insertAccount("Neues Giro");
    await db.insert(financeAccountAccess).values({ account_id: alt, user_id: 901, level: "read" });
    await db.insert(financeAccountAccess).values({ account_id: neu, user_id: 901, level: "read" });
    // Yearly premium, last paid from the old account two years ago — silent,
    // but not for two full cycles yet.
    const oldId = await insertMandate({ accountId: alt, counterparty: "Beispiel Versicherung AG", amount: "-412.00", interval: 365, lastSeen: "2024-11-10" });
    await db.update(financeRecurringMandate).set({ first_seen: "2021-11-10" }).where(sql`id = ${oldId}`);
    // Since then from the new account; the bank issued a new mandate.
    const newId = await insertMandate({ accountId: neu, counterparty: "Beispiel Versicherung", amount: "-425.00", interval: 365, lastSeen: "2025-11-12", count: 3 });
    await db.update(financeRecurringMandate).set({ first_seen: "2025-11-12" }).where(sql`id = ${newId}`);

    setAuth("901", ["finance.view"]);
    const res = await listUpcomingDebits({ from: "2026-10-15", until: "2026-11-30" });
    expect(res.items.map((i) => [i.counterparty, i.account_label, i.expected_date])).toEqual([
      ["Beispiel Versicherung", "Neues Giro", "2026-11-12"],
    ]);
  });

  it("needs finance.view", async () => {
    setAuth("901", []);
    await expect(listUpcomingDebits({})).rejects.toThrow();
  });
});
