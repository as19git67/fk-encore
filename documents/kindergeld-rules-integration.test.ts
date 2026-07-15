import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const AI = {
  category_slug: "finanzen-steuern",
  title: "Bescheid über Kindergeld nach dem EStG",
  doc_date: "2025-10-08",
  sender: "Anton Beispiel",
  document_number: "5625",
  summary: "Änderung der Kindergeldfestsetzung",
  confidence: 0.92,
  tags: [] as string[],
  tax_relevant: true,
  tax_year: 2025,
  tax_year_confidence: 0.9,
  tax_sections: [{ slug: "mantelbogen", confidence: 0.9 }],
};

vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => structuredClone(AI)),
  embedTexts: vi.fn(async () => []),
}));

vi.mock("~encore/clients", () => ({
  realtime: { publishEvent: vi.fn(async () => {}) },
  push: { notifyDocumentReview: vi.fn(async () => {}) },
}));

import db from "../db/database";
import { documentCategories, documentTaxSections, documents } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990500;
const DOC_ID = 990590;

const KINDERGELD_TEXT = `
Bundesagentur für Arbeit, Familienkasse Bayern Süd
Ihre Kindergeldnummer: 123 FK 456
Bescheid über Kindergeld nach dem Einkommensteuergesetz (EStG)
Die Festsetzung des Kindergeldes wird gemäß § 70 Absatz 2 EStG geändert.
`;

beforeEach(async () => {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${USER_ID}, 'kindergeld@test.local', 'Kindergeld Test', 'x')
    ON CONFLICT (id) DO NOTHING
  `);
  for (const [slug, name] of [
    ["finanzen-steuern", "Steuern"],
    ["familie-familienleistungen", "Familienleistungen"],
  ] as const) {
    await db.insert(documentCategories).values({ slug, name }).onConflictDoNothing();
  }
  await db.delete(documentTaxSections).where(eq(documentTaxSections.document_id, DOC_ID));
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(sql`
    INSERT INTO documents
      (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, extracted_text, attributes_reviewed, tax_reviewed)
    VALUES
      (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'kindergeld.pdf',
       'application/pdf', 1, ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying',
       ${KINDERGELD_TEXT}, false, false)
  `);
});

describe("runClassify — Kindergeld protection", () => {
  it("routes the notice to Familienleistungen and assigns only Anlage Kind", async () => {
    await runClassify(DOC_ID);

    const document = (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
    const category = (await db
      .select({ slug: documentCategories.slug })
      .from(documentCategories)
      .where(eq(documentCategories.id, document.category_id!)))[0];
    const taxSections = await db
      .select()
      .from(documentTaxSections)
      .where(eq(documentTaxSections.document_id, DOC_ID));

    expect(category?.slug).toBe("familie-familienleistungen");
    expect(document.tax_relevant).toBe(true);
    expect(document.tax_year).toBe(2025);
    expect(taxSections.map((section) => section.tax_section)).toEqual(["anlage-kind"]);
  });
});
