import { describe, it, expect } from "vitest";
import { BLOCK_TITLES, displayOf, formatDate, formatMoney, presentBlock } from "./present";
import type { ResultBlock } from "./types";

describe("formatting", () => {
  it("reads dates and money the German way", () => {
    expect(formatDate("2026-03-04T10:00:00Z")).toBe("04.03.2026");
    expect(formatDate(null)).toBe("");
    expect(formatMoney("-12.5")).toBe("-12,50 €");
    expect(formatMoney(1234.5, "USD")).toBe("1.234,50 USD");
    expect(formatMoney(null)).toBe("");
  });
});

describe("displayOf", () => {
  it("names a booking by its counterparty with the amount signed", () => {
    const d = displayOf("transactions", { id: 42, booking_date: "2026-02-01", counterparty: "Stadtwerke Musterstadt", purpose: "Abschlag", amount: "-80.00" });
    expect(d).toMatchObject({ title: "Stadtwerke Musterstadt", subtitle: "Abschlag", date: "01.02.2026", value: "-80,00 €", tone: "out", route: "/finanzen/umsaetze/42" });
  });

  it("falls back to a label when a booking has no counterparty", () => {
    expect(displayOf("transactions", { id: 1, amount: "5" }).title).toBe("Ohne Gegenpartei");
  });

  it("opens a document and asks for its thumbnail", () => {
    const d = displayOf("documents", { id: 7, title: "Stromrechnung", doc_date: "2026-01-15", from: "Stadtwerke" });
    expect(d).toMatchObject({ title: "Stromrechnung", subtitle: "15.01.2026 · Stadtwerke", route: "/dokumente/7", thumbnail: { kind: "document", id: 7 } });
  });

  it("opens a photo in the gallery", () => {
    const d = displayOf("photos", { id: 9, filename: "a.jpg", taken_at: "2025-07-03T12:00:00Z" });
    expect(d).toMatchObject({ title: "03.07.2025", route: "/fotos/galerie?photoId=9", thumbnail: { kind: "photo", id: 9, filename: "a.jpg" } });
  });

  it("keeps the route a tool put on the row", () => {
    const d = displayOf("albums", { id: 3, name: "Sommer", photo_count: 12, shared: true, route: "/fotos/alben/3" });
    expect(d).toMatchObject({ title: "Sommer", subtitle: "12 Fotos · freigegeben", route: "/fotos/alben/3" });
  });

  it("tells a parcel from an asset", () => {
    expect(displayOf("business_assets", { kind: "parcel", name: "Flur 1", usage: "Acker", area_m2: 5000, lessee: "Hof Beispiel", annual_rent: "600" }))
      .toMatchObject({ subtitle: "Acker · 5000 m² · Pächter Hof Beispiel", value: "600,00 €/Jahr" });
    expect(displayOf("business_assets", { kind: "machine", name: "Wechselrichter", acquisition_cost: "2000", afa_rate_pct: "5", afa: "100", book_value: "1900" }))
      .toMatchObject({ value: "AfA 100,00 € · BW 1.900,00 €" });
  });

  it("shows a quote with its change", () => {
    const d = displayOf("quotes", { key: "x", name: "Fonds", status: "ok", value: "1000", currency: "EUR", price: "101.5", change_percent: "1.2", news_unread: 2 });
    expect(d).toMatchObject({ subtitle: "1.000,00 € · 2 neue Nachrichten", value: "101,50 € · +1.2 %", tone: "in" });
  });

  it("reads an unknown kind from its scalar columns", () => {
    const d = displayOf("table", { id: 1, name: "Zeile", count: 3, note: "x", nested: { a: 1 } });
    expect(d).toEqual({ title: "Zeile", subtitle: "3 · x", route: undefined });
  });
});

describe("presentBlock", () => {
  it("adds a display to every row and a title to the block", () => {
    const block: ResultBlock = { kind: "accounts", tool: "list_accounts", rows: [{ id: 1, label: "Giro", section: "Konten", type: "giro", balance: "10" }, { id: 2, label: "Spar", balance: null }] };
    const out = presentBlock(block);
    expect(out.title).toBe("Konten");
    expect(out.rows[0]!.display).toEqual({ title: "Giro", subtitle: "Konten · giro", value: "10,00 €", tone: "in" });
    expect(out.rows[1]!.display).toEqual({ title: "Spar", value: "kein Saldo" });
    // The source rows stay as they were.
    expect(block.rows[0]!.display).toBeUndefined();
  });

  it("is the same the second time", () => {
    const once = presentBlock({ kind: "table", tool: "t", rows: [{ id: 1, name: "a", n: 2 }] });
    expect(presentBlock(once)).toEqual(once);
  });

  it("has a title for every kind the web app knows", () => {
    for (const kind of ["accounts", "transactions", "photos", "documents", "positions", "euer", "proposal", "table"]) {
      expect(BLOCK_TITLES[kind]).toBeTruthy();
    }
  });
});
