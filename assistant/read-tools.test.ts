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
