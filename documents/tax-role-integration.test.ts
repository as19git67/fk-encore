import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// End-to-end through runClassify (documentation/plans/steuer-belegrolle.md):
// the model calls a school report evidence for Anlage Kind, the evidence
// matrix makes it a Bezug; the user's repeated "Bezug" on the bank's
// Erträgnisaufstellung is learned per sender and document type.
const AI = {
  category_slug: "familie-schule",
  title: "Jahreszeugnis",
  doc_date: "2025-07-25",
  sender: "Mustergymnasium",
  document_number: null as string | null,
  summary: "Zeugnis",
  confidence: 0.95,
  tags: [] as string[],
  document_type: "urkunde" as string | null,
  document_type_confidence: 0.9,
  tax_relevant: true,
  tax_role: "beleg" as "beleg" | "bezug" | "keine",
  tax_year: 2025 as number | null,
  tax_year_confidence: 0.8,
  tax_sections: [{ slug: "anlage-kind", confidence: 0.9 }],
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
const PRIOR_IDS = [990591, 990592];

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedDoc(
  id: number,
  text: string,
  extra: { sender?: string; document_type?: string; tax_role?: string; tax_reviewed?: boolean } = {},
): Promise<void> {
  await db.delete(documentTaxSections).where(eq(documentTaxSections.document_id, id));
  await db.delete(documents).where(eq(documents.id, id));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, attributes_reviewed, tax_reviewed, sender, document_type,
           tax_role, tax_relevant)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${id}.pdf`}, 'classifying', ${text}, false,
           ${extra.tax_reviewed ?? false}, ${extra.sender ?? null}, ${extra.document_type ?? null},
           ${extra.tax_role ?? "keine"}, ${extra.tax_role === "beleg"})`,
  );
}

async function readDoc(id: number) {
  return (await db.select().from(documents).where(eq(documents.id, id)))[0]!;
}

async function readTaxSlugs(id: number): Promise<string[]> {
  const rows = await db
    .select({ slug: documentTaxSections.tax_section })
    .from(documentTaxSections)
    .where(eq(documentTaxSections.document_id, id));
  return rows.map((r) => r.slug);
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  for (const slug of ["familie-schule", "finanzen-wertpapiere"]) {
    await db.insert(documentCategories).values({ slug, name: slug }).onConflictDoNothing();
  }
  for (const id of PRIOR_IDS) {
    await db.delete(documentTaxSections).where(eq(documentTaxSections.document_id, id));
    await db.delete(documents).where(eq(documents.id, id));
  }
});

describe("runClassify — tax role", () => {
  it("makes a school report (urkunde) a Bezug for Anlage Kind and keeps the section", async () => {
    await seedDoc(DOC_ID, "Jahreszeugnis der Klasse 7b. Schuljahr 2024/2025.");
    await runClassify(DOC_ID);

    const row = await readDoc(DOC_ID);
    expect(row.tax_role).toBe("bezug");
    expect(row.tax_relevant).toBe(false);
    expect(row.tax_year).toBe(2025);
    expect(await readTaxSlugs(DOC_ID)).toEqual(["anlage-kind"]);
  });

  it("keeps a Kindergeldbescheid (bescheid) as Beleg", async () => {
    AI.document_type = "bescheid";
    AI.title = "Bescheid über Kindergeld";
    try {
      await seedDoc(DOC_ID, "Familienkasse — Bescheid über Kindergeld. Kindergeldnummer 000FK000000.");
      await runClassify(DOC_ID);
      const row = await readDoc(DOC_ID);
      expect(row.tax_role).toBe("beleg");
      expect(row.tax_relevant).toBe(true);
    } finally {
      AI.document_type = "urkunde";
      AI.title = "Jahreszeugnis";
    }
  });

  it("applies the user's repeated Bezug for the same sender and document type", async () => {
    AI.sender = "Musterbank AG";
    AI.document_type = "bescheinigung"; // the model's type would pass the KAP matrix
    AI.category_slug = "finanzen-wertpapiere";
    AI.tax_sections = [{ slug: "anlage-kap", confidence: 0.9 }];
    try {
      for (const id of PRIOR_IDS) {
        await seedDoc(id, "Jahresübersicht", {
          sender: "Musterbank AG",
          document_type: "bescheinigung",
          tax_role: "bezug",
          tax_reviewed: true,
        });
      }
      await seedDoc(DOC_ID, "Jahresübersicht zu Ihrem Konto. Kontoauszug 12/2025.");
      await runClassify(DOC_ID);

      const row = await readDoc(DOC_ID);
      expect(row.tax_role).toBe("bezug");
      expect(row.tax_relevant).toBe(false);
      expect(await readTaxSlugs(DOC_ID)).toEqual(["anlage-kap"]);
    } finally {
      AI.sender = "Mustergymnasium";
      AI.document_type = "urkunde";
      AI.category_slug = "familie-schule";
      AI.tax_sections = [{ slug: "anlage-kind", confidence: 0.9 }];
    }
  });
});
