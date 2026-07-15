import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const AI = {
  category_slug: "sonstiges",
  title: "Einnahmenüberschussrechnung Landwirtschaft 2024/2025",
  doc_date: "2025-06-30",
  sender: null as string | null,
  document_number: null as string | null,
  summary: "Gewinnermittlung für ein landwirtschaftliches Wirtschaftsjahr.",
  confidence: 0.9,
  tags: [] as string[],
  tax_relevant: true,
  tax_year: 2025,
  tax_year_confidence: 0.86,
  tax_sections: [
    { slug: "anlage-l", confidence: 0.95 },
    { slug: "anlage-euer", confidence: 0.92 },
  ],
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

const USER_ID = 990600;
const DOC_ID = 990690;

beforeEach(async () => {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
  await db
    .insert(documentCategories)
    .values({ slug: "sonstiges", name: "Sonstiges" })
    .onConflictDoNothing();
  await db.delete(documentTaxSections).where(eq(documentTaxSections.document_id, DOC_ID));
  await db.delete(documents).where(eq(documents.id, DOC_ID));
});

describe("runClassify — shifted agriculture fiscal year", () => {
  it("persists the starting year instead of the LLM's ending year", async () => {
    await db.execute(sql`
      INSERT INTO documents
        (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
         status, extracted_text, attributes_reviewed, tax_reviewed)
      VALUES
        (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'euer.pdf', 'application/pdf', 1,
         ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying',
         'Einnahmenüberschussrechnung für das Geschäftsjahr 01.07.2024 bis 30.06.2025',
         false, false)
    `);

    await runClassify(DOC_ID);

    const document = (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
    expect(document.tax_year).toBe(2024);
    expect(document.tax_year_confidence).toBe(0.99);
    expect(document.tax_relevant).toBe(true);
  });
});
