import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountHolding,
  financeAccountType,
  financeBankcontact,
  financeQuote,
  financeQuoteSymbol,
  users,
} from "../db/schema";
import { activePositions, buildQuoteTiles, getQuotes, rangeWindow, refreshQuotes, thin } from "./quotes";
import {
  QuoteRateLimitedError,
  setQuoteProvider,
  type HistoryRange,
  type QuoteProvider,
  type QuoteSeries,
} from "./quote-provider";

// Invented securities throughout.
const ISIN_A = "XF00SONNE005";
const ISIN_B = "XF00MONDE003";
const NOW = new Date("2026-02-04T10:00:00Z");

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

beforeEach(async () => {
  await db.delete(financeQuote);
  await db.delete(financeQuoteSymbol);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", ["finance.view", "finance.admin"]);
});

afterEach(() => setQuoteProvider(null));

async function insertDepot(label = "Depot"): Promise<number> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "depot")).limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({ bankcontact_id: bc!.id, type_id: type!.id, currency_code: "EUR", account_number: label, label })
    .returning({ id: financeAccount.id });
  return row!.id;
}

async function insertHolding(accountId: number, asOf: string, isin: string | null, amount: string, wkn: string | null = null, name = "Beispiel") {
  await db.insert(financeAccountHolding).values({
    account_id: accountId,
    as_of: asOf,
    isin,
    wkn,
    name,
    amount,
    price: "10",
    value: "100",
    currency: "EUR",
  });
}

/** A provider that answers from memory and counts what it was asked. */
function memoryProvider(opts: {
  symbols?: Record<string, string>;
  series?: (symbol: string, range: HistoryRange) => QuoteSeries;
  failWith?: Error;
} = {}): QuoteProvider & { calls: { resolve: string[]; history: [string, HistoryRange][] } } {
  const calls = { resolve: [] as string[], history: [] as [string, HistoryRange][] };
  return {
    name: "memory",
    calls,
    async resolve(id) {
      calls.resolve.push(id.isin ?? id.wkn ?? "");
      const symbol = opts.symbols?.[id.isin ?? id.wkn ?? ""];
      return symbol ? { symbol, name: `Name of ${symbol}`, exchange: "GER", currency: "EUR" } : null;
    },
    async history(symbol, range) {
      calls.history.push([symbol, range]);
      if (opts.failWith) throw opts.failWith;
      return opts.series?.(symbol, range) ?? { symbol, currency: "EUR", points: [] };
    },
  };
}

const hours = (n: number) => new Date(NOW.getTime() - n * 60 * 60_000).toISOString();
const day = (n: number) => hours(n * 24);
const minute = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

// Closes up to twelve hours ago (today's running bar), minutes up to now.
function seriesOf(symbol: string, range: HistoryRange): QuoteSeries {
  const points =
    range === "intraday"
      ? [{ at: minute(10), price: 10.5 }, { at: minute(5), price: 10.6 }, { at: minute(0), price: 10.8 }]
      : range === "recent_days"
        ? [{ at: day(2), price: 10.2 }, { at: hours(12), price: 10.4 }]
        : [{ at: day(400), price: 8 }, { at: day(30), price: 9 }, { at: day(2), price: 10.2 }, { at: hours(12), price: 10.4 }];
  return { symbol, currency: "EUR", points };
}

describe("activePositions", () => {
  it("lists each held security once, from the latest snapshot of each depot", async () => {
    const d1 = await insertDepot("D1");
    const d2 = await insertDepot("D2");
    await insertHolding(d1, "2026-02-01", ISIN_A, "5");
    await insertHolding(d1, "2026-02-03", ISIN_A, "6");
    await insertHolding(d1, "2026-02-03", ISIN_B, "0");
    await insertHolding(d2, "2026-02-03", ISIN_A, "4");
    await insertHolding(d2, "2026-02-03", null, "3", "SNN001", "Nur WKN");
    await insertHolding(d2, "2026-02-03", null, "3", null, "Ohne Kennung");

    const positions = await activePositions([d1, d2]);
    expect(positions.map((p) => [p.key, p.amount]).sort()).toEqual([
      ["SNN001", 3],
      [ISIN_A, 10],
    ]);
  });
});

