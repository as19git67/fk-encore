import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

/**
 * Nothing validates the category slug the model returns — llm-client only
 * checks that it is a non-empty string. Before this guard, an invented slug
 * resolved to no category row and was written straight through as
 * `category_id = NULL`, wiping whatever category the document already had.
 *
 * That is not a hypothetical: the 2026-08-23 Gemma scoreboard reported six
 * reference documents as "not found in the DB". They were there — they just had
 * no category any more, and the scoreboard's INNER JOIN dropped them.
 */
const RESPONSE = {
  category_slug: "erfundene-kategorie-die-es-nicht-gibt",
  title: "AI Titel",
  doc_date: null as string | null,
  sender: null as string | null,
  document_number: null as string | null,
  summary: "AI Zusammenfassung",
  confidence: 0.9,
  tags: [] as string[],
  tax_relevant: false,
  tax_year: null,
  tax_year_confidence: null,
  tax_sections: [] as { slug: string; confidence: number }[],
};

vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => RESPONSE),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents, documentCategories } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990307;
const DOC_ID = 990307;

/** The test database starts without a taxonomy, so seed just what is needed. */
async function ensureCategory(slug: string, name: string): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug, name })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function seedDocument(initialCategoryId: number | null): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, category_id)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying', 'irgendein extrahierter Text',
           ${initialCategoryId})`,
  );
}

async function readDoc() {
  return (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
}

let sonstigesId = 0;
let arztId = 0;

beforeEach(async () => {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  sonstigesId = await ensureCategory("sonstiges", "Sonstiges");
  arztId = await ensureCategory("gesundheit-arzt", "Arzt");
});

describe("runClassify — unknown category slug", () => {
  it("keeps the previous category instead of wiping it", async () => {
    await seedDocument(arztId);

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_id).toBe(arztId);
    // The rest of the classification still lands — only the label is rejected.
    expect(row.title).toBe("AI Titel");
    expect(row.status).toBe("ready");
  });

  it("falls back to sonstiges when there was no previous category", async () => {
    await seedDocument(null);

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.category_id).toBe(sonstigesId);
    expect(row.status).toBe("ready");
  });

  it("never leaves the document without a category", async () => {
    await seedDocument(null);

    await runClassify(DOC_ID);

    // A categoryless document disappears from every category-joined query,
    // which is how the six documents went missing from the scoreboard.
    expect((await readDoc()).category_id).not.toBeNull();
  });
});
