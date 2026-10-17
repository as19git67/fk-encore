import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./titles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./titles")>()),
  suggestTitle: vi.fn(async () => null),
}));
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantConversation, assistantMessage, assistantProposal } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { calledEndpoints, clients, resetClients } from "./clients.test-helper";
import { chat, type ChatReply } from "./llm-client";
import { __resetLiveTurnsForTests } from "./live";
import {
  ask,
  createConversation,
  discardAssistantProposal,
  executeAssistantProposal,
  getConversation,
} from "./assistant";
import { HAND_TOOLS } from "./catalog";
import type { ToolContext } from "./types";

const PERMS = [
  "module.assistant", "module.photos", "photos.view", "albums.manage",
  "module.documents", "documents.view", "module.finance", "finance.view",
];

function setAuth(userID: string, permissions: string[] = PERMS) {
  vi.mocked(getAuthData).mockReturnValue({ userID, permissions });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash) VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x') ON CONFLICT (id) DO NOTHING`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT MAX(id) FROM users), 1))`,
  );
}

function toolCall(name: string, args: Record<string, unknown>): ChatReply {
  return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function text(content: string): ChatReply {
  return { content, tool_calls: [], finish_reason: "stop" };
}

const ctx = (userID = "711", permissions = PERMS): ToolContext => ({ user: { userID, permissions }, today: "2026-10-15" });

function tool(name: string) {
  const t = HAND_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeEach(async () => {
  await db.delete(assistantProposal);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await ensureUser(711);
  await ensureUser(712);
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  __resetLiveTurnsForTests();
  setAuth("711");
});

describe("write tools", () => {
  it("are in the catalog as proposals", () => {
    for (const name of ["create_album", "add_photos_to_album", "set_photo_favorite", "create_document_follow_up", "tag_transactions"]) {
      expect(tool(name).kind).toBe("write");
    }
  });

  it("an album request becomes a proposal and nothing is created", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }, { id: 6 }, { id: 7 }] });
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_album", {
        name: "Favoriten 2025",
        photos: { favorite: true, date_from: "2025-01-01", date_to: "2025-12-31" },
      }))
      .mockResolvedValueOnce(text("Ich habe das Album „Favoriten 2025“ mit 3 Fotos vorgeschlagen."));

    const res = await ask({ id: conversation.id, message: "Leg ein Album mit allen Favoriten von 2025 an." });

    expect(calledEndpoints()).toEqual(["photo.listPhotos"]);
    expect(clients.photo.listPhotos.mock.calls[0][0]).toMatchObject({ favorite: true, dateFrom: "2025-01-01", dateTo: "2025-12-31" });
    const block = res.blocks.find((b) => b.kind === "proposal");
    expect(block?.rows[0]).toMatchObject({
      tool: "create_album",
      summary: "Album „Favoriten 2025“ anlegen und 3 Fotos hinzufügen",
      count: 3,
      status: "pending",
    });
    const [stored] = await db.select().from(assistantProposal);
    expect(stored).toMatchObject({ conversation_id: conversation.id, user_id: 711, status: "pending" });
    expect(stored.arguments).toMatchObject({ name: "Favoriten 2025", photo_ids: [5, 6, 7] });

    // The tool result tells the model it is only a proposal.
    const second = vi.mocked(chat).mock.calls[1][0];
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("NOT executed");
  });

  it("refuses a selection that names no photos", async () => {
    await expect(tool("add_photos_to_album").run({ album_id: 1 }, ctx())).rejects.toThrow();
  });

  it("proposes the tax return's folder from the flagged documents and bookings, and creates a mixed Sammelmappe", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({
      year: 2025, total_documents: 2,
      sections: [
        { slug: "anlage-n", name: "Anlage N", group: "income", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung" } }] },
        { slug: "anlage-kap", name: "Anlage KAP", group: "income", documents: [{ document: { id: 72, title: "Jahressteuerbescheinigung" } }, { document: { id: 71, title: "Lohnsteuerbescheinigung" } }] },
        { slug: "anlage-v", name: "Anlage V", group: "income", documents: [] },
      ],
    });
    clients.finance.listTransactions.mockResolvedValue({ items: [{ id: 9301 }, { id: 9302 }], total: 2 });
    const out = await tool("tax_return_bundle").run({ year: 2025 }, { ...ctx(), user: { userID: "711", permissions: [...PERMS, "module.finance", "finance.view"] } });
    expect(clients.documents.listTaxDocuments).toHaveBeenCalledWith({ year: 2025, tax_return_person: undefined });
    expect(clients.finance.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ taxRelevant: true, from: "2025-01-01", to: "2025-12-31" }));
    const row = out.block?.rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ tool: "tax_return_bundle", summary: "Sammelmappe „Steuererklärung 2025“ mit 2 Dokumenten in 2 Anlagen (Anlage N 1, Anlage KAP 2) und 2 steuerrelevanten Buchungen", count: 4, status: "pending" });
    expect(calledEndpoints()).toEqual(["finance.listTransactions", "documents.listTaxDocuments"].sort() ? expect.arrayContaining(["documents.listTaxDocuments", "finance.listTransactions"]) : []);
    expect(clients.collections.createAnyCollection).not.toHaveBeenCalled();

    clients.collections.createAnyCollection.mockResolvedValue({ id: 88, name: "Steuererklärung 2025" });
    const done = await executeAssistantProposal({ id: Number(row.proposal_id) });
    expect(done).toMatchObject({ status: "executed", result_route: "/sammelmappen/88" });
    expect(clients.collections.createAnyCollection).toHaveBeenCalledWith({
      name: "Steuererklärung 2025",
      description: "Steuererklärung 2025: 2 Dokumente (Anlage N 1, Anlage KAP 2), 2 steuerrelevante Buchungen",
      members: [
        { entity_type: "document", entity_id: 71 }, { entity_type: "document", entity_id: 72 },
        { entity_type: "transaction", entity_id: 9301 }, { entity_type: "transaction", entity_id: 9302 },
      ],
    });
  });

  it("stores the worksheet as a PDF document linked to the flagged documents", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({
      year: 2025, total_documents: 1,
      sections: [{ slug: "anlage-n", name: "Anlage N", group: "einkuenfte", documents: [{ document: { id: 71, title: "Lohnsteuerbescheinigung 2025", doc_date: "2026-01-20" }, confidence: null, source: "user" }] }],
    });
    clients.documents.getDocumentReceiptSuggestion.mockResolvedValue({ amount: 48200 });
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    clients.finance.getPortfolio.mockResolvedValue({ years: [] });
    const out = await tool("tax_worksheet_pdf").run({ year: 2025 }, ctx());
    const row = out.block?.rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ tool: "tax_worksheet_pdf", summary: "Ausfüllhilfe Steuer 2025 als PDF: 1 Dokumente in 1 Anlagen, 0 steuerrelevante Buchungen", status: "pending" });

    clients.documents.storeGeneratedDocument.mockResolvedValue({ id: 900 });
    const done = await executeAssistantProposal({ id: Number(row.proposal_id) });
    expect(done).toMatchObject({ status: "executed", result_route: "/dokumente/900" });
    const stored = clients.documents.storeGeneratedDocument.mock.calls[0]![0] as { filename: string; title: string; pdf_base64: string; linked_document_ids: number[] };
    expect(stored).toMatchObject({ filename: "Ausfüllhilfe Steuer 2025.pdf", title: "Ausfüllhilfe Steuererklärung 2025", linked_document_ids: [71] });
    expect(Buffer.from(stored.pdf_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("proposes the EÜR of a business as a PDF and stores it as a document", async () => {
    clients.finance.getBusinessEuer.mockResolvedValue({
      year: 2025, business: "Landwirtschaft Musterhof", tag: "Landwirtschaft",
      income: [{ name: "Pachteinnahmen", kind: "income", form_line: null, count: 2, sum: 86000, other: false, bookings: [{ id: 1, booking_date: "2025-03-01", counterparty: "Beispiel Agrar GbR", purpose: "Pacht", amount: "430.00" }] }],
      expenses: [], afa: { sum: 240000, assets: [{ asset_id: 7, name: "Stall", afa: 240000 }] },
      total_income: 86000, total_expenses: 240000, result: -154000, booking_count: 2, unflagged: 0, hints: [],
    });
    const out = await tool("euer_pdf").run({ business_id: 2, year: 2025 }, ctx());
    const row = out.block?.rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ tool: "euer_pdf", summary: "EÜR 2025 Landwirtschaft Musterhof als PDF: 2 Buchungen, Einnahmen 860.00 €, Ausgaben 2400.00 €, Verlust -1540.00 €", status: "pending" });

    clients.documents.storeGeneratedDocument.mockResolvedValue({ id: 901 });
    const done = await executeAssistantProposal({ id: Number(row.proposal_id) });
    expect(done).toMatchObject({ status: "executed", result_route: "/dokumente/901" });
    const stored = clients.documents.storeGeneratedDocument.mock.calls[0]![0] as { filename: string; title: string; pdf_base64: string };
    expect(stored).toMatchObject({ filename: "EÜR Landwirtschaft Musterhof 2025.pdf", title: "Einnahmen-Überschuss-Rechnung 2025 Landwirtschaft Musterhof" });
    expect(Buffer.from(stored.pdf_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("refuses a tax folder for a year with nothing flagged", async () => {
    clients.documents.listTaxDocuments.mockResolvedValue({ year: 2019, total_documents: 0, sections: [] });
    clients.finance.listTransactions.mockResolvedValue({ items: [], total: 0 });
    await expect(tool("tax_return_bundle").run({ year: 2019 }, ctx())).rejects.toThrow("nothing is flagged for the tax year 2019");
  });

  it("refuses a filter on top of the previous photos, naming the way round", async () => {
    // The filter would be dropped and every earlier photo would land in the
    // album; the benchmark saw Gemma try this for "nur die aus München".
    await expect(tool("create_album").run(
      { name: "München 2025", from_previous_result: true, photos: { place: "München" } },
      { ...ctx(), previous: (type) => (type === "photo" ? [1, 2, 3] : undefined) },
    )).rejects.toThrow("list_photos with from_previous_result");
  });

  it("refuses a follow-up in the past", async () => {
    await expect(tool("create_document_follow_up").run({ document_ids: [1], date: "2026-10-01" }, ctx()))
      .rejects.toThrow("past");
  });
});

describe("deciding", () => {
  async function albumProposal(): Promise<number> {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }, { id: 6 }] });
    const out = await tool("create_album").run({ name: "Sommer", photos: { favorite: true } }, ctx());
    return Number(out.block?.rows[0].proposal_id);
  }

  it("executes once, through the services' endpoints", async () => {
    const id = await albumProposal();
    clients.photo.createAlbum.mockResolvedValue({ id: 42, name: "Sommer" });
    clients.photo.batchUpdateAlbumPhotos.mockResolvedValue({ success: true });

    const done = await executeAssistantProposal({ id });
    expect(done).toMatchObject({ status: "executed", result_route: "/fotos/alben/42", error: null });
    expect(clients.photo.createAlbum).toHaveBeenCalledWith({ name: "Sommer", description: undefined });
    expect(clients.photo.batchUpdateAlbumPhotos).toHaveBeenCalledWith({ albumIds: [42], photoIds: [5, 6], action: "add" });

    await expect(executeAssistantProposal({ id })).rejects.toThrow("already executed");
    await expect(discardAssistantProposal({ id })).rejects.toThrow("already executed");
    expect(clients.photo.createAlbum).toHaveBeenCalledTimes(1);
  });

  it("is not visible to another user", async () => {
    const id = await albumProposal();
    setAuth("712");
    await expect(executeAssistantProposal({ id })).rejects.toThrow("proposal not found");
    await expect(discardAssistantProposal({ id })).rejects.toThrow("proposal not found");
    expect(clients.photo.createAlbum).not.toHaveBeenCalled();
  });

  it("a failure stays pending with its error and can be retried", async () => {
    const id = await albumProposal();
    clients.photo.createAlbum.mockRejectedValueOnce(new Error("album name taken"));
    const failed = await executeAssistantProposal({ id });
    expect(failed).toMatchObject({ status: "pending", error: "album name taken" });

    clients.photo.createAlbum.mockResolvedValue({ id: 43, name: "Sommer" });
    clients.photo.batchUpdateAlbumPhotos.mockResolvedValue({ success: true });
    expect((await executeAssistantProposal({ id })).status).toBe("executed");
  });

  it("re-checks permissions at execution", async () => {
    const id = await albumProposal();
    setAuth("711", PERMS.filter((p) => p !== "albums.manage"));
    const res = await executeAssistantProposal({ id });
    expect(res.status).toBe("pending");
    expect(res.error).toContain("permission");
    expect(clients.photo.createAlbum).not.toHaveBeenCalled();
  });

  it("discarding leaves everything untouched, and the reopened conversation shows it", async () => {
    clients.photo.listPhotos.mockResolvedValue({ photos: [{ id: 5 }] });
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_album", { name: "Herbst", photo_ids: [5] }))
      .mockResolvedValueOnce(text("Vorgeschlagen."));
    const res = await ask({ id: conversation.id, message: "Album Herbst mit Foto 5" });
    const id = Number(res.blocks.find((b) => b.kind === "proposal")?.rows[0].proposal_id);

    expect((await discardAssistantProposal({ id })).status).toBe("discarded");
    expect(calledEndpoints()).toEqual([]);

    const reopened = await getConversation({ id: conversation.id });
    const card = reopened.messages.at(-1)?.blocks.find((b) => b.kind === "proposal")?.rows[0];
    expect(card).toMatchObject({ status: "discarded", count: 1 });
  });

  it("tags bookings and sets follow-ups through their endpoints", async () => {
    const tagged = await tool("tag_transactions").run({ transaction_ids: [1, 2], add: ["Urlaub"] }, ctx());
    clients.finance.batchTag.mockResolvedValue({ affected_transactions: 2, added_links: 2, removed_links: 0 });
    const tagRes = await executeAssistantProposal({ id: Number(tagged.block?.rows[0].proposal_id) });
    expect(tagRes.status).toBe("executed");
    expect(clients.finance.batchTag).toHaveBeenCalledWith({ transaction_ids: [1, 2], add: ["Urlaub"], remove: [] });

    const follow = await tool("create_document_follow_up").run({ document_ids: [9], date: "2026-11-02", note: "Frist" }, ctx());
    clients.documents.setDocumentFollowUp.mockResolvedValue({ scheduled: 1 });
    const followRes = await executeAssistantProposal({ id: Number(follow.block?.rows[0].proposal_id) });
    expect(followRes).toMatchObject({ status: "executed", result_route: "/dokumente/spaeter" });
    expect(clients.documents.setDocumentFollowUp).toHaveBeenCalledWith({ document_ids: [9], follow_up_date: "2026-11-02", note: "Frist" });
  });
});