describe("refreshQuotes", () => {
  it("resolves once, backfills once, and fetches the day on every run", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "5");
    const provider = memoryProvider({ symbols: { [ISIN_A]: "SNN.DE" }, series: seriesOf });
    setQuoteProvider(provider);
    const positions = await activePositions([d]);

    const first = await refreshQuotes(positions, NOW);
    expect(first).toMatchObject({ positions: 1, resolved: 1, unresolved: 0, fetched: 2, points: 7, rate_limited: false, errors: [] });
    expect(provider.calls.resolve).toEqual([ISIN_A]);
    expect(provider.calls.history).toEqual([["SNN.DE", "backfill"], ["SNN.DE", "intraday"]]);

    const [sym] = await db.select().from(financeQuoteSymbol);
    expect(sym).toMatchObject({ position_key: ISIN_A, symbol: "SNN.DE", provider: "memory", name: "Name of SNN.DE" });
    expect(sym!.backfilled_at).not.toBeNull();

    // Same minute again: nothing new is stored, the closes are fresh.
    const second = await refreshQuotes(positions, NOW);
    expect(second).toMatchObject({ fetched: 1, points: 0 });
    expect(provider.calls.resolve).toHaveLength(1);
    expect(provider.calls.history[2]).toEqual(["SNN.DE", "intraday"]);

    const rows = await db.select().from(financeQuote);
    expect(rows.filter((r) => r.kind === "daily")).toHaveLength(4);
    expect(rows.filter((r) => r.kind === "intraday")).toHaveLength(3);
  });

  it("writes a day's bar over when fetched again, and refreshes the closes once the newest is a day old", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "5");
    const provider = memoryProvider({ symbols: { [ISIN_A]: "SNN.DE" }, series: seriesOf });
    setQuoteProvider(provider);
    const positions = await activePositions([d]);
    await refreshQuotes(positions, NOW);

    const later = new Date(NOW.getTime() + 2 * 24 * 60 * 60_000);
    setQuoteProvider(
      memoryProvider({
        symbols: { [ISIN_A]: "SNN.DE" },
        series: (symbol, range) => ({ symbol, currency: "EUR", points: range === "recent_days" ? [{ at: hours(12), price: 10.9 }] : [] }),
      }),
    );
    const stats = await refreshQuotes(positions, later);
    expect(stats.fetched).toBe(2);
    const [bar] = await db.select({ price: financeQuote.price }).from(financeQuote).where(eq(financeQuote.at, hours(12)));
    expect(bar!.price).toBe("10.900000");
  });

  it("records a security the provider does not know and asks again after a day, or at once by hand", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_B, "5");
    const provider = memoryProvider({});
    setQuoteProvider(provider);
    const positions = await activePositions([d]);

    const stats = await refreshQuotes(positions, NOW);
    expect(stats).toMatchObject({ resolved: 0, unresolved: 1, fetched: 0 });
    const [sym] = await db.select().from(financeQuoteSymbol);
    expect(sym).toMatchObject({ symbol: null, failure: "no symbol found" });

    await refreshQuotes(positions, new Date(NOW.getTime() + 12 * 60 * 60_000));
    expect(provider.calls.resolve).toHaveLength(1);
    await refreshQuotes(positions, new Date(NOW.getTime() + 25 * 60 * 60_000));
    expect(provider.calls.resolve).toHaveLength(2);
    // Asked by hand: at once.
    await refreshQuotes(positions, new Date(NOW.getTime() + 26 * 60 * 60_000), { retryUnresolved: true });
    expect(provider.calls.resolve).toHaveLength(3);
  });

  it("ends the run on a rate limit and keeps the other errors per position", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "5");
    await insertHolding(d, "2026-02-03", ISIN_B, "5");
    const limited = memoryProvider({ symbols: { [ISIN_A]: "A.DE", [ISIN_B]: "B.DE" }, failWith: new QuoteRateLimitedError() });
    setQuoteProvider(limited);
    const positions = await activePositions([d]);
    const stats = await refreshQuotes(positions, NOW);
    expect(stats.rate_limited).toBe(true);
    expect(limited.calls.history).toHaveLength(1);

    const broken = memoryProvider({ symbols: { [ISIN_A]: "A.DE", [ISIN_B]: "B.DE" }, failWith: new Error("boom") });
    setQuoteProvider(broken);
    const again = await refreshQuotes(positions, NOW);
    expect(again.rate_limited).toBe(false);
    expect(again.errors).toHaveLength(2);
    expect(broken.calls.history).toHaveLength(2);
  });

  it("asks a new provider afresh and drops the old backfill mark", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "5");
    await db.insert(financeQuoteSymbol).values({
      position_key: ISIN_A,
      provider: "other",
      symbol: "OLD",
      resolved_at: NOW.toISOString(),
      backfilled_at: NOW.toISOString(),
    });
    const provider = memoryProvider({ symbols: { [ISIN_A]: "SNN.DE" }, series: seriesOf });
    setQuoteProvider(provider);
    await refreshQuotes(await activePositions([d]), NOW);
    expect(provider.calls.history[0]).toEqual(["SNN.DE", "backfill"]);
    const [sym] = await db.select().from(financeQuoteSymbol);
    expect(sym).toMatchObject({ provider: "memory", symbol: "SNN.DE" });
  });

  it("prunes the day's minutes after a month, never the closes", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "5");
    await db.insert(financeQuoteSymbol).values({ position_key: ISIN_A, provider: "memory", symbol: "SNN.DE", backfilled_at: NOW.toISOString() });
    await db.insert(financeQuote).values([
      { position_key: ISIN_A, at: day(40), price: "9", kind: "intraday", source: "memory" },
      { position_key: ISIN_A, at: day(40), price: "9", kind: "daily", source: "memory" },
      { position_key: ISIN_A, at: day(1), price: "10", kind: "intraday", source: "memory" },
    ]);
    setQuoteProvider(memoryProvider({ symbols: { [ISIN_A]: "SNN.DE" } }));
    await refreshQuotes(await activePositions([d]), NOW);
    const rows = await db.select({ kind: financeQuote.kind, at: financeQuote.at }).from(financeQuote);
    expect(rows.map((r) => r.kind).sort()).toEqual(["daily", "intraday"]);
  });
});

