import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// The classifier marks a private-pension document as tax-relevant with an
// anlage-av section — exactly the false positive the audit surfaced. The
// deterministic rule must strip it when the text is mere admin mail, and keep
// it when the text is an actual certificate.
const AI = {
  category_slug: "altersvorsorge-rentenversicherung",
  title: "Mitteilung zur Rentenversicherung",
  doc_date: "2024-06-01",
  sender: "Heidelberger Lebensversicherung AG",
  document_number: null as string | null,
  summary: "Mitteilung",
  confidence: 0.95,
  tags: [] as string[],
  tax_relevant: true,
  tax_year: 2024,
  tax_year_confidence: 0.8,
  tax_sections: [{ slug: "anlage-av", confidence: 0.95 }],
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

const USER_ID = 990400;
const DOC_ID = 990490;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedDoc(text: string): Promise<void> {
  await db.delete(documentTaxSections).where(eq(documentTaxSections.document_id, DOC_ID));
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, attributes_reviewed, tax_reviewed)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying', ${text}, false, false)`,
  );
}

async function readDoc() {
  return (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
}

async function readTaxSlugs(): Promise<string[]> {
  const rows = await db
    .select({ slug: documentTaxSections.tax_section })
    .from(documentTaxSections)
    .where(eq(documentTaxSections.document_id, DOC_ID));
  return rows.map((r) => r.slug);
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  await db.insert(documentCategories).values({ slug: "altersvorsorge-rentenversicherung", name: "Private Rentenversicherung" }).onConflictDoNothing();
});

describe("runClassify — deterministic insurance-admin tax rule", () => {
  it("strips anlage-av and clears tax_relevant for a Riester Erhöhungsnachtrag", async () => {
    await seedDoc(
      "Erhöhungsnachtrag zu Ihrer fondsgebundenen Rentenversicherung. " +
        "Anpassung des Beitrags im Rahmen der vereinbarten Dynamik. Kein steuerlicher Beleg.",
    );
    await runClassify(DOC_ID);

    expect((await readDoc()).tax_relevant).toBe(false);
    expect(await readTaxSlugs()).not.toContain("anlage-av");
  });

  it("keeps anlage-av for a genuine §92 Zulagenbescheinigung", async () => {
    await seedDoc(
      "Zulagenbescheinigung nach § 92 EStG über die für das Beitragsjahr gewährten " +
        "Altersvorsorgezulagen zu Ihrem Riester-Vertrag.",
    );
    await runClassify(DOC_ID);

    expect((await readDoc()).tax_relevant).toBe(true);
    expect(await readTaxSlugs()).toContain("anlage-av");
  });
});
