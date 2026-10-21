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

  it("passes direction and amount range on, says so, and links to the same filtered list", async () => {
    clients.finance.getOverview.mockResolvedValue({ sections: [{ name: "Täglich", accounts: [GIRO] }], unassigned: [] });
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 6, account_id: 1, booking_date: "2026-10-11", amount: "-8.50", counterparty: "Beispiel Café", purpose: "Kaffee" }], total: 1 });
    const out = await tool("list_transactions").run({ account_id: 1, tags: ["Urlaub"], direction: "out", amount_min: 5 }, ctx());
    expect(clients.finance.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ tagsCsv: "Urlaub", direction: "out", amountMin: 5 }));
    expect(out.text).toContain("Only money out (Ausgaben).");
    expect(out.block?.route).toContain("/finanzen/uebersicht/konto/1?");
    expect(out.block?.route).toContain("direction=out");
    expect(out.block?.route).toContain("amountMin=5");
  });

  it("ignores a direction it does not know", async () => {
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    await tool("list_transactions").run({ direction: "both" }, ctx());
    expect(clients.finance.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ direction: undefined }));
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

  it("asks the server for the best first, and links the gallery in the same order", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 2, taken_at: "2024-04-02T10:00:00Z" }] });
    const out = await tool("list_photos").run({ order: "best", limit: 20 }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({ sortBy: "quality", sortDir: "desc" }));
    expect(out.text).toContain("best first by quality score");
    expect(out.block?.route).toBe("/fotos/galerie?sortBy=ai_quality_score&sortDir=desc");
  });

  it("narrows the previous result by place on the server, which knows the place's other names", async () => {
    clients.photo.listPhotos.mockResolvedValueOnce({ photos: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const first = await tool("list_photos").run({}, ctx());
    clients.photo.listPhotos.mockResolvedValueOnce({ photos: [{ id: 2, location_country: "Pays d'exemple" }, { id: 9 }] });
    const c = { ...ctx(), previous: () => first.ref!.ids };
    const out = await tool("list_photos").run({ place: "Beispielland", from_previous_result: true }, c);
    expect(clients.photo.listPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ locationText: "Beispielland" }));
    expect(out.ref?.ids).toEqual([2]);
  });
});