describe("a redacted Sammelmappe", () => {
  const box = (page: number) => ({ page, x: 0.2, y: 0.1, w: 0.15, h: 0.02 });

  function scriptBoxes() {
    clients.documents.findDocumentTextBoxes.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 41) return { status: "ok", boxes: [box(1)], pages: [1] };
      if (id === 42) return { status: "ok", boxes: [box(2), box(3)], pages: [2, 3] };
      if (id === 43) return { status: "no_words", boxes: [], pages: [] };
      return { status: "ok", boxes: [], pages: [] };
    });
  }

  it("is only proposed: the boxes are found, nothing is created", async () => {
    scriptBoxes();
    const conversation = await createConversation({});
    clients.documents.searchDocumentsEndpoint.mockResolvedValue({
      items: [41, 42, 43, 44].map((id) => ({ id, title: `Dokument ${id}`, doc_date: "2024-05-01" })),
    });
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("search_documents", { q: "Kauf Wohnung" }))
      .mockResolvedValueOnce(text("Vier Dokumente."));
    await ask({ id: conversation.id, message: "Was war beim Kauf der Wohnung relevant?" });

    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("create_collection", { name: "Kauf Musterstadt", from_previous_result: true, redact: ["450.000,00"] }))
      .mockResolvedValueOnce(text("Vorgeschlagen."));
    const res = await ask({ id: conversation.id, message: "Schwärze den Kaufpreis und mach ein PDF daraus." });

    const card = res.blocks.find((b) => b.kind === "proposal")?.rows[0];
    expect(card).toMatchObject({
      tool: "create_collection",
      summary: "Sammelmappe „Kauf Musterstadt“ mit 4 Dokumenten, „450.000,00“ auf 3 Seiten geschwärzt, 1 Dokument noch ohne Wortpositionen, dort nichts geschwärzt, PDF wird erzeugt",
      count: 4,
    });
    expect(clients.documents.findDocumentTextBoxes).toHaveBeenCalledTimes(4);
    expect(clients.documents.createCollection).not.toHaveBeenCalled();
    expect(clients.documents.updateCollectionItem).not.toHaveBeenCalled();
    expect(clients.documents.startCollectionExport).not.toHaveBeenCalled();
  });

  it("is created with its boxes and its PDF started on 'Ausführen'", async () => {
    scriptBoxes();
    const out = await tool("create_collection").run({ name: "Kauf Musterstadt", document_ids: [41, 42, 43], redact: ["450.000,00"] }, ctx());
    const id = Number(out.block?.rows[0].proposal_id);
    clients.documents.createCollection.mockResolvedValue({ id: 7, title: "Kauf Musterstadt" });
    clients.documents.updateCollectionItem.mockResolvedValue({});
    clients.documents.startCollectionExport.mockResolvedValue({ status: "running" });

    const done = await executeAssistantProposal({ id });
    expect(done).toMatchObject({ status: "executed", result_route: "/dokumente/mappen/7" });
    expect(done.result_summary).toContain("3 Seiten geschwärzt");
    expect(clients.documents.createCollection).toHaveBeenCalledWith({ title: "Kauf Musterstadt", document_ids: [41, 42, 43] });
    expect(clients.documents.updateCollectionItem.mock.calls.map((c) => c[0])).toEqual([
      { id: 7, documentId: 41, redactions: [box(1)] },
      { id: 7, documentId: 42, redactions: [box(2), box(3)] },
    ]);
    expect(clients.documents.startCollectionExport).toHaveBeenCalledWith({ id: 7 });
  });

  it("says so when the value is nowhere, and refuses documents the user cannot see", async () => {
    clients.documents.findDocumentTextBoxes.mockResolvedValue({ status: "ok", boxes: [], pages: [] });
    const out = await tool("create_collection").run({ name: "Leer", document_ids: [44], redact: ["999,99"], build_pdf: false }, ctx());
    expect(out.block?.rows[0].summary).toBe("Sammelmappe „Leer“ mit 1 Dokument, „999,99“ nirgends gefunden, nichts geschwärzt");

    clients.documents.findDocumentTextBoxes.mockRejectedValue(Object.assign(new Error("document not found"), { code: "not_found" }));
    await expect(tool("create_collection").run({ name: "Fremd", document_ids: [99], redact: ["1"] }, ctx())).rejects.toThrow("documents 99 not found");
  });

  it("find_text_in_document names the pages and the documents without positions", async () => {
    scriptBoxes();
    const out = await tool("find_text_in_document").run({ document_ids: [41, 42, 43], query: "450.000" }, ctx());
    expect(out.text).toContain("41 | pages 1");
    expect(out.text).toContain("42 | pages 2, 3");
    expect(out.text).toContain("43 | no word positions yet");
    expect(out.text).toContain('"450.000" found in 2 of 3 documents.');
  });
});

