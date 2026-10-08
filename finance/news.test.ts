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
  financeNewsSource,
  financeProviderUsage,
  financeQuoteNews,
  financeQuoteSymbol,
  users,
} from "../db/schema";
import { charge, getPositionNews, refreshNews, usedToday } from "./news";
import { activePositions } from "./quotes";
import {
  QuoteRateLimitedError,
  setNewsProvider,
  type NewsItem,
  type NewsProvider,
  type SecurityType,
} from "./quote-provider";

// Invented securities throughout.
const A = "XF00SONNE005";
const B = "XF00MONDE003";
const C = "XF00STERN009";
const NOW = new Date("2026-02-04T10:00:00Z");
const hours = (n: number) => new Date(NOW.getTime() - n * 60 * 60_000).toISOString();

function setAuth(userID: string, perms: string[]) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions: perms });
}

beforeEach(async () => {
  await db.delete(financeQuoteNews);
  await db.delete(financeNewsSource);
  await db.delete(financeProviderUsage);
  await db.delete(financeQuoteSymbol);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountAccess);
  await db.delete(financeAccount);
  await db.delete(financeBankcontact);
  await db.delete(users);
  setAuth("1", ["finance.view", "finance.admin"]);
});

afterEach(() => setNewsProvider(null));

async function insertDepot(): Promise<number> {
  const [bc] = await db
    .insert(financeBankcontact)
    .values({ name: "Test", blz: "1", login: "u", server_url: "https://x" })
    .returning({ id: financeBankcontact.id });
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).where(eq(financeAccountType.kind, "depot")).limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({ bankcontact_id: bc!.id, type_id: type!.id, currency_code: "EUR", account_number: "D", label: "Depot" })
    .returning({ id: financeAccount.id });
  return row!.id;
}

async function hold(accountId: number, isin: string) {
  await db.insert(financeAccountHolding).values({ account_id: accountId, as_of: "2026-02-03", isin, name: "Beispiel", amount: "1", price: "10", value: "10", currency: "EUR" });
}

async function quoteType(key: string, type: SecurityType | null) {
  await db.insert(financeQuoteSymbol).values({ position_key: key, provider: "yahoo", symbol: `${key}.DE`, security_type: type });
}

function item(n: number, at = hours(n)): NewsItem {
  return { url: `https://beispiel.test/${n}`, title: `Meldung ${n}`, source: "beispiel.test", at, summary: null, sentiment: 0.1 * n };
}

/** A metered provider that answers from memory and counts what it was asked. */
function memoryNews(opts: {
  dailyCalls?: number | null;
  types?: Record<string, SecurityType>;
  items?: (symbol: string, since: Date) => NewsItem[];
  failWith?: Error;
} = {}): NewsProvider & { calls: { resolve: string[]; news: [string, string][] } } {
  const calls = { resolve: [] as string[], news: [] as [string, string][] };
  return {
    name: "memnews",
    calls,
    metering: opts.dailyCalls === null ? null : { resolve: 1, news: 5, dailyCalls: opts.dailyCalls ?? 20 },
    async resolve(id) {
      calls.resolve.push(id.isin ?? "");
      return { symbol: `${id.isin}.XETRA`, name: null, exchange: "XETRA", currency: "EUR", securityType: opts.types?.[id.isin ?? ""] ?? "equity" };
    },
    async news(symbol, since) {
      calls.news.push([symbol, since.toISOString()]);
      if (opts.failWith) throw opts.failWith;
      return opts.items?.(symbol, since) ?? [item(1), item(2)];
    },
  };
}

describe("charge", () => {
  it("spends the allowance and refuses what no longer fits", async () => {
    expect(await charge("p", 5, 12, NOW)).toBe(true);
    expect(await charge("p", 5, 12, NOW)).toBe(true);
    expect(await charge("p", 5, 12, NOW)).toBe(false);
    expect(await charge("p", 2, 12, NOW)).toBe(true);
    expect(await usedToday("p", NOW)).toBe(12);
    // A new day, a new allowance; a cost above it never fits.
    expect(await charge("p", 5, 12, new Date("2026-02-05T00:30:00Z"))).toBe(true);
    expect(await charge("q", 13, 12, NOW)).toBe(false);
  });
});

