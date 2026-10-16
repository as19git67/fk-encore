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
    expect(out.text).toContain("DE0000000001 | Beispiel AG | 100 | 75.10 | 7510.00 | 1510.00 | 25.17 %");
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