describe("photo metadata", () => {
  it("list_photos passes the metadata filters and prints description, keywords and quality", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 4, taken_at: "2022-08-14T10:00:00Z", description: "Sommerfest im Garten", keywords: ["Fest", "Garten"], ai_quality_score: 0.734 }] });
    const out = await tool("list_photos").run({ has_description: true, keyword: "Fest", sight: "Turm", orientation: "portrait", media_type: "photo", quality_min: 60, limit: 50 }, ctx());
    expect(clients.photo.listPhotos).toHaveBeenCalledWith(expect.objectContaining({
      hasDescription: true, keyword: "Fest", sight: "Turm", orientation: "portrait", mediaTypes: "photo", qualityMin: 60,
    }));
    expect(out.text).toContain("4 | 2022-08-14 | - | Sommerfest im Garten | Fest, Garten | 73");
    expect(out.block?.route).toBeUndefined();
  });

  it("photo_details gathers what each service knows and leaves out what it may not see", async () => {
    clients.photo.getPhotoDetailsBatch.mockResolvedValue({ photos: [{
      id: 7, filename: "a.jpg", original_name: "IMG_0001.JPG", mime_type: "image/jpeg", size: 2_400_000, taken_at: "2023-04-02T09:15:00Z",
      location_name: "Beispielstadt, Beispielland", latitude: 1.5, longitude: 2.25, orientation: "portrait", curation_status: "favorite",
      description: "Am Hafen", keywords: ["Hafen"], ai_quality_score: 0.81, ai_quality_details: { clip_aesthetics: 0.7 },
    }] });
    clients.photo.getPhotoFaces.mockRejectedValue(new Error("permission denied"));
    clients.photo.getPhotoPoiMatches.mockResolvedValue({ matches: [{ name: "Example Tower", nameDe: "Beispielturm", distanceM: 120.4, ambiguous: false }] });
    clients.photo.getPhotoOcr.mockResolvedValue({ ocr: null });
    clients.photo.getPhotoCritique.mockResolvedValue({ critique: null });
    const out = await tool("photo_details").run({ ids: [7, 8] }, ctx());
    expect(clients.photo.getPhotoDetailsBatch).toHaveBeenCalledWith({ ids: "7,8" });
    expect(out.text).toContain("- place: Beispielstadt, Beispielland");
    expect(out.text).toContain("- gps: 1.50000, 2.25000");
    expect(out.text).toContain("- orientation: Hochformat");
    expect(out.text).toContain("- status: favorite");
    expect(out.text).toContain("- quality: 81");
    expect(out.text).toContain("- aesthetics: 70");
    expect(out.text).toContain("- sights: Beispielturm (120 m)");
    expect(out.text).toContain("- text in photo: not scanned yet");
    expect(out.text).not.toContain("- persons:");
    expect(out.text).toContain("Not found or not visible: 8");
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
    expect(out.block).toMatchObject({ kind: "documents", subtitle: "Steuer 2025", route: "/finanzen/steuer?year=2025" });
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

/** The documents service's answer for 2025, synthetic (amounts in cents). */
const TAX_FORM = {
  year: 2025, catalogue_year: 2025, exact: true, joint: true, documents_read: 2, documents_unread: 1,
  previous: { year: 2024, missing: [{ key: "sonder.spenden", anlage_name: "Sonderausgaben", label: "Zuwendungen an steuerbegünstigte Organisationen", owner_label: "Gemeinsam", place: "Zeile 5 · Kz 123", previous_cents: 20000, previous_documents: [{ document_id: 8, document_title: "Zuwendungsbestätigung Beispielverein" }] }] },
  values: [
    {
      key: "n.bruttoarbeitslohn", anlage: "anlage-n", anlage_name: "Anlage N — Nichtselbstständige Arbeit", label: "Bruttoarbeitslohn",
      owner: "self", owner_label: "Person A (Sie)", line: 5, kennzahl: "110", place: "Zeile 5 · Kz 110", checked: true, source: "Anlage N 2025", form_note: null,
      prefilled: true, cents: 4820000, notes: ["Vom Finanzamt elektronisch vorausgefüllt: nur prüfen."], open: 1, previous_cents: 4600000,
      contributions: [{ value_id: 1, document_id: 71, document_title: "Lohnsteuerbescheinigung 2025", evidence_kind: "lohnsteuerbescheinigung", evidence_kind_name: "Lohnsteuerbescheinigung", field_label: "Bruttoarbeitslohn", cents: 4820000, value_cents: 4820000, printed: "48.200,00", quote: null, page: 1, status: "read", note: null }],
    },
    {
      key: "vorsorge.rv_arbeitnehmer", anlage: "vorsorgeaufwand", anlage_name: "Vorsorgeaufwand", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung",
      owner: "spouse", owner_label: "Person B (Ehegatte)", line: 4, kennzahl: "400", place: "Zeile 4 · Kz 400", checked: true, source: "Anlage Vorsorgeaufwand 2025", form_note: null,
      prefilled: true, cents: 111600, notes: [], open: 0, previous_cents: null,
      contributions: [{ value_id: 2, document_id: 72, document_title: "Lohnsteuerbescheinigung Partner", evidence_kind: "lohnsteuerbescheinigung", evidence_kind_name: "Lohnsteuerbescheinigung", field_label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", cents: 111600, value_cents: 223200, printed: null, quote: null, page: null, status: "confirmed", note: null }],
    },
  ],
  skipped: [{ value_id: 3, document_id: 74, document_title: "Rechnung Malerbetrieb", evidence_kind_name: "Handwerkerrechnung", field_label: "Rechnungsbetrag brutto", form_label: null, value_cents: 99900, printed: "999,00", quote: null, status: "rejected", reason: "Zahl steht nicht im Text", note: "Zahl steht nicht im Text" }],
};

describe("tax_worksheet", () => {
  it("arranges documents per Anlage without amounts, bookings by tag, the depot year and hints", async () => {
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
    clients.finance.listTransactions.mockResolvedValue({
      items: [
        { id: 1, booking_date: "2025-03-10", amount: "-480.00", counterparty: "Beispiel Handwerk GmbH", purpose: "Rechnung", tags: [{ name: "Handwerker" }] },
        { id: 2, booking_date: "2025-07-01", amount: "-700.00", counterparty: "Muster Sanitär", purpose: "Bad", tags: [{ name: "Handwerker" }] },
        { id: 3, booking_date: "2025-12-24", amount: "-200.00", counterparty: "Beispielverein", purpose: "Spende", tags: [] },
      ],
      total: 3,
    });
    clients.finance.getPortfolio.mockResolvedValue({ years: [{ year: 2025, realized: "210.00", sell_count: 1, realized_complete: true, income: "120.00", dividend_count: 4, fees: "9.90", taxes: "31.60" }] });
    clients.finance.listBusinesses.mockResolvedValue({ items: [{ id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft", tax_section: "anlage-l" }] });
    clients.finance.getBusinessEuer.mockResolvedValue({ total_income: 86000, total_expenses: 249640, result: -163640, afa: { sum: 240000 }, booking_count: 3, hints: [] });
    const out = await tool("tax_worksheet").run({ year: 2025 }, ctx());
    expect(clients.finance.getBusinessEuer).toHaveBeenCalledWith({ id: 2, year: 2025 });
    expect(out.text).toContain("== Landwirtschaft Musterhof (anlage-l, EÜR 2025) ==");
    expect(out.text).toContain("Betriebseinnahmen 860.00 EUR; Betriebsausgaben 2496.40 EUR (AfA 2400.00 EUR included); Verlust -1636.40 EUR from 3 booking(s). Details: euer_report(business_id = 2).");
    expect(clients.documents.listTaxDocuments).toHaveBeenNthCalledWith(2, { year: 2024, tax_return_person: undefined });
    expect(out.text).toContain("71 | 2026-01-20 | Lohnsteuerbescheinigung 2025 | Beispiel GmbH\n");
    expect(out.text).toContain("73 | 2025-06-02 | Rechnung Gartenpflege | Beispiel Gartenbau | Anlage 80 %");
    expect(out.text).not.toContain("recognised");
    expect(clients.documents.getDocumentReceiptSuggestion).not.toHaveBeenCalled();
    expect(out.text).toContain("Handwerker: 2 booking(s), -1180.00 EUR");
    expect(out.text).toContain("(ohne Tag): 1 booking(s), -200.00 EUR");
    expect(out.text).toContain("total: -1380.00 EUR over 3 booking(s)");
    expect(out.text).toContain("income (dividends, interest): 120.00 EUR from 4 payment(s); realized gain: 210.00 EUR from 1 sale(s); taxes withheld: 31.60 EUR");
    expect(out.text).toContain("Anlage KAP: 1 document(s) last year, none flagged for 2025 yet.");
    // The documents service did not answer: no figure is invented for the documents.
    expect(out.text).toContain("The values read from the documents could not be loaded");
    expect(out.text).toContain("No value of a document is known to the worksheet: never state one");
    expect(out.text).not.toContain("Anlage V");
    expect(out.block).toMatchObject({ kind: "documents", subtitle: "Ausfüllhilfe 2025 · 2 Anlagen · 3 Buchungen", route: "/finanzen/steuer?year=2025" });
    expect(out.block?.rows[0]).toMatchObject({ section: "Anlage N", route: "/dokumente/71" });
    expect(out.block?.rows[0]).not.toHaveProperty("amount");
  });

  it("lists the documents' values by Anlage, line and Kennzahl, with where each came from", async () => {
    clients.documents.listTaxDocuments.mockImplementation(async ({ year }: { year: number }) => year === 2025
      ? { year, total_documents: 1, sections: [{ slug: "anlage-n", name: "Anlage N", group: "einkuenfte", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20" }, confidence: null, source: "user" }] }] }
      : { year, total_documents: 0, sections: [] });
    clients.documents.getTaxFormValues.mockResolvedValue(TAX_FORM);
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    clients.finance.listBusinesses.mockResolvedValue({ items: [] });
    clients.finance.getPortfolio.mockResolvedValue({ years: [] });
    const out = await tool("tax_worksheet").run({ year: 2025 }, ctx());
    expect(clients.documents.getTaxFormValues).toHaveBeenCalledWith({ year: 2025, tax_return_person: undefined });
    expect(out.text).toContain("== Values by form field (joint assessment; form 2025) ==");
    expect(out.text).toContain("  Anlage N — Nichtselbstständige Arbeit — Person A (Sie)\n    Zeile 5 · Kz 110 | Bruttoarbeitslohn | 48200.00 EUR | 2024: 46000.00 EUR | 1 unconfirmed | prefilled by the Finanzamt, check only");
    expect(out.text).toContain("Had a value in 2024, none yet in 2025:\n    Sonderausgaben — Gemeinsam | Zeile 5 · Kz 123 | Zuwendungen an steuerbegünstigte Organisationen | 2024: 200.00 EUR from document 8 (Zuwendungsbestätigung Beispielverein)");
    expect(out.text).toContain("1 field(s) had a value in 2024 but none yet in 2025 (Zuwendungen an steuerbegünstigte Organisationen): check whether evidence is still missing.");
    expect(out.text).toContain("from document 71 (Lohnsteuerbescheinigung 2025, Lohnsteuerbescheinigung): Bruttoarbeitslohn 48200.00 EUR, unconfirmed, page 1");
    expect(out.text).toContain("Zeile 4 · Kz 400 | Arbeitnehmeranteil zur gesetzlichen Rentenversicherung | 1116.00 EUR | all confirmed");
    expect(out.text).toContain("share of 2232.00 EUR");
    expect(out.text).toContain("document 74 (Rechnung Malerbetrieb): Rechnungsbetrag brutto \"999,00\" — Zahl steht nicht im Text");
    expect(out.text).toContain("1 evidence document(s) of 2025 are not read yet");
    expect(out.text).toContain("1 value(s) were read but not confirmed yet");
    expect(out.text).toContain("1 value(s) could not be found in their document's text");
    expect(out.text).toContain("State a document's figure only as listed under the form values above, with its line and Kennzahl");
    expect(out.text).not.toContain("could not be loaded");
    expect(out.block).toMatchObject({ subtitle: "Ausfüllhilfe 2025 · 2 Werte nach Kennzahl · 1 Anlagen · 0 Buchungen" });
    expect(out.digest).toContain("2 form values");
  });

  it("leaves bookings and depot out without finance access", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({ year: 2025, total_documents: 0, sections: [] });
    const out = await tool("tax_worksheet").run({ year: 2025 }, { ...ctx(), user: { userID: "711", permissions: ["module.documents", "documents.view", "module.assistant"] } });
    expect(clients.finance.listTransactions).not.toHaveBeenCalled();
    expect(out.text).toContain("Bookings and depot figures are left out");
  });
});

describe("businesses", () => {
  const FARM = { id: 2, name: "Landwirtschaft Musterhof", kind: "landwirtschaft", tax_section: "anlage-l", notes: null, asset_count: 1, parcel_count: 1 };
  const PV = { id: 1, name: "PV-Anlage Dach", kind: "photovoltaik", tax_section: "anlage-g", notes: null, asset_count: 1, parcel_count: 0 };

  it("lists the register with kind, tax form and counts", async () => {
    clients.finance.listBusinesses.mockResolvedValue({ items: [PV, FARM] });
    const out = await tool("list_businesses").run({}, ctx());
    expect(out.text).toContain("2 | Landwirtschaft Musterhof | farm (Anlage L) | anlage-l | 1 | 1");
    expect(out.block).toMatchObject({ kind: "businesses", route: "/finanzen/betriebe" });
    expect(out.block?.rows[1]).toMatchObject({ id: 2, route: "/finanzen/betriebe/2" });
  });

  it("shows the assets with the year's AfA and the parcels, and leaves the arithmetic to the server", async () => {
    clients.finance.getBusiness.mockResolvedValue({
      business: FARM,
      year: 2025,
      assets: [{ id: 7, name: "Stallgebäude", kind: "gebaeude", acquisition_date: "2020-04-15", acquisition_cost: "120000.00", afa_rate_pct: "2.000", afa_start_date: null, disposal_date: null, disposal_proceeds: null, depreciation: { year: 2025, months: 12, afa: "2400.00", accumulated: "13800.00", book_value: "106200.00", disposal_result: null } }],
      parcels: [{ id: 3, gemarkung: "Musterfeld", flur: "4", flurstueck: "12/3", area_m2: 21500, usage: "acker", lessee: "Beispiel Agrar GbR", lease_from: "2019-10-01", lease_to: null, annual_rent: "860.00" }],
      totals: { acquisition_cost: "120000.00", afa: "2400.00", book_value: "106200.00", annual_rent: "860.00", area_m2: 21500 },
    });
    const out = await tool("business_assets").run({ business_id: 2, year: 2025 }, ctx());
    expect(clients.finance.getBusiness).toHaveBeenCalledWith({ id: 2, year: 2025 });
    expect(out.text).toContain("7 | Stallgebäude | gebaeude | 2020-04-15 | 120000.00 | 2% | 12 | 2400.00 | 106200.00 |");
    expect(out.text).toContain("3 | Musterfeld Flur 4 Flst. 12/3 | acker | 21500 | Beispiel Agrar GbR | 860.00 |");
    expect(out.text).toContain("AfA 2400.00, book value 106200.00");
    expect(out.block).toMatchObject({ kind: "business_assets", subtitle: "Landwirtschaft Musterhof · 2025 · AfA 2400.00 € · Buchwert 106200.00 €" });
    expect(out.block?.rows.map((r) => r.kind)).toEqual(["gebaeude", "parcel"]);
  });
});

describe("euer_report", () => {
  it("prints every line, the AfA, the totals and the result, and leaves nothing to add up", async () => {
    clients.finance.getBusinessEuer.mockResolvedValue({
      year: 2025, business: "Landwirtschaft Musterhof", tag: "Landwirtschaft",
      income: [{ name: "Pachteinnahmen", kind: "income", form_line: "Zeile 14", count: 2, sum: 86000, other: false, bookings: [] }],
      expenses: [{ name: "Grundsteuer", kind: "expense", form_line: null, count: 1, sum: 9640, other: false, bookings: [] }, { name: "Sonstige Betriebsausgaben", kind: "expense", form_line: null, count: 1, sum: 5000, other: true, bookings: [] }],
      afa: { sum: 240000, assets: [{ asset_id: 7, name: "Stall", afa: 240000 }] },
      total_income: 86000, total_expenses: 254640, result: -168640, booking_count: 4, unflagged: 0,
      hints: ['1 booking(s) went to "Sonstige Betriebsausgaben": no line names one of their tags.'],
    });
    const out = await tool("euer_report").run({ business_id: 2, year: 2025 }, ctx());
    expect(clients.finance.getBusinessEuer).toHaveBeenCalledWith({ id: 2, year: 2025 });
    expect(out.text).toContain("Zeile 14 · Pachteinnahmen: 860.00 EUR (2 bookings)");
    expect(out.text).toContain("AfA: 2400.00 EUR (Stall 2400.00 EUR)");
    expect(out.text).toContain("Verlust: -1686.40 EUR (= 860.00 EUR − 2546.40 EUR)");
    expect(out.text).toContain("Sonstige Betriebsausgaben");
    expect(out.block).toMatchObject({ kind: "euer", subtitle: "Landwirtschaft Musterhof · 2025 · Verlust -1686.40 €", route: "/finanzen/betriebe/2?year=2025" });
    expect(out.block?.rows.map((r) => [r.kind, r.sum])).toEqual([["income", 860], ["expense", 96.4], ["expense", 50], ["afa", 2400]]);
  });
});

describe("business_documents", () => {
  it("lists the linked documents with what they are linked to, and leaves unreadable ones out of the block", async () => {
    clients.finance.listBusinessDocuments.mockResolvedValue({ items: [
      { id: 1, document_id: 71, target_kind: "parcel", target_id: 3, target_name: "Musterfeld Flst. 12/3", note: "Pacht ab 2025", document: { id: 71, title: "Pachtvertrag Musterfeld", original_filename: "71.pdf", doc_date: "2025-03-01", category_slug: "landwirtschaft-pacht", correspondent_display: "Beispiel Agrar GbR", sender: null } },
      { id: 2, document_id: 72, target_kind: "asset", target_id: 7, target_name: "Stall", note: null, document: { id: 72, title: null, original_filename: "dach.pdf", doc_date: null, category_slug: null, correspondent_display: null, sender: "Beispiel Dachdecker" } },
      { id: 3, document_id: 73, target_kind: "business", target_id: null, target_name: null, note: null, document: null },
    ] });
    const out = await tool("business_documents").run({ business_id: 2 }, ctx());
    expect(clients.finance.listBusinessDocuments).toHaveBeenCalledWith({ id: 2 });
    expect(out.text).toContain("71 | Pachtvertrag Musterfeld | 2025-03-01 | Beispiel Agrar GbR | parcel Musterfeld Flst. 12/3 | Pacht ab 2025");
    expect(out.text).toContain("72 | dach.pdf | - | Beispiel Dachdecker | asset Stall | -");
    expect(out.text).toContain("73 | (not readable) | - | - | business | -");
    expect(out.text).toContain("3 linked document(s), 1 not readable by the user");
    expect(out.ref).toEqual({ type: "document", ids: [71, 72] });
    expect(out.block?.rows.map((r) => [r.id, r.subtitle])).toEqual([[71, "Fläche Musterfeld Flst. 12/3"], [72, "Anlagegut Stall"]]);
  });
});
