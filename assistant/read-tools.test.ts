/**
 * The read tools that answer "meine Konten" and "meine freigegebenen Alben":
 * accounts come from the Übersicht page with their balances, a booking list
 * for one account carries the account and its balance, and shared albums
 * name who they are shared with. Services are mocked; data is synthetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import { clients, resetClients } from "./clients.test-helper";
import { HAND_TOOLS } from "./catalog";
import type { ToolContext } from "./types";

const PERMS = ["module.finance", "finance.view", "module.photos", "photos.view", "module.documents", "documents.view", "module.assistant"];
const ctx = (userID = "711"): ToolContext => ({ user: { userID, permissions: PERMS }, today: "2026-10-15" });

function tool(name: string) {
  const t = HAND_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const GIRO = { id: 1, label: "Girokonto", type_kind: "giro", type_label: "Girokonto", currency_code: "EUR", balance: "1234.56", balance_as_of: "2026-10-14T06:00:00Z" };
const CASH = { id: 3, label: "Portemonnaie", type_kind: "bargeld", type_label: "Bargeld", currency_code: "EUR", balance: null, balance_as_of: null };
const DEPOT = { id: 2, label: "Depot", type_kind: "depot", type_label: "Depot", currency_code: "EUR", balance: "9800.00", balance_as_of: "2026-10-01T06:00:00Z" };

beforeEach(() => resetClients());

describe("list_accounts", () => {
  it("lists the accounts of the Übersicht page in its sections, with balances, and says why a cash account has none", async () => {
    clients.finance.getOverview.mockResolvedValue({
      sections: [{ name: "Täglich", accounts: [GIRO, CASH] }, { name: "Sparen", accounts: [DEPOT] }],
      unassigned: [{ ...GIRO, id: 9, label: "Altes Konto", balance: null }],
    });
    const out = await tool("list_accounts").run({}, ctx());
    expect(clients.finance.listAccounts).not.toHaveBeenCalled();
    expect(out.text).toContain("1 | Täglich | Girokonto | Girokonto | 1234.56 EUR (as of 2026-10-14)");
    expect(out.text).toContain("3 | Täglich | Portemonnaie | Bargeld | none (cash account)");
    expect(out.text).toContain("9 | (not on the Übersicht page) | Altes Konto");
    expect(out.text).toContain("latest statement balance");
    expect(out.block).toMatchObject({ kind: "accounts", route: "/finanzen/uebersicht" });
    expect(out.block?.rows.map((r) => [r.id, r.section, r.balance])).toEqual([[1, "Täglich", "1234.56"], [3, "Täglich", null], [2, "Sparen", "9800.00"], [9, null, null]]);
  });
});

describe("list_transactions", () => {
  it("heads a list for one account with the account and its balance", async () => {
    clients.finance.getOverview.mockResolvedValue({ sections: [{ name: "Täglich", accounts: [GIRO] }], unassigned: [] });
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 5, account_id: 1, booking_date: "2026-10-10", amount: "-12.00", counterparty: "Beispiel Markt", purpose: "Einkauf" }], total: 1 });
    const out = await tool("list_transactions").run({ account_id: 1, limit: 10 }, ctx());
    expect(out.block?.subtitle).toBe("Girokonto · Saldo 1234.56 EUR");
    expect(out.text).toContain("Account: Girokonto, balance 1234.56 EUR (as of 2026-10-14).");
  });

  it("has no heading without an account, and never asks the overview then", async () => {
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    const out = await tool("list_transactions").run({ q: "Miete" }, ctx());
    expect(out.block?.subtitle).toBeUndefined();
    expect(clients.finance.getOverview).not.toHaveBeenCalled();
  });
});

const ALBUMS = [
  { id: 1, user_id: 711, name: "Gardasee 2025", event_name: "Sommerurlaub", oldest_photo_at: "2025-08-02", newest_photo_at: "2025-08-16", photo_count: 40, is_shared: true },
  { id: 2, user_id: 711, name: "Küche", event_name: null, oldest_photo_at: "2025-01-01", newest_photo_at: "2025-01-01", photo_count: 3, is_shared: false },
  { id: 3, user_id: 712, name: "Geburtstag", event_name: "Feier", oldest_photo_at: "2025-03-03", newest_photo_at: "2025-03-03", photo_count: 12, is_shared: true },
];

describe("list_albums", () => {
  it("filters to shared albums and says who owns them", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: ALBUMS });
    const out = await tool("list_albums").run({ shared: true }, ctx());
    expect(out.rowCount).toBe(2);
    expect(out.text).toContain("1 | Gardasee 2025 | Sommerurlaub | 2025-08-02 | 2025-08-16 | 40 | yes | me");
    expect(out.text).toContain("3 | Geburtstag | Feier | 2025-03-03 | 2025-03-03 | 12 | yes | another user");
    expect(out.block?.rows.map((r) => r.shared)).toEqual([true, true]);
  });

  it("caps the rows at the limit and reports the total", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: ALBUMS });
    const out = await tool("list_albums").run({ limit: 1 }, ctx());
    expect(out.text).toContain("(1 of 3 shown)");
    expect(out.block?.total).toBe(3);
  });
});

describe("list_album_shares", () => {
  it("names the participants of every shared album the user owns, and the owner of the others", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: ALBUMS });
    clients.photo.getAlbumShares.mockResolvedValue({
      shares: [{ user_id: 712, user_name: "Erika Beispiel", access_level: "read" }, { user_id: 713, user_name: "Max Muster", access_level: "write" }],
      publicLink: undefined,
    });
    const out = await tool("list_album_shares").run({}, ctx());
    expect(clients.photo.getAlbumShares).toHaveBeenCalledTimes(1);
    expect(clients.photo.getAlbumShares).toHaveBeenCalledWith({ id: 1 });
    expect(out.text).toContain("1 | Gardasee 2025 | Sommerurlaub | me | Erika Beispiel, Max Muster | no");
    expect(out.text).toContain("3 | Geburtstag | Feier | another user | ? | no");
    expect(out.text).toContain("1 album is shared with the user by someone else");
    expect(out.block?.rows[0]).toMatchObject({ id: 1, shared_with: "Erika Beispiel, Max Muster", route: "/fotos/alben/1" });
  });

  it("looks up one album by id, link-only included", async () => {
    clients.photo.listAlbums.mockResolvedValue({ albums: ALBUMS });
    clients.photo.getAlbumShares.mockResolvedValue({ shares: [], publicLink: { token: "abc" } });
    const out = await tool("list_album_shares").run({ album_id: 1 }, ctx());
    expect(out.text).toContain("1 | Gardasee 2025 | Sommerurlaub | me | nobody (link only) | yes");
  });
});

describe("search_documents", () => {
  it("passes a date order to the search and the list link, and says so in the note", async () => {
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [] });
    const out = await tool("search_documents").run({ q: "KinderPolice", sort: "date_desc" }, ctx());
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ sort_by: "doc_date", sort_dir: "desc" }));
    expect(out.text).toContain("Sorted by document date, newest first");
    expect(out.block?.route).toBe("/dokumente?q=KinderPolice&sortBy=doc_date&sortDir=desc");
  });

  it("ranks by relevance unless asked", async () => {
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [] });
    const out = await tool("search_documents").run({ q: "Police" }, ctx());
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ sort_by: undefined }));
    expect(out.text).toContain("Ranked by relevance");
  });
});

describe("list_photos", () => {
  it("matches the place on the server and can ask for the oldest first", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 1, filename: "a.jpg", taken_at: "2003-07-14T10:00:00Z", location_city: "Musterstadt" }] });
    const out = await tool("list_photos").run({ place: "Musterstadt", order: "oldest", limit: 1 }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ locationText: "Musterstadt", sortDir: "asc" }));
    expect(out.text).toContain("1 | 2003-07-14 | Musterstadt");
    expect(out.text).toContain("oldest first");
    expect(out.block?.route).toBeUndefined();
  });

  it("asks newest first by default", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [] });
    await tool("list_photos").run({ favorite: true }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ sortDir: "desc", locationText: undefined }));
  });
});

describe("depot tools", () => {
  const POSITION = {
    key: "DE0000000001", isin: "DE0000000001", wkn: "000001", name: "Beispiel AG", currency: "EUR", account_ids: [2], open: true,
    amount: "100", price: "75.10", price_as_of: "2026-10-16", price_source: "quote", value: "7510.00", cost_basis: "6000.00",
    unrealized_gain: "1510.00", unrealized_gain_pct: "25.17", weight_pct: "60.00", realized_gain: "0.00", realized_gain_complete: true,
    income: "48.20", yield_on_cost_pct: "0.80", fees: "9.90", taxes: "12.70", total_return: "1535.60", total_return_pct: "25.59",
    buy_count: 2, sell_count: 0, dividend_count: 1, first_transaction_at: "2024-02-01", last_transaction_at: "2026-05-12",
  };
  const SUMMARY = {
    as_of: "2026-10-16", price_as_of: "2026-10-16", market_value: "12510.00", cost_basis: "10000.00", cost_basis_complete: true,
    unrealized_gain: "2510.00", unrealized_gain_pct: "25.10", realized_gain: "210.00", realized_gain_ytd: "0.00", realized_gain_complete: true,
    income: "120.00", income_ytd: "48.20", fees: "14.80", taxes: "12.70", total_return: "2812.50", total_return_pct: "28.13",
    open_positions: 2, closed_positions: 0, transaction_count: 5,
  };

  it("portfolio_overview reads the summary, the positions and the years out, largest first", async () => {
    clients.finance.getPortfolio.mockResolvedValue({
      accounts: [{ id: 2, label: "Depot", currency_code: "EUR", closed: false }], closed_hidden: 0, currency: "EUR", mixed_currency: false,
      summary: SUMMARY,
      positions: [{ ...POSITION, key: "DE0000000002", name: "Muster ETF", value: "5000.00" }, POSITION],
      years: [{ year: 2025, realized: "210.00", sell_count: 1, realized_complete: true, income: "71.80", dividend_count: 2, fees: "4.90", taxes: "0.00", net_invested: "-1000.00" }],
    });
    const out = await tool("portfolio_overview").run({}, ctx());
    expect(out.text).toContain("market value 12510.00; cost basis 10000.00; unrealized gain 2510.00 (25.10 %)");
    expect(out.text).toContain("realized gain 210.00 (this year 0.00); income from dividends and interest 120.00 (this year 48.20)");
    expect(out.text).toContain("DE0000000001 | Beispiel AG | Depot | 100 | 75.10 | 7510.00 | 1510.00 | 25.17 %");
    expect(out.text).toContain("2025 | 210.00 | 1 | 71.80 | 2");
    expect(out.block?.rows.map((r) => r.key)).toEqual(["DE0000000001", "DE0000000002"]);
    expect(out.block).toMatchObject({ kind: "positions", route: "/finanzen/portfolio", subtitle: "Depotwert 12510.00 EUR · unrealisiert 2510.00 EUR" });

    const one = await tool("portfolio_overview").run({ q: "muster" }, ctx());
    expect(one.rowCount).toBe(1);
    expect(one.text).not.toContain("Per year");
  });

  it("depot_transactions filters by kind and period and repeats the server's sums", async () => {
    clients.finance.listPortfolioTransactions.mockResolvedValue({
      items: [{ id: 31, account_id: 2, account_label: "Depot", position_key: "DE0000000001", isin: "DE0000000001", wkn: null, name: "Beispiel AG", kind: "dividend", executed_at: "2026-05-12", amount: "100", price: null, gross_amount: "60.90", fees: "0.00", tax: "12.70", net_amount: "48.20", currency: "EUR", source: "bank", linked_transaction_id: null, note: null, document_ids: [] }],
      total: 1, sums: { net_amount: "48.20", fees: "0.00", taxes: "12.70" },
    });
    const out = await tool("depot_transactions").run({ kind: "dividend", from: "2026-01-01", to: "2026-12-31" }, ctx());
    expect(clients.finance.listPortfolioTransactions).toHaveBeenCalledWith(expect.objectContaining({ kind: "dividend", from: "2026-01-01", to: "2026-12-31", limit: 25 }));
    expect(out.text).toContain("31 | 2026-05-12 | dividend | Beispiel AG | Depot | 100 | - | 48.20 | 0.00 | 12.70 | EUR");
    expect(out.text).toContain("net 48.20, fees 0.00, taxes 12.70");
    expect(out.block).toMatchObject({ kind: "depot_transactions", subtitle: "Netto 48.20 · Gebühren 0.00 · Steuern 12.70", route: "/finanzen/portfolio?kind=dividend&from=2026-01-01&to=2026-12-31" });
    await expect(tool("depot_transactions").run({ kind: "bonus" }, ctx())).rejects.toThrow("kind must be one of");
  });

  it("position_detail reads one security with its sales and years", async () => {
    clients.finance.getPortfolioPosition.mockResolvedValue({
      currency: "EUR", position: POSITION,
      accounts: [{ account_id: 2, account_label: "Depot", amount: "100", value: "7510.00", cost_basis: "6000.00" }],
      transactions: [{ id: 1, account_label: "Depot", kind: "buy", executed_at: "2024-02-01", amount: "100", price: "60.00", net_amount: "-6009.90", fees: "9.90", tax: "0.00" }],
      sales: [{ transaction_id: 7, executed_at: "2025-03-03", quantity: "10", proceeds: "700.00", cost: "600.00", gain: "100.00" }],
      years: [{ year: 2025, realized: "100.00", realized_complete: true, sell_count: 1, income: "0.00", dividend_count: 0, fees: "0.00", taxes: "0.00" }],
    });
    const out = await tool("position_detail").run({ key: "DE0000000001" }, ctx());
    expect(out.text).toContain("Beispiel AG (ISIN DE0000000001, WKN 000001), held");
    expect(out.text).toContain("2025-03-03 | 10 | 700.00 | 600.00 | 100.00");
    expect(out.text).toContain("2024-02-01 | buy | Depot | 100 | 60.00 | -6009.90 | 9.90 | 0.00");
    expect(out.block).toMatchObject({ kind: "positions", route: "/finanzen/portfolio/DE0000000001" });
  });

  it("quotes lists last price, change and unread news, filtered by name", async () => {
    clients.finance.getQuotes.mockResolvedValue({
      range: "1m", as_of: "2026-10-16T13:30:00.000Z",
      tiles: [
        { key: "DE0000000001", isin: "DE0000000001", wkn: null, name: "Beispiel AG", amount: "100", currency: "EUR", last: { at: "2026-10-16T13:30:00.000Z", price: "75.100000" }, value: "7510.00", change: { absolute: "2.30", percent: "3.16" }, points: [], status: "ok", news_unread: 2 },
        { key: "XX0", isin: null, wkn: null, name: "Unbekannt", amount: "1", currency: null, last: null, value: null, change: null, points: [], status: "unresolved", news_unread: 0 },
      ],
    });
    const out = await tool("quotes").run({ q: "beispiel", range: "1m" }, ctx());
    expect(clients.finance.getQuotes).toHaveBeenCalledWith({ range: "1m", accounts: undefined });
    expect(out.rowCount).toBe(1);
    expect(out.text).toContain("DE0000000001 | Beispiel AG | 100 | 75.100000 | 2026-10-16 13:30 | 7510.00 | 2.30 | 3.16 | 2");
    expect(out.block).toMatchObject({ kind: "quotes", route: "/finanzen/kurse?range=1m" });
    await expect(tool("quotes").run({ range: "2y" }, ctx())).rejects.toThrow("range must be one of");
  });

  it("position_news reads the collected news of one security", async () => {
    clients.finance.getPositionNews.mockResolvedValue({
      items: [{ id: 5, url: "https://example.test/a", title: "Beispiel AG hebt Prognose an", source: "Beispiel Wirtschaft", at: "2026-10-15T07:00:00.000Z", summary: "Mehr Umsatz.", sentiment: 0.6, provider: "yahoo" }],
      checked_at: "2026-10-16T06:00:00.000Z", seen_at: null,
    });
    const out = await tool("position_news").run({ key: "DE0000000001", limit: 5 }, ctx());
    expect(clients.finance.getPositionNews).toHaveBeenCalledWith({ key: "DE0000000001", limit: 5 });
    expect(out.text).toContain("2026-10-15 | Beispiel Wirtschaft | Beispiel AG hebt Prognose an | 0.6 | Mehr Umsatz.");
    expect(out.block).toMatchObject({ kind: "news", route: "/finanzen/portfolio/DE0000000001" });
    expect(out.block?.rows[0]).toMatchObject({ url: "https://example.test/a", sentiment: 0.6 });
  });
});

describe("search_documents with a sender", () => {
  it("turns the sender's name into the known correspondent's slug", async () => {
    clients.documents.listCorrespondents.mockResolvedValue({ items: [
      { slug: "techniker-krankenkasse", display: "Techniker Krankenkasse (TK)", count: 40 },
      { slug: "tk-leasing", display: "TK Leasing GmbH", count: 2 },
    ] });
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [] });
    const out = await tool("search_documents").run({ q: "Gesundheitsdividende einlösen", correspondent: "TK", mode: "fts" }, ctx());
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: "fts", correspondent: "techniker-krankenkasse", sender: undefined }));
    expect(out.text).toContain('Correspondent "TK" taken as Techniker Krankenkasse (TK) (40 documents); also matching: TK Leasing GmbH.');
    expect(out.text).toContain("Word match only");
    expect(out.block?.route).toContain("correspondent=techniker-krankenkasse");
  });

  it("falls back to the sender line when no correspondent matches, and refuses an unknown mode", async () => {
    clients.documents.listCorrespondents.mockResolvedValue({ items: [] });
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [] });
    const out = await tool("search_documents").run({ q: "Beitrag", correspondent: "Beispielkasse" }, ctx());
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: "hybrid", correspondent: undefined, sender: "Beispielkasse" }));
    expect(out.text).toContain('No known correspondent matches "Beispielkasse"');
    await expect(tool("search_documents").run({ q: "x", mode: "fuzzy" }, ctx())).rejects.toThrow("mode must be one of");
  });
});

describe("get_document_summary for several documents", () => {
  it("reads them in one call and returns one block, naming the ones it could not read", async () => {
    clients.documents.getDocument
      .mockResolvedValueOnce({ id: 61, title: "Gesundheitsdividende beantragen", doc_date: "2026-02-10", correspondent_display: "TK", category_slug: "versicherung", summary: "So wird sie eingelöst." })
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ id: 63, title: "Bonusprogramm", doc_date: "2026-03-01", sender: "TK", summary: "Punkte sammeln." });
    const out = await tool("get_document_summary").run({ ids: [61, 62, 63] }, ctx());
    expect(out.rowCount).toBe(2);
    expect(out.text).toContain("title: Gesundheitsdividende beantragen");
    expect(out.text).toContain("title: Bonusprogramm");
    expect(out.text).toContain("Not found or not visible: 62.");
    expect(out.block).toMatchObject({ kind: "documents", rows: [{ id: 61 }, { id: 63 }] });
    expect(out.ref).toEqual({ type: "document", ids: [61, 63] });
  });

  it("keeps the single-document shape for one id", async () => {
    clients.documents.getDocument.mockResolvedValue({ id: 61, title: "Antrag", doc_date: "2026-02-10", summary: "x" });
    const out = await tool("get_document_summary").run({ id: 61 }, ctx());
    expect(out.block).toMatchObject({ kind: "document", route: "/dokumente/61" });
    await expect(tool("get_document_summary").run({}, ctx())).rejects.toThrow("id or ids is required");
  });
});

describe("photo comments and activity", () => {
  it("photo_comments lists who wrote what under a photo of an album", async () => {
    clients.photo.listComments.mockResolvedValue({
      comments: [{ id: 9, photoId: 1203, albumId: 31, author: { id: 712, name: "Erika Beispiel", kind: "user" }, body: "Was für ein Sonnenuntergang!", createdAt: "2026-10-15T19:02:00.000Z", editedAt: null }],
      nextCursor: 8,
    });
    const out = await tool("photo_comments").run({ photo_id: 1203, album_id: 31 }, ctx());
    expect(clients.photo.listComments).toHaveBeenCalledWith({ id: 1203, albumId: 31, limit: 30 });
    expect(out.text).toContain("9 | 2026-10-15 19:02 | Erika Beispiel | Was für ein Sonnenuntergang!");
    expect(out.text).toContain("Older comments exist");
    expect(out.block).toMatchObject({ kind: "comments", route: "/fotos/alben/31?photoId=1203" });
  });

  it("photo_activity filters the feed by kind and marks unread entries", async () => {
    clients.feed.listFeed.mockResolvedValue({
      items: [
        { id: 501, kind: "photo_commented", actor: { id: 712, name: "Erika Beispiel" }, album: { id: 31, name: "Gardasee 2025" }, photo: { id: 1203, filename: "a.jpg", description: null }, payload: { commentId: 9, excerpt: "Was für ein Sonnenuntergang!" }, seen_at: null, created_at: "2026-10-15T19:02:00.000Z" },
        { id: 500, kind: "photo_favorited", actor: { id: 713, name: "Max Muster" }, album: { id: 31, name: "Gardasee 2025" }, photo: { id: 1201, filename: "b.jpg", description: null }, payload: {}, seen_at: "2026-10-15T20:00:00.000Z", created_at: "2026-10-15T18:00:00.000Z" },
      ],
      nextCursor: null, unreadCount: 1,
    });
    const out = await tool("photo_activity").run({ kind: "photo_commented" }, ctx());
    expect(out.rowCount).toBe(1);
    expect(out.text).toContain("501 | 2026-10-15 19:02 | comment | Erika Beispiel | Gardasee 2025 | 1203 | Was für ein Sonnenuntergang! | yes");
    expect(out.text).toContain("1 unread entries in the whole feed");
    expect(out.block?.rows[0]).toMatchObject({ kind: "photo_commented", unread: true, route: "/fotos/alben/31?photoId=1203" });
    await expect(tool("photo_activity").run({ kind: "likes" }, ctx())).rejects.toThrow("kind must be one of");
  });
});

describe("depots per position and the day's gain", () => {
  it("portfolio_overview names the depot(s) a position lies in", async () => {
    clients.finance.getPortfolio.mockResolvedValue({
      accounts: [{ id: 2, label: "Depot Beispielbank", currency_code: "EUR", closed: false }, { id: 5, label: "Depot Musterbank", currency_code: "EUR", closed: false }],
      closed_hidden: 0, currency: "EUR", mixed_currency: false,
      summary: { as_of: null, price_as_of: null, market_value: "1.00", cost_basis: "1.00", cost_basis_complete: true, unrealized_gain: "0.00", unrealized_gain_pct: null, realized_gain: "0.00", realized_gain_ytd: "0.00", realized_gain_complete: true, income: "0.00", income_ytd: "0.00", fees: "0.00", taxes: "0.00", total_return: "0.00", total_return_pct: null, open_positions: 1, closed_positions: 0, transaction_count: 1 },
      positions: [{ key: "DE0000000001", isin: "DE0000000001", wkn: null, name: "Beispiel AG", currency: "EUR", account_ids: [2, 5], open: true, amount: "10", price: "1.00", price_as_of: null, price_source: null, value: "10.00", cost_basis: null, unrealized_gain: null, unrealized_gain_pct: null, weight_pct: null, realized_gain: null, realized_gain_complete: true, income: null, yield_on_cost_pct: null, fees: null, taxes: null, total_return: null, total_return_pct: null, buy_count: 1, sell_count: 0, dividend_count: 0, first_transaction_at: null, last_transaction_at: null }],
      years: [],
    });
    const out = await tool("portfolio_overview").run({ q: "Beispiel" }, ctx());
    expect(out.text).toContain("Depot Beispielbank [id 2], Depot Musterbank [id 5]");
    expect(out.text).toContain("DE0000000001 | Beispiel AG | Depot Beispielbank, Depot Musterbank | 10");
    expect(out.block?.rows[0]).toMatchObject({ depots: "Depot Beispielbank, Depot Musterbank" });
  });

  it("quotes sums the value and the change over the range, as the Kurse page does", async () => {
    clients.finance.getQuotes.mockResolvedValue({
      range: "1d", as_of: "2026-10-16T13:30:00.000Z",
      tiles: [
        { key: "A", isin: null, wkn: null, name: "Beispiel AG", amount: "100", currency: "EUR", last: { at: "2026-10-16T13:30:00.000Z", price: "75.10" }, value: "7510.00", change: { absolute: "0.60", percent: "0.81" }, points: [], status: "ok", news_unread: 0 },
        { key: "B", isin: null, wkn: null, name: "Muster ETF", amount: "50", currency: "EUR", last: { at: "2026-10-16T13:30:00.000Z", price: "100.00" }, value: "5000.00", change: { absolute: "-0.40", percent: "-0.40" }, points: [], status: "ok", news_unread: 0 },
        { key: "C", isin: null, wkn: null, name: "Unbekannt", amount: "1", currency: null, last: null, value: null, change: null, points: [], status: "unresolved", news_unread: 0 },
      ],
    });
    const out = await tool("quotes").run({ range: "1d" }, ctx());
    expect(out.text).toContain("Total value of the 2 priced holdings: 12510.00; change since yesterday: +40.00 (2 with a comparison price). Positive = gain.");
    expect(out.block?.subtitle).toBe("Wert 12510.00 · +40.00 seit gestern");
  });
});

describe("tax", () => {
  it("tax_documents groups the year's documents by Anlage", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({
      year: 2025, total_documents: 2,
      sections: [
        { slug: "anlage-n", name: "Anlage N", group: "income", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20", correspondent_display: "Beispiel GmbH" }, confidence: null, source: "user" }] },
        { slug: "anlage-kap", name: "Anlage KAP", group: "income", documents: [{ document: { id: 72, title: "Jahressteuerbescheinigung", doc_date: "2026-02-02", sender: "Beispielbank" }, confidence: 0.91, source: "ai" }] },
      ],
    });
    const out = await tool("tax_documents").run({ year: 2025 }, ctx());
    expect(clients.documents.listTaxDocuments).toHaveBeenCalledWith({ year: 2025, section: undefined, review_needed: undefined, tax_return_person: undefined });
    expect(out.text).toContain("2 documents for the tax return of 2025, in 2 Anlagen");
    expect(out.text).toContain("Anlage N (anlage-n, income) — 1:");
    expect(out.text).toContain("72 | 2026-02-02 | Jahressteuerbescheinigung | Beispielbank (ai 91 %)");
    expect(out.ref).toEqual({ type: "document", ids: [71, 72] });
    expect(out.block).toMatchObject({ kind: "documents", subtitle: "Steuer 2025", route: "/dokumente/steuer?year=2025" });
    expect(out.block?.rows[1]).toMatchObject({ id: 72, section: "Anlage KAP" });
  });

  it("search_documents and list_transactions pass the tax-relevant flag on", async () => {
    clients.documents.listCorrespondents.mockResolvedValue({ items: [] });
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({ items: [] });
    await tool("search_documents").run({ q: "Spende", tax_relevant: true }, ctx());
    expect(clients.documents.searchDocumentsEndpoint).toHaveBeenCalledWith(expect.objectContaining({ tax_relevant: true }));
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 1, account_id: 1, booking_date: "2025-03-10", amount: "-480.00", counterparty: "Beispiel Handwerk GmbH", purpose: "Rechnung", is_tax_relevant: true }], total: 1 });
    const out = await tool("list_transactions").run({ tax_relevant: true, from: "2025-01-01", to: "2025-12-31" }, ctx());
    expect(clients.finance.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ taxRelevant: true, from: "2025-01-01", to: "2025-12-31" }));
    expect(out.text).toMatch(/Rechnung \| [^|]* \| yes/);
  });

  it("get_document_summary names the tax year and the Anlagen", async () => {
    clients.documents.getDocument.mockResolvedValue({ id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20", tax_relevant: true, tax_year: 2025, tax_sections: [{ slug: "anlage-n", name: "Anlage N", group: "income" }], summary: "x" });
    const out = await tool("get_document_summary").run({ id: 71 }, ctx());
    expect(out.text).toContain("tax: relevant for the tax return of 2025, Anlage(n): Anlage N");
  });
});

describe("tax_worksheet", () => {
  it("arranges documents with recognised amounts per Anlage, bookings by tag, the depot year and hints", async () => {
    clients.documents.listTaxDocuments
      .mockResolvedValueOnce({
        year: 2025, total_documents: 2,
        sections: [
          { slug: "anlage-n", name: "Anlage N", group: "einkuenfte", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20", correspondent_display: "Beispiel GmbH" }, confidence: null, source: "user" }] },
          { slug: "haushaltsnahe", name: "Haushaltsnahe Aufwendungen", group: "abzuege", documents: [{ document: { id: 73, title: "Rechnung Gartenpflege", doc_date: "2025-06-02", sender: "Beispiel Gartenbau" }, confidence: 0.8, source: "ai" }] },
          { slug: "anlage-v", name: "Anlage V", group: "einkuenfte", documents: [] },
        ],
      })
      .mockResolvedValueOnce({ year: 2024, total_documents: 1, sections: [{ slug: "anlage-kap", name: "Anlage KAP", group: "einkuenfte", documents: [{ document: { id: 5, title: "Jahressteuerbescheinigung 2024" }, confidence: null, source: "user" }] }] });
    clients.documents.getDocumentReceiptSuggestion
      .mockResolvedValueOnce({ amount: 48200 })
      .mockResolvedValueOnce({ amount: null });
    clients.finance.listTransactions.mockResolvedValue({
      items: [
        { id: 1, booking_date: "2025-03-10", amount: "-480.00", counterparty: "Beispiel Handwerk GmbH", purpose: "Rechnung", tags: [{ name: "Handwerker" }] },
        { id: 2, booking_date: "2025-07-01", amount: "-700.00", counterparty: "Muster Sanitär", purpose: "Bad", tags: [{ name: "Handwerker" }] },
        { id: 3, booking_date: "2025-12-24", amount: "-200.00", counterparty: "Beispielverein", purpose: "Spende", tags: [] },
      ],
      total: 3,
    });
    clients.finance.getPortfolio.mockResolvedValue({ years: [{ year: 2025, realized: "210.00", sell_count: 1, realized_complete: true, income: "120.00", dividend_count: 4, fees: "9.90", taxes: "31.60" }] });
    const out = await tool("tax_worksheet").run({ year: 2025 }, ctx());
    expect(clients.documents.listTaxDocuments).toHaveBeenNthCalledWith(2, { year: 2024, tax_return_person: undefined });
    expect(out.text).toContain("71 | 2026-01-20 | Lohnsteuerbescheinigung 2025 | Beispiel GmbH | 48200.00 EUR");
    expect(out.text).toContain("sum of recognised amounts: 48200.00 EUR");
    expect(out.text).toContain("73 | 2025-06-02 | Rechnung Gartenpflege | Beispiel Gartenbau | no amount recognised | Anlage 80 %");
    expect(out.text).toContain("sum of recognised amounts: 0.00 EUR (1 without amount)");
    expect(out.text).toContain("Handwerker: 2 booking(s), -1180.00 EUR");
    expect(out.text).toContain("(ohne Tag): 1 booking(s), -200.00 EUR");
    expect(out.text).toContain("total: -1380.00 EUR over 3 booking(s)");
    expect(out.text).toContain("income (dividends, interest): 120.00 EUR from 4 payment(s); realized gain: 210.00 EUR from 1 sale(s); taxes withheld: 31.60 EUR");
    expect(out.text).toContain("Anlage KAP: 1 document(s) last year, none flagged for 2025 yet.");
    expect(out.text).toContain("1 document(s) carry no recognised amount");
    expect(out.text).not.toContain("Anlage V");
    expect(out.block).toMatchObject({ kind: "documents", subtitle: "Ausfüllhilfe 2025 · 2 Anlagen · 3 Buchungen", route: "/dokumente/steuer?year=2025" });
    expect(out.block?.rows[0]).toMatchObject({ section: "Anlage N", amount: 48200, route: "/dokumente/71" });
  });

  it("leaves bookings and depot out without finance access", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({ year: 2025, total_documents: 0, sections: [] });
    const out = await tool("tax_worksheet").run({ year: 2025 }, { ...ctx(), user: { userID: "711", permissions: ["module.documents", "documents.view", "module.assistant"] } });
    expect(clients.finance.listTransactions).not.toHaveBeenCalled();
    expect(out.text).toContain("Bookings and depot figures are left out");
  });
});