describe("rangeWindow and thin", () => {
  it("draws a day and a week from the minutes, longer ranges from the closes", () => {
    expect(rangeWindow("1d", NOW)).toEqual({ from: day(1), kind: "intraday" });
    expect(rangeWindow("1w", NOW).kind).toBe("intraday");
    expect(rangeWindow("1m", NOW).kind).toBe("daily");
    expect(rangeWindow("max", NOW)).toEqual({ from: null, kind: "daily" });
  });

  it("thins a long series and keeps its last point", () => {
    const points = Array.from({ length: 1000 }, (_, i) => i);
    const out = thin(points, 300);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    expect(thin([1, 2, 3], 300)).toEqual([1, 2, 3]);
  });
});

describe("buildQuoteTiles and getQuotes", () => {
  it("gives each held security its last price, value and change over the range", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "10");
    await insertHolding(d, "2026-02-03", ISIN_B, "2");
    setQuoteProvider(memoryProvider({ symbols: { [ISIN_A]: "SNN.DE" }, series: seriesOf }));
    await refreshQuotes(await activePositions([d]), NOW);

    const tiles = await buildQuoteTiles([d], "1d", NOW);
    expect(tiles.map((t) => t.key)).toEqual([ISIN_A, ISIN_B]);
    const a = tiles[0]!;
    expect(a).toMatchObject({
      name: "Name of SNN.DE",
      amount: "10.00000000",
      currency: "EUR",
      status: "ok",
      last: { at: minute(0), price: "10.800000" },
      value: "108.00",
      change: { absolute: "0.30", percent: "2.86" },
    });
    expect(a.points.map((p) => p.price)).toEqual(["10.500000", "10.600000", "10.800000"]);

    const b = tiles[1]!;
    expect(b).toMatchObject({ status: "unresolved", last: null, value: null, change: null, points: [] });

    // A year's range: closes, change against the oldest in the window.
    const year = await buildQuoteTiles([d], "1y", NOW);
    // The closes, then the newest price finishing the line.
    expect(year[0]!.points.map((p) => p.price)).toEqual(["9.000000", "10.200000", "10.400000", "10.800000"]);
    expect(year[0]!.change).toEqual({ absolute: "1.80", percent: "20.00" });
    expect(year[0]!.last!.price).toBe("10.800000");
  });

  it("serves the caller's depots and refuses an unknown range", async () => {
    const d = await insertDepot();
    await insertHolding(d, "2026-02-03", ISIN_A, "1");
    await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (7, 'q7@test.local', 'Q', 'x')`);
    await db.insert(financeAccountAccess).values({ account_id: d, user_id: 7, level: "read" });
    setAuth("7", ["finance.view"]);

    const resp = await getQuotes({ range: "1m" });
    expect(resp.range).toBe("1m");
    expect(resp.tiles.map((t) => t.status)).toEqual(["pending"]);
    expect(resp.as_of).toBeNull();

    await expect(getQuotes({ range: "2h" })).rejects.toThrow(/range/);
  });
});
