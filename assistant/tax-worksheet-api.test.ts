import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import { clients, resetClients } from "./clients.test-helper";
import { getTaxWorksheet, storeTaxWorksheetPdfDocument } from "./tax-worksheet-api";

const PERMS = ["module.documents", "documents.view", "module.finance", "finance.view"];

function setAuth(permissions: string[] = PERMS) {
  vi.mocked(getAuthData).mockReturnValue({ userID: "721", permissions });
}

function flagged() {
  clients.documents.listTaxDocuments.mockImplementation(async ({ year }: { year: number }) => year === 2025
    ? {
      year, total_documents: 1,
      sections: [{ slug: "anlage-n", name: "Anlage N", group: "einkuenfte", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20" }, confidence: null, source: "user" }] }],
    }
    : { year, total_documents: 0, sections: [] });
  clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
  clients.finance.listBusinesses.mockResolvedValue({ items: [] });
  clients.finance.getPortfolio.mockResolvedValue({ years: [] });
}

beforeEach(() => {
  resetClients();
  setAuth();
});

describe("GET /assistant/tax-worksheet", () => {
  it("reads the worksheet of a year, without inventing amounts for the documents", async () => {
    flagged();
    const w = await getTaxWorksheet({ year: 2025 });
    expect(w.year).toBe(2025);
    expect(w.sections.map((s) => [s.name, s.documents.length])).toEqual([["Anlage N", 1]]);
    expect(w.sections[0]!.documents[0]).not.toHaveProperty("amount");
    // The receipt rule picked one number per document; a tax certificate prints a dozen.
    expect(clients.documents.getDocumentReceiptSuggestion).not.toHaveBeenCalled();
    expect(w.hints.some((h) => h.includes("not read yet"))).toBe(true);
    expect(w.documentCount).toBe(1);
    expect(clients.documents.listTaxDocuments).toHaveBeenCalledWith(expect.objectContaining({ year: 2025 }));
  });

  it("rejects a year out of range and needs documents.view", async () => {
    await expect(getTaxWorksheet({ year: 1800 })).rejects.toThrow("year");
    setAuth([]);
    await expect(getTaxWorksheet({ year: 2025 })).rejects.toThrow();
  });
});

describe("POST /assistant/tax-worksheet/pdf", () => {
  it("stores the worksheet as a document linked to the flagged documents", async () => {
    flagged();
    clients.documents.storeGeneratedDocument.mockResolvedValue({ id: 900 });
    const res = await storeTaxWorksheetPdfDocument({ year: 2025 });
    expect(res).toEqual({ document_id: 900, route: "/dokumente/900", sections: 1, bookings: 0 });
    const stored = clients.documents.storeGeneratedDocument.mock.calls[0]![0] as { filename: string; linked_document_ids: number[]; pdf_base64: string };
    expect(stored).toMatchObject({ filename: "Ausfüllhilfe Steuer 2025.pdf", linked_document_ids: [71] });
    expect(Buffer.from(stored.pdf_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a year with nothing flagged", async () => {
    flagged();
    await expect(storeTaxWorksheetPdfDocument({ year: 2023 })).rejects.toThrow("nichts markiert");
    expect(clients.documents.storeGeneratedDocument).not.toHaveBeenCalled();
  });
});
