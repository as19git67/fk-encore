/**
 * Letters from selected context (#1534). Every name, address, number and
 * amount below is made up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

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
import { assistantConversation, assistantLetter, assistantMessage, assistantProposal, users } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { clients, resetClients } from "./clients.test-helper";
import { chat, type ChatReply } from "./llm-client";
import { __resetLiveTurnsForTests } from "./live";
import {
  ask,
  createConversation,
  executeAssistantProposal,
  getConversation,
  setConversationContext,
} from "./assistant";
import { DIN5008_B, gapsIn, MM, renderLetterPdf, signatureSplit } from "./letter-pdf";
import { signed } from "./tools/letters";
import { getDocumentText } from "./tools/documents";
import type { ProposalRow } from "./proposals";

const USER = 734;
const PERMS = ["module.assistant", "module.documents", "documents.view", "documents.upload"];

function setAuth(permissions = PERMS) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(USER), permissions });
}

function toolCall(name: string, args: Record<string, unknown>, id = `c-${name}`): ChatReply {
  return { content: null, finish_reason: "tool_calls", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

function text(content: string): ChatReply {
  return { content, tool_calls: [], finish_reason: "stop" };
}

const INVOICES: Record<number, { title: string; number: string; date: string; amount: number }> = {
  101: { title: "Rechnung Heizungswartung", number: "RE-2026-0001", date: "2026-03-02", amount: 120.5 },
  102: { title: "Rechnung Ersatzteil", number: "RE-2026-0002", date: "2026-03-09", amount: 89.9 },
  103: { title: "Rechnung Anfahrt", number: "RE-2026-0003", date: "2026-03-16", amount: 45 },
};

function scriptInvoices() {
  clients.documents.getDocument.mockImplementation(async ({ id }: { id: number }) => {
    const inv = INVOICES[id];
    if (!inv) throw new Error("not found");
    return {
      id, title: inv.title, doc_date: inv.date, correspondent_display: "Musterfirma Haustechnik GmbH",
      document_type: "Rechnung", summary: `Rechnung über Arbeiten im Beispielweg 1, ${inv.number}.`,
      reference_numbers: [{ kind: "invoice", value: inv.number }],
    };
  });
  clients.documents.getDocumentReceiptSuggestion.mockImplementation(async ({ id }: { id: number }) => ({ amount: INVOICES[id]?.amount ?? null }));
}

const CONTEXT = [101, 102, 103].map((id) => ({ type: "document" as const, id }));

const BODY = [
  "Sehr geehrte Damen und Herren,",
  "hiermit bestätige ich, dass ich die folgenden Rechnungen am [[Zahlungsdatum]] bezahlt habe:",
  "RE-2026-0001 vom 02.03.2026 über 120,50 €\nRE-2026-0002 vom 09.03.2026 über 89,90 €\nRE-2026-0003 vom 16.03.2026 über 45,00 €",
  "Mit freundlichen Grüßen\nUser734",
].join("\n\n");

beforeEach(async () => {
  await db.delete(assistantLetter);
  await db.delete(assistantProposal);
  await db.delete(assistantMessage);
  await db.delete(assistantConversation);
  await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${USER}, 'letters@test.local', 'User734', 'x') ON CONFLICT (id) DO NOTHING`);
  await db.update(users).set({ postal_address: null }).where(eq(users.id, USER));
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  __resetLiveTurnsForTests();
  setAuth();
  scriptInvoices();
});

async function draftFromInvoices(): Promise<{ conversationId: number; proposal: ProposalRow }> {
  const conversation = await createConversation({ context: CONTEXT });
  vi.mocked(chat)
    .mockResolvedValueOnce(toolCall("render_letter", {
      recipient: "Musterfirma Haustechnik GmbH\nBeispielstraße 1\n12345 Musterstadt",
      subject: "Ihre Rechnungen RE-2026-0001, RE-2026-0002 und RE-2026-0003",
      body: BODY,
    }))
    .mockResolvedValueOnce(text("Der Brief liegt als Vorschlag bereit; bitte das Zahlungsdatum ergänzen."));
  const res = await ask({ id: conversation.id, message: "Schreib dem Absender, dass ich die drei Rechnungen bezahlt habe." });
  const block = res.blocks.find((b) => b.kind === "proposal");
  return { conversationId: conversation.id, proposal: block!.rows[0] as unknown as ProposalRow };
}

describe("the working set", () => {
  it("hands the model a brief of each object, with numbers and amounts", async () => {
    await draftFromInvoices();
    const system = vi.mocked(chat).mock.calls[0]![0].messages[0]!.content as string;
    expect(system).toContain("Working set");
    for (const inv of Object.values(INVOICES)) {
      expect(system).toContain(inv.number);
      expect(system).toContain(inv.date);
    }
    expect(system.replace(/ /g, " ")).toContain("120,50 €");
    // The full text is not part of the brief; the model asks for it.
    expect(clients.documents.getDocumentText).not.toHaveBeenCalled();
  });

  it("is shown as chips and can be replaced, leaving out what the user cannot see", async () => {
    const conversation = await createConversation({ context: [...CONTEXT, { type: "document", id: 999 }, { type: "transaction", id: 5 }] });
    const detail = await getConversation({ id: conversation.id });
    expect(detail.context.map((c) => [c.id, c.visible])).toEqual([[101, true], [102, true], [103, true], [999, false], [5, false]]);
    expect(detail.context[0]!.label).toBe("Rechnung Heizungswartung");

    const replaced = await setConversationContext({ id: conversation.id, context: [{ type: "document", id: 102 }] });
    expect(replaced.context.map((c) => c.id)).toEqual([102]);
  });
});

describe("render_letter", () => {
  it("drafts from three invoices: amounts and numbers as given, a gap where the date is missing", async () => {
    const { proposal } = await draftFromInvoices();
    expect(proposal.status).toBe("pending");
    const letter = proposal.letter!;
    expect(letter.body).toContain("RE-2026-0002 vom 09.03.2026 über 89,90 €");
    expect(letter.gaps).toContain("Zahlungsdatum");
    // No address on the profile yet: the sender block asks for it.
    expect(letter.sender).toBe("User734\n[[Ihre Anschrift]]");
    expect(letter.gaps).toContain("Ihre Anschrift");
    // Enclosures default to the working set's documents.
    expect(letter.attachments.map((a) => a.title)).toEqual(Object.values(INVOICES).map((i) => i.title));
    expect(letter.destinations).toEqual(["document"]);
  });

  it("refuses to go out while a gap is left, and keeps what was typed", async () => {
    const { proposal } = await draftFromInvoices();
    const row = await executeAssistantProposal({
      id: proposal.proposal_id,
      edits: { sender: "User734\nBeispielweg 2\n12345 Musterstadt" },
    });
    expect(row.status).toBe("pending");
    expect(row.error).toContain("Zahlungsdatum");
    expect(row.letter!.sender).toBe("User734\nBeispielweg 2\n12345 Musterstadt");
    expect(clients.documents.storeGeneratedDocument).not.toHaveBeenCalled();
  });

  it("files the confirmed letter as a document linked to the invoices, and in a Sammelmappe with them", async () => {
    const { proposal } = await draftFromInvoices();
    clients.documents.storeGeneratedDocument.mockResolvedValueOnce({ id: 900, linked_document_ids: [101, 102, 103] });
    clients.documents.createCollection.mockResolvedValueOnce({ id: 77, title: "Brief" });

    const row = await executeAssistantProposal({
      id: proposal.proposal_id,
      edits: {
        sender: "User734\nBeispielweg 2\n12345 Musterstadt",
        body: BODY.replace("[[Zahlungsdatum]]", "20.03.2026"),
        destinations: ["document", "collection"],
        attachment_ids: [101, 102, 103],
      },
    });
    expect(row.error).toBeNull();
    expect(row.status).toBe("executed");
    expect(row.result_route).toBe("/dokumente/mappen/77");
    expect(row.result_download).toMatch(/^\/assistant\/letters\/\d+\/pdf$/);

    const stored = clients.documents.storeGeneratedDocument.mock.calls[0]![0];
    expect(stored.linked_document_ids).toEqual([101, 102, 103]);
    expect(stored.title).toBe("Ihre Rechnungen RE-2026-0001, RE-2026-0002 und RE-2026-0003");
    expect(Buffer.from(stored.pdf_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    // The letter first, then its enclosures.
    expect(clients.documents.createCollection.mock.calls[0]![0].document_ids).toEqual([900, 101, 102, 103]);

    const [saved] = await db.select().from(assistantLetter);
    expect(saved).toMatchObject({ document_id: 900, collection_id: 77, user_id: USER });
    expect(saved.body).toContain("am 20.03.2026 bezahlt");
    // The address typed on the card is kept for the next letter.
    const [u] = await db.select({ postal_address: users.postal_address }).from(users).where(eq(users.id, USER));
    expect(u.postal_address).toBe("Beispielweg 2\n12345 Musterstadt");
  });

  it("encloses documents added on the card, but only ones the user can see", async () => {
    const { proposal } = await draftFromInvoices();
    clients.documents.storeGeneratedDocument.mockResolvedValueOnce({ id: 901 });
    clients.documents.createCollection.mockResolvedValueOnce({ id: 78, title: "Brief" });

    const row = await executeAssistantProposal({
      id: proposal.proposal_id,
      edits: {
        sender: "User734\nBeispielweg 2\n12345 Musterstadt",
        body: BODY.replace("[[Zahlungsdatum]]", "20.03.2026"),
        destinations: ["document", "collection"],
        // 103 kept, 101 and 102 dropped; 999 added but not visible to the user.
        attachment_ids: [103, 999],
      },
    });
    expect(row.error).toBeNull();
    expect(clients.documents.storeGeneratedDocument.mock.calls[0]![0].linked_document_ids).toEqual([103]);
    expect(clients.documents.createCollection.mock.calls[0]![0].document_ids).toEqual([901, 103]);
    const [saved] = await db.select().from(assistantLetter);
    expect(saved.attachments).toEqual([{ id: 103, title: "Rechnung Anfahrt" }]);
  });

  it("only takes edits on proposals that offer them", async () => {
    setAuth([...PERMS, "module.photos", "albums.manage"]);
    const [stored] = await db
      .insert(assistantProposal)
      .values({ user_id: USER, tool: "create_album", arguments: { name: "Beispielalbum", photo_ids: [] }, summary: "Album anlegen" })
      .returning({ id: assistantProposal.id });
    const row = await executeAssistantProposal({ id: stored.id, edits: { body: "x" } });
    expect(row.status).toBe("pending");
    expect(row.error).toBe("this proposal cannot be changed");
    expect(row.letter).toBeNull();
  });
});

describe("get_document_text", () => {
  it("hands over the text in pieces and says where the next one starts", async () => {
    clients.documents.getDocumentText.mockResolvedValue({ text: "a".repeat(6000) + "b".repeat(100) });
    const ctx = { user: { userID: String(USER), permissions: PERMS }, today: "2026-10-16" };
    const first = await getDocumentText.run({ id: 101 }, ctx);
    expect(first.text).toContain("call again with offset 6000");
    const second = await getDocumentText.run({ id: 101, offset: 6000 }, ctx);
    expect(second.text).toContain("b".repeat(100));
    expect(second.text).not.toContain("offset");
  });
});

describe("the DIN 5008 page", () => {
  async function textItems(pdf: Buffer) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
    const page = await doc.getPage(1);
    const [, , , height] = page.view;
    const content = await page.getTextContent();
    return (content.items as Array<{ str: string; transform: number[] }>)
      .filter((i) => i.str.trim())
      // x from the left, the baseline from the top, both in mm.
      .map((i) => ({ str: i.str, x: i.transform[4] / MM, y: (height - i.transform[5]) / MM }));
  }

  it("puts the recipient in the address window and the date in the information block", async () => {
    const pdf = await renderLetterPdf({
      sender: "Erika Beispiel\nBeispielweg 2\n12345 Musterstadt",
      recipient: "Musterfirma Haustechnik GmbH\nBeispielstraße 1\n12345 Musterstadt",
      subject: "Ihre Rechnung RE-2026-0001",
      body: "Sehr geehrte Damen und Herren,\n\nvielen Dank.\n\nMit freundlichen Grüßen\nErika Beispiel",
      date: "2026-10-16",
      attachments: ["Rechnung Heizungswartung"],
    });
    const items = await textItems(pdf);
    const at = (s: string) => items.find((i) => i.str.includes(s))!;
    const g = DIN5008_B;

    for (const line of ["Musterfirma Haustechnik GmbH", "Beispielstraße 1"]) {
      const item = at(line);
      // Inside the window: from the address field's left edge, within its width,
      // below the return line and above the field's bottom.
      expect(item.x).toBeGreaterThanOrEqual(g.addressLeft);
      expect(item.x).toBeLessThan(g.addressLeft + g.addressWidth);
      expect(item.y).toBeGreaterThan(g.recipientTop);
      expect(item.y).toBeLessThan(g.addressBottom);
    }
    // The return line sits in the window's top 5 mm.
    const returnLine = items.find((i) => i.str.includes("Erika Beispiel ·"))!;
    expect(returnLine.y).toBeGreaterThan(g.addressTop);
    expect(returnLine.y).toBeLessThan(g.addressTop + g.returnLineHeight);

    const date = at("16.10.2026");
    expect(date.x).toBeCloseTo(g.infoLeft, 0);
    expect(at("Ihre Rechnung RE-2026-0001").y).toBeGreaterThan(g.addressBottom);
    expect(at("Anlagen")).toBeDefined();
  });

  it("leaves room for the signature and numbers a second page (DIN 5008)", async () => {
    const letter = {
      sender: "Erika Beispiel\nBeispielweg 2\n12345 Musterstadt",
      recipient: "Musterfirma GmbH\nBeispielstraße 1\n12345 Musterstadt",
      subject: "Kündigung",
      body: "Sehr geehrte Damen und Herren,\n\nhiermit kündige ich.\n\nMit freundlichen Grüßen\nErika Beispiel",
      date: "2026-10-21",
      attachments: [],
    };
    const items = await textItems(await renderLetterPdf(letter));
    const y = (s: string) => items.find((i) => i.str.includes(s))!.y;
    // Two blank lines below the subject, three for the signature.
    expect(y("Sehr geehrte") - y("Kündigung")).toBeGreaterThan(12);
    const signature = items.filter((i) => i.str === "Erika Beispiel").map((i) => i.y).sort((a, b) => b - a)[0];
    expect(signature - y("Mit freundlichen Grüßen")).toBeGreaterThan(15);
    expect(items.some((i) => i.str.startsWith("Seite "))).toBe(false);

    const long = { ...letter, body: Array.from({ length: 60 }, (_, i) => `Absatz ${i + 1}.`).join("\n\n") };
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await renderLetterPdf(long)), useSystemFonts: false }).promise;
    expect(doc.numPages).toBeGreaterThan(1);
    const last = await doc.getPage(doc.numPages);
    const strs = (await last.getTextContent()).items.map((i) => ("str" in i ? i.str : ""));
    expect(strs).toContain(`Seite ${doc.numPages} von ${doc.numPages}`);
  });

  it("splits the closing from the name below it", () => {
    expect(signatureSplit("Mit freundlichen Grüßen\nErika Beispiel")).toEqual({ closing: "Mit freundlichen Grüßen", name: "Erika Beispiel" });
    expect(signatureSplit("Viele Grüße,\nErika")).toEqual({ closing: "Viele Grüße,", name: "Erika" });
    expect(signatureSplit("Mit freundlichen Grüßen")).toBeNull();
    expect(signatureSplit("Bitte bestätigen Sie den Erhalt.")).toBeNull();
  });

  it("finds the gaps the model left", () => {
    expect(gapsIn("am [[Zahlungsdatum]] bezahlt", "[[Betreff]] und [[Zahlungsdatum]]")).toEqual(["Zahlungsdatum", "Betreff"]);
    expect(gapsIn("[keine Lücke]")).toEqual([]);
  });
});

describe("signing a letter", () => {
  it("puts the user's name where the model left a gap for it, or under a bare closing", () => {
    expect(signed("Text.\n\nMit freundlichen Grüßen,\n\n[[Dein Name]]", "Erika Beispiel")).toBe("Text.\n\nMit freundlichen Grüßen,\nErika Beispiel");
    expect(signed("Text.\n\nMit freundlichen Grüßen", "Erika Beispiel")).toBe("Text.\n\nMit freundlichen Grüßen\nErika Beispiel");
    expect(signed("Text.\n\nMit freundlichen Grüßen\nMax Muster", "Erika Beispiel")).toBe("Text.\n\nMit freundlichen Grüßen\nMax Muster");
    expect(signed("Text.\n\n[[Dein Name]]", "[[Ihr Name]]")).toBe("Text.\n\n[[Dein Name]]");
  });
});

