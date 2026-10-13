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
  financeNewsSeen,
  financeNewsSource,
  financeProviderUsage,
  financeQuoteNews,
  financeQuoteSymbol,
  users,
} from "../db/schema";
import { charge, getPositionNews, markPositionNewsSeen, refreshNews, usedToday } from "./news";
import { unreadNewsCounts } from "./quotes";
import { activePositions } from "./quotes";
import {
  QuoteRateLimitedError,
  setNewsProvider,
  setNewsProviders,
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
  await db.delete(financeNewsSeen);
  await db.delete(financeNewsSource);
  await db.delete(financeProviderUsage);
  await db.delete(financeQuoteSymbol);
  await db.delete(financeAccountHolding);
  await db.delete(financeAccountAccess);
  // Every account goes, so whatever hangs off one goes with it: a file that
  // ran before this one may have left transactions behind, and a plain
  // DELETE would trip over their foreign key.
  await db.execute(sql`TRUNCATE finance_account CASCADE`);
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
  name?: string;
  dailyCalls?: number | null;
  types?: Record<string, SecurityType>;
  items?: (symbol: string, since: Date) => NewsItem[];
  failWith?: Error;
  resolveFailWith?: Error;
  symbolFromKnown?: NewsProvider["symbolFromKnown"];
} = {}): NewsProvider & { calls: { resolve: string[]; news: [string, string][] } } {
  const calls = { resolve: [] as string[], news: [] as [string, string][] };
  return {
    name: opts.name ?? "memnews",
    calls,
    metering: opts.dailyCalls === null ? null : { resolve: 1, news: 5, dailyCalls: opts.dailyCalls ?? 20 },
    symbolFromKnown: opts.symbolFromKnown,
    async resolve(id) {
      calls.resolve.push(id.isin ?? "");
      if (opts.resolveFailWith) throw opts.resolveFailWith;
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

  it("asks every provider in turn, each with its own symbol and last check", async () => {
    const d = await insertDepot();
    await hold(d, A);
    await hold(d, B);
    await quoteType(A, "equity");
    await quoteType(B, "equity");
    // The metered one has room for one security only.
    const metered = memoryNews({ dailyCalls: 6, items: () => [item(1)] });
    // The free one derives its symbol from the metered one's, else from the quote symbol.
    const free = memoryNews({
      name: "freenews",
      dailyCalls: null,
      items: (symbol) => [{ ...item(2), url: `https://frei.test/${symbol}` }, item(1)],
      symbolFromKnown: (known) => {
        const m = known.find((k) => k.provider === "memnews") ?? known.find((k) => k.provider === "yahoo");
        return m ? `frei:${m.symbol}` : null;
      },
    });
    setNewsProviders([metered, free]);

    const stats = await refreshNews(await activePositions([d]), NOW);
    expect(metered.calls.news.map(([s]) => s)).toEqual([`${B}.XETRA`]);
    expect(free.calls.resolve).toEqual([]);
    expect(free.calls.news.map(([s]) => s).sort()).toEqual([`frei:${B}.XETRA`, `frei:${A}.DE`].sort());
    expect(stats).toMatchObject({ candidates: 4, asked: 3, budget_spent: true });

    const rows = await db.select().from(financeNewsSource);
    expect(rows.map((r) => `${r.position_key}:${r.provider}:${r.symbol}`).sort()).toEqual(
      [`${B}:memnews:${B}.XETRA`, `${B}:freenews:frei:${B}.XETRA`, `${A}:freenews:frei:${A}.DE`].sort(),
    );
    // The same article from two providers is stored once per security.
    const stored = await db.select().from(financeQuoteNews).where(eq(financeQuoteNews.position_key, B));
    expect(stored.map((n) => `${n.provider}:${n.url}`).sort()).toEqual(
      ["memnews:https://beispiel.test/1", `freenews:https://frei.test/frei:${B}.XETRA`].sort(),
    );
    expect((await getPositionNews({ key: B })).checked_at).toBe(NOW.toISOString());
  });

  it("goes on with derivable symbols when the search refuses", async () => {
    const d = await insertDepot();
    for (const k of [A, B]) await hold(d, k);
    // A has no quote symbol, B one the free provider can translate.
    await quoteType(B, "equity");
    const free = memoryNews({
      name: "freenews",
      dailyCalls: null,
      resolveFailWith: new QuoteRateLimitedError(),
      symbolFromKnown: (known) => (known[0] ? `frei:${known[0].symbol}` : null),
    });
    setNewsProvider(free);

    const stats = await refreshNews(await activePositions([d]), NOW);
    // A has no symbol anywhere: the search is asked once and refuses; B still gets its news.
    expect(free.calls.resolve).toEqual([A]);
    expect(free.calls.news.map(([s]) => s)).toEqual([`frei:${B}.DE`]);
    expect(stats.rate_limited).toBe(true);
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

describe("news seen and unread", () => {
  it("counts news newer than the last look, or than a week when never looked", async () => {
    await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (1, 'n1@test.local', 'N', 'x')`);
    const d = await insertDepot();
    await hold(d, A);
    await db.insert(financeQuoteNews).values([
      { position_key: A, provider: "memnews", url: "https://beispiel.test/alt", title: "Alt", at: hours(24 * 10) },
      { position_key: A, provider: "memnews", url: "https://beispiel.test/1", title: "Eins", at: hours(5) },
      { position_key: A, provider: "memnews", url: "https://beispiel.test/2", title: "Zwei", at: hours(1) },
    ]);

    // Never looked: the week's two, not the ten-day-old one.
    expect((await unreadNewsCounts(1, [A, B], NOW)).get(A)).toBe(2);
    expect((await getPositionNews({ key: A })).seen_at).toBeNull();

    await markPositionNewsSeen({ key: A });
    const seen = (await getPositionNews({ key: A })).seen_at;
    expect(seen).not.toBeNull();
    expect((await unreadNewsCounts(1, [A], new Date())).get(A)).toBeUndefined();

    // A newer item counts again; another user's look does not count for this one.
    await db.insert(financeQuoteNews).values({
      position_key: A,
      provider: "memnews",
      url: "https://beispiel.test/3",
      title: "Drei",
      at: new Date(Date.parse(seen!) + 60_000).toISOString(),
    });
    expect((await unreadNewsCounts(1, [A], new Date())).get(A)).toBe(1);
    expect(await unreadNewsCounts(null, [A], new Date())).toEqual(new Map());

    await expect(markPositionNewsSeen({ key: B })).rejects.toThrow(/not found/);
  });
});