describe("a transaction report", () => {
  const preview = {
    id: null,
    title: "Wohnung Musterstadt",
    currency: "EUR",
    groups: [
      { name: "Kauf", count: 1, subtotal: -30000000 },
      { name: "Mieteinnahmen", count: 2, subtotal: 160000 },
      { name: "Sonstige", count: 1, subtotal: -1234 },
    ],
    total: -29841234,
    count: 4,
    yield: { formula: "Rendite = (1.600,00 € + 0,00 €) ÷ 300.000,00 € = 0,53 %\nRendite p. a. = 0,53 % ÷ 1,00 Jahre = 0,53 %", total: 0.0053, per_year: 0.0053 },
  };

  it("is computed by the server and only proposed; the model gets the figures to repeat", async () => {
    clients.finance.previewGroupedReport.mockResolvedValue(preview);
    const conversation = await createConversation({});
    vi.mocked(chat)
      .mockResolvedValueOnce(toolCall("transaction_report", {
        title: "Wohnung Musterstadt",
        groups: [{ name: "Kauf", transaction_ids: [1] }, { name: "Mieteinnahmen", tag: "Miete" }],
        transaction_ids: [1, 2, 3, 4],
        yield: { investment_group: "Kauf", income_groups: ["Mieteinnahmen"] },
      }))
      .mockResolvedValueOnce(text("Bericht vorgeschlagen."));
    const res = await ask({ id: conversation.id, message: "Mach einen Bericht mit Rendite." });

    expect(clients.finance.previewGroupedReport).toHaveBeenCalledWith({
      title: "Wohnung Musterstadt",
      groups: [{ name: "Kauf", transaction_ids: [1] }, { name: "Mieteinnahmen", tag: "Miete" }],
      transaction_ids: [1, 2, 3, 4],
      yield: { investment_group: "Kauf", income_groups: ["Mieteinnahmen"], cost_groups: [] },
    });
    expect(clients.finance.createGroupedReport).not.toHaveBeenCalled();
    const card = res.blocks.find((b) => b.kind === "proposal")?.rows[0];
    expect(String(card?.summary).replace(/ /g, " ")).toBe(
      "Bericht „Wohnung Musterstadt“ als PDF: Kauf 1, Mieteinnahmen 2, Sonstige 1; 4 Buchungen, Summe -298.412,34 €, mit Rendite",
    );
    // The figures the answer may use come from the tool, subtotals and formula included.
    const toolMessage = vi.mocked(chat).mock.calls[1][0].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content!.replace(/\u00a0/g, " ")).toContain("Mieteinnahmen: 2 bookings, subtotal 1.600,00 €");
    expect(toolMessage.content).toContain("Rendite p. a. = 0,53 %");
  });

  it("is saved on 'Ausführen' and offers its PDF", async () => {
    clients.finance.previewGroupedReport.mockResolvedValue(preview);
    const out = await tool("transaction_report").run({ title: "Wohnung Musterstadt", groups: [{ name: "Kauf", transaction_ids: [1] }] }, ctx());
    clients.finance.createGroupedReport.mockResolvedValue({ ...preview, id: 77 });
    const done = await executeAssistantProposal({ id: Number(out.block?.rows[0].proposal_id) });
    expect(done).toMatchObject({ status: "executed", result_download: "/finance/reports/grouped/77/pdf" });
    expect(String(done.result_summary).replace(/\u00a0/g, " ")).toContain("Rendite = (1.600,00 € + 0,00 €)");
    expect(clients.finance.createGroupedReport).toHaveBeenCalledWith({
      title: "Wohnung Musterstadt", groups: [{ name: "Kauf", transaction_ids: [1] }], transaction_ids: [], yield: null,
    });
  });

  it("takes the previous booking result as the bookings of the report", async () => {
    clients.finance.previewGroupedReport.mockResolvedValue(preview);
    await tool("transaction_report").run(
      { title: "x", groups: [{ name: "Kauf", transaction_ids: [1] }], from_previous_result: true },
      { ...ctx(), previous: (type) => (type === "transaction" ? [1, 2, 3] : undefined) },
    );
    expect(clients.finance.previewGroupedReport.mock.calls[0][0]).toMatchObject({ transaction_ids: [1, 2, 3] });
  });
});
