import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Regression test for the production bug: a 1997 Jahresdepotauszug crashed
// runClassify with a Postgres CHECK-constraint violation
// ("documents_tax_year_range") on the UPDATE, even after the app-level
// bounds in llm-client.ts/main.py were widened to 1970 — the DB-level
// constraint (migration 0029) was still 2000..2100 until migration 0140.
// This test exercises the real DB constraint end-to-end, so a future
// re-narrowing of either bound would fail loudly here instead of only
// surfacing in production logs.
const AI = {
  category_slug: "finanzen-wertpapiere",
  title: "Jahresdepotauszug FT-Investmentkonto",
  doc_date: "1997-09-30",
  sender: "FRANKFURT-TRUST",
  document_number: "782/23724459/23",
  summary: "Jahresdepotauszug für Investmentkonto mit Ertragsthesaurierung.",
  confidence: 0.95,
  tags: [] as string[],
  document_type: "abrechnung",
  document_type_confidence: 0.95,
  tax_relevant: true,
  tax_year: 1997,
  tax_year_confidence: 0.95,
  tax_sections: [{ slug: "anlage-kap", confidence: 0.95 }],
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

const USER_ID = 990500;
const DOC_ID = 990590;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedDoc(text: string): Promise<void> {
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

beforeEach(async () => {
  await ensureUser(USER_ID);
  await db.insert(documentCategories).values({ slug: "finanzen-wertpapiere", name: "Wertpapiere & Dividenden" }).onConflictDoNothing();
});

describe("runClassify — historical tax_year (DB constraint regression)", () => {
  it("persists a 1997 tax_year without violating the DB check constraint", async () => {
    await seedDoc(
      "FRANKFURT-TRUST Jahresdepotauszug für Investmentkonto, Stand 30.09.1997, " +
        "Ertragsthesaurierung, Hinweis auf bevorstehende Jahressteuerbescheinigung.",
    );

    await runClassify(DOC_ID);

    const doc = await readDoc();
    expect(doc.status).toBe("ready");
    expect(doc.last_error).toBeNull();
    expect(doc.tax_year).toBe(1997);
    expect(doc.tax_relevant).toBe(true);
  });
});