describe("refreshNews", () => {
  it("asks for equities only, resolves once, stores the items and keeps to the budget", async () => {
    const d = await insertDepot();
    for (const k of [A, B, C]) await hold(d, k);
    await quoteType(A, "equity");
    await quoteType(B, "fund");
    await quoteType(C, null);
    // C's type is unknown to the quotes; the news provider says ETF.
    const provider = memoryNews({ types: { [C]: "etf" } });
    setNewsProvider(provider);

    const stats = await refreshNews(await activePositions([d]), NOW);
    expect(stats).toMatchObject({ candidates: 2, asked: 1, resolved: 1, skipped_not_equity: 1, items: 2, budget_spent: false });
    expect(provider.calls.resolve.sort()).toEqual([A, C].sort());
    expect(provider.calls.news.map(([s]) => s)).toEqual([`${A}.XETRA`]);
    // The first fetch reaches back 30 days.
    expect(provider.calls.news[0]![1]).toBe(new Date(NOW.getTime() - 30 * 24 * 60 * 60_000).toISOString());
    // Two resolves at 1, one news request at 5.
    expect(await usedToday("memnews", NOW)).toBe(7);

    const stored = await db.select().from(financeQuoteNews);
    expect(stored.map((n) => n.title).sort()).toEqual(["Meldung 1", "Meldung 2"]);
    const [cSource] = await db.select().from(financeNewsSource).where(eq(financeNewsSource.position_key, C));
    expect(cSource).toMatchObject({ symbol: null });
  });

  it("stops when the day's budget is spent and goes on with the longest unasked tomorrow", async () => {
    const d = await insertDepot();
    for (const k of [A, B, C]) await hold(d, k);
    for (const k of [A, B, C]) await quoteType(k, "equity");
    // B was asked long ago, A recently, C never.
    await db.insert(financeNewsSource).values([
      { position_key: A, provider: "memnews", symbol: `${A}.XETRA`, resolved_at: hours(100), checked_at: hours(30) },
      { position_key: B, provider: "memnews", symbol: `${B}.XETRA`, resolved_at: hours(100), checked_at: hours(90) },
    ]);
    // Room for one resolve and one news request.
    const provider = memoryNews({ dailyCalls: 6 });
    setNewsProvider(provider);

    const stats = await refreshNews(await activePositions([d]), NOW);
    // C first (never asked): resolve 1 + news 5 = 6; then nothing fits.
    expect(provider.calls.news.map(([s]) => s)).toEqual([`${C}.XETRA`]);
    expect(stats.budget_spent).toBe(true);

    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60_000);
    await refreshNews(await activePositions([d]), tomorrow);
    expect(provider.calls.news.map(([s]) => s)[1]).toBe(`${B}.XETRA`);
  });

  it("asks a security at most once in twenty hours and from an hour before the last check", async () => {
    const d = await insertDepot();
    await hold(d, A);
    await quoteType(A, "equity");
    await db.insert(financeNewsSource).values({ position_key: A, provider: "memnews", symbol: `${A}.XETRA`, resolved_at: hours(100), checked_at: hours(5) });
    const provider = memoryNews({ dailyCalls: null });
    setNewsProvider(provider);

    expect((await refreshNews(await activePositions([d]), NOW)).candidates).toBe(0);

    const later = new Date(NOW.getTime() + 16 * 60 * 60_000);
    await refreshNews(await activePositions([d]), later);
    expect(provider.calls.news).toEqual([[`${A}.XETRA`, hours(6)]]);
  });

  it("does not store an item twice, ends on a refusal, and keeps 90 days", async () => {
    const d = await insertDepot();
    await hold(d, A);
    await hold(d, B);
    await quoteType(A, "equity");
    await quoteType(B, "equity");
    await db.insert(financeQuoteNews).values({ position_key: A, provider: "memnews", url: "https://beispiel.test/alt", title: "Alt", at: hours(24 * 91) });
    setNewsProvider(memoryNews({ dailyCalls: null, items: () => [item(1), item(1)] }));
    await refreshNews(await activePositions([d]), NOW);
    const rows = await db.select({ title: financeQuoteNews.title, key: financeQuoteNews.position_key }).from(financeQuoteNews);
    expect(rows.map((r) => `${r.key}:${r.title}`).sort()).toEqual([`${A}:Meldung 1`, `${B}:Meldung 1`].sort());

    await db.delete(financeNewsSource);
    const refusing = memoryNews({ dailyCalls: null, failWith: new QuoteRateLimitedError() });
    setNewsProvider(refusing);
    const stats = await refreshNews(await activePositions([d]), NOW);
    expect(stats.rate_limited).toBe(true);
    expect(refusing.calls.news).toHaveLength(1);
  });

  it("does nothing without a news provider", async () => {
    const d = await insertDepot();
    await hold(d, A);
    expect(await refreshNews(await activePositions([d]), NOW)).toMatchObject({ candidates: 0, asked: 0 });
  });
});

describe("getPositionNews", () => {
  it("lists a held security's news, newest first, and hides other people's", async () => {
    const d = await insertDepot();
    await hold(d, A);
    await db.insert(financeQuoteNews).values([
      { position_key: A, provider: "memnews", url: "https://beispiel.test/1", title: "Eins", at: hours(5), sentiment: -0.5 },
      { position_key: A, provider: "memnews", url: "https://beispiel.test/2", title: "Zwei", at: hours(1) },
    ]);

    const resp = await getPositionNews({ key: A, limit: 10 });
    expect(resp.items.map((n) => n.title)).toEqual(["Zwei", "Eins"]);
    expect(resp.items[1]).toMatchObject({ sentiment: -0.5, at: hours(5) });
    expect(resp.checked_at).toBeNull();

    await expect(getPositionNews({ key: B })).rejects.toThrow(/not found/);

    await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (9, 'n9@test.local', 'N', 'x')`);
    setAuth("9", ["finance.view"]);
    await expect(getPositionNews({ key: A })).rejects.toThrow(/not found/);
  });
});
