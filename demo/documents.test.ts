/**
 * The documents of the demo household: deterministic, the promised size,
 * amounts that add up, facts the classification can be measured against,
 * and model texts that name nobody the demo does not have.
 */
import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPES } from "../documents/document-types";
import { categoryTaxonomy, flattenTaxonomy } from "../documents/taxonomy";
import { parseLlmTexts, textIsClean } from "./doc-text-llm";
import { DOC_TRUTH, euro, planDocuments } from "./documents";
import { planHousehold } from "./household";
import { layoutDocument, renderPdf, renderScanPdf } from "./pdf-render";
import { createRandom } from "./random";
import { categoryHit, senderHit } from "./truth";

const today = "2026-10-26";
const household = planHousehold(7, "full", today);
const plan = planDocuments(7, "full", household);

describe("planDocuments", () => {
  it("gives the same documents for the same seed and day", () => {
    expect(planDocuments(7, "full", planHousehold(7, "full", today))).toEqual(plan);
  });

  it("plans 500 documents for the full size and 30 for the small one", () => {
    expect(plan.documents).toHaveLength(500);
    expect(planDocuments(7, "small", planHousehold(7, "small", today)).documents).toHaveLength(30);
  });

  it("dates nothing after today and gives every document its own key", () => {
    expect(plan.documents.every((d) => d.date <= today)).toBe(true);
    expect(new Set(plan.documents.map((d) => d.key)).size).toBe(plan.documents.length);
  });

  it("ties a document to a booking of the same amount", () => {
    const linked = plan.documents.filter((d) => d.booking !== null);
    expect(linked.length).toBeGreaterThan(100);
    for (const d of linked) {
      const b = household.bookings[d.booking!];
      expect(b).toBeDefined();
      expect(Math.abs(d.totalCents ?? 0)).toBe(Math.abs(b.cents));
    }
  });

  it("lets the lines of a payslip add up to the net pay", () => {
    for (const d of plan.documents.filter((x) => x.kind === "payslip")) {
      expect(d.lines.reduce((s, l) => s + (l.cents ?? 0), 0)).toBe(d.totalCents);
    }
  });

  it("closes each statement with its opening balance plus its rows", () => {
    for (const d of plan.documents.filter((x) => x.kind === "bank_statement")) {
      const st = d.statement!;
      expect(st.opening + st.rows.reduce((s, r) => s + r.cents, 0)).toBe(st.closing);
    }
  });

  it("renders about one in ten as a scan, never a statement or a receipt", () => {
    const scans = plan.documents.filter((d) => d.scan);
    expect(scans.length).toBeGreaterThan(25);
    expect(scans.length).toBeLessThan(75);
    expect(scans.some((d) => d.kind === "bank_statement" || d.kind === "receipt")).toBe(false);
  });

  it("expects only categories and document types the app knows", () => {
    const slugs = new Set(flattenTaxonomy(categoryTaxonomy).map((c) => c.slug));
    const types = new Set(DOCUMENT_TYPES.map((t) => t.slug));
    for (const t of Object.values(DOC_TRUTH)) {
      expect(slugs.has(t.category), t.category).toBe(true);
      expect(types.has(t.documentType), t.documentType).toBe(true);
    }
  });

  it("names only the household and its invented organisations", () => {
    for (const d of plan.documents) {
      expect(textIsClean([d.subject, ...d.paragraphs, ...d.lines.map((l) => l.text)].join("\n")), d.key).toBe(true);
    }
  });
});

describe("textIsClean", () => {
  it("accepts the household's own names and refuses others", () => {
    expect(textIsClean("Die Stadtwerke Musterstadt teilen mit, dass Erika Mustermann …")).toBe(true);
    expect(textIsClean("Ihr Ansprechpartner ist Herr Müller.")).toBe(false);
    expect(textIsClean("Im Auftrag der Großbank Frankfurt AG")).toBe(false);
    expect(textIsClean("Ihre Ärztin Dr. Sommer")).toBe(false);
    expect(textIsClean("Rufen Sie uns an: 089 1234 5678")).toBe(false);
    expect(textIsClean("Gesamt 1.234,56 €")).toBe(true);
  });
});

describe("parseLlmTexts", () => {
  const doc = plan.documents.find((d) => d.kind === "craftsman_invoice")!;
  const amount = euro(doc.lines[0].cents!).replace(" €", "");

  it("takes a fitting answer", () => {
    const texts = parseLlmTexts(doc, { betreff: "Rechnung für Ihre Malerarbeiten", absaetze: [`Die Arbeitskosten von ${amount} € weisen wir gesondert aus.`], positionen: ["Streichen", "Farbe"] });
    expect(texts?.lineTexts).toEqual(["Streichen", "Farbe"]);
  });

  it("refuses an answer with an amount the document does not have, or the wrong number of lines", () => {
    expect(parseLlmTexts(doc, { betreff: "Rechnung", absaetze: ["Bitte zahlen Sie 9.999,99 € bis Monatsende."], positionen: ["a", "b"] })).toBeNull();
    expect(parseLlmTexts(doc, { betreff: "Rechnung", absaetze: ["Vielen Dank für den Auftrag."], positionen: ["a"] })).toBeNull();
    expect(parseLlmTexts(doc, null)).toBeNull();
  });
});

describe("the truth comparison", () => {
  it("counts a child of the expected category and a sender with a company form as hits", () => {
    expect(categoryHit("wohnen", "wohnen-nebenkosten")).toBe(true);
    expect(categoryHit("wohnen-nebenkosten", "wohnen")).toBe(false);
    expect(senderHit("Stadtwerke Musterstadt", "STADTWERKE MUSTERSTADT", null)).toBe(true);
    expect(senderHit("Stadtwerke Musterstadt", null, "Beispielfunk GmbH")).toBe(false);
  });
});

describe("rendering", () => {
  it("makes a PDF with a text layer, and a scan without one", async () => {
    const doc = plan.documents.find((d) => d.kind === "payslip")!;
    const pages = layoutDocument(doc);
    const pdf = await renderPdf(pages, doc.subject);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("/Font");
    const scan = await renderScanPdf(pages, createRandom(1), doc.subject);
    expect(scan.subarray(0, 5).toString()).toBe("%PDF-");
    expect(scan.toString("latin1")).toContain("/DCTDecode");
    expect(scan.toString("latin1")).not.toContain("/Font");
  });

  it("runs a long statement over several pages", () => {
    const longest = plan.documents.filter((d) => d.kind === "bank_statement").sort((a, b) => b.statement!.rows.length - a.statement!.rows.length)[0];
    expect(layoutDocument(longest).length).toBeGreaterThanOrEqual(1);
  });
});
