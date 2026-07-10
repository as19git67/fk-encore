import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// The classifier returns the sender + category a real Heidelberger Riester
// status report would get WRONG: sender "Heidelberger Lebensversicherung AG"
// (which the sender rule forces to altersvorsorge-lebensversicherung) while the
// text carries an unambiguous Riester marker. The content rule must win.
const AI = {
  category_slug: "altersvorsorge-lebensversicherung",
  title: "Statusreport Heidelberger Lebensversicherung",
  doc_date: "2024-06-01",
  sender: "Heidelberger Lebensversicherung AG",
  document_number: null as string | null,
  summary: "Statusreport",
  confidence: 0.95,
  tags: [] as string[],
  tax_relevant: false,
  tax_year: null,
  tax_year_confidence: null,
  tax_sections: [] as { slug: string; confidence: number }[],
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
import { documentCategories, documents } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990300;
const DOC_ID = 990390;

const RIESTER_TEXT =
  "MLP balanced invest — staatlich geförderte Riester-Rentenversicherung. " +
  "Zulagenbescheinigung nach § 92 EStG mit Grundzulage und Kinderzulage.";

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function categoryId(slug: string, name: string): Promise<number> {
  await db.insert(documentCategories).values({ slug, name }).onConflictDoNothing();
  return (
    await db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, slug))
  )[0]!.id;
}

async function seedDoc(text: string): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, attributes_reviewed)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying', ${text}, false)`,
  );
}

async function readCatSlug(): Promise<string | null> {
  const row = (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
  if (row.category_id == null) return null;
  const c = (await db.select().from(documentCategories).where(eq(documentCategories.id, row.category_id)))[0];
  return c?.slug ?? null;
}

let lebenId: number;
let rentenId: number;

beforeEach(async () => {
  await ensureUser(USER_ID);
  lebenId = await categoryId("altersvorsorge-lebensversicherung", "Kapital-Lebensversicherung");
  rentenId = await categoryId("altersvorsorge-rentenversicherung", "Private Rentenversicherung");
});

describe("runClassify — content rule beats the sender rule", () => {
  it("routes a Heidelberger Riester report to Rentenversicherung, not the sender-rule Lebensversicherung", async () => {
    await seedDoc(RIESTER_TEXT);
    await runClassify(DOC_ID);
    expect(await readCatSlug()).toBe("altersvorsorge-rentenversicherung");
    expect(rentenId).not.toBe(lebenId);
  });

  it("leaves a genuine Kapital-Lebensversicherung from the same sender alone", async () => {
    // No Riester marker → content rule does not fire → sender rule keeps it.
    await seedDoc("Kapital-Lebensversicherung mit Ablaufleistung, Rückkaufswert und Deckungskapital.");
    await runClassify(DOC_ID);
    expect(await readCatSlug()).toBe("altersvorsorge-lebensversicherung");
  });
});
