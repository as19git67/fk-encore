import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// The classifier always guesses the generic "finanzen-rechnungen" bucket with a
// fixed sender, so any deviation in the stored category proves the learned
// per-user override fired.
// A sender deliberately NOT covered by any hand-authored rule in sender-rules.ts,
// so the only thing that can move the category off the LLM guess is the learned
// per-user memory.
const SENDER = "Testabsender Alpha";

const AI = {
  category_slug: "finanzen-rechnungen",
  title: "AI Titel",
  doc_date: "2024-01-02",
  sender: SENDER,
  document_number: null as string | null,
  summary: "AI Zusammenfassung",
  confidence: 0.4, // low, so we can also assert the confidence bump
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

// runClassify fires realtime + push notifications; stub the Encore client so the
// low-confidence branch doesn't crash on a missing service in the test harness.
vi.mock("~encore/clients", () => ({
  realtime: { publishEvent: vi.fn(async () => {}) },
  push: { notifyDocumentReview: vi.fn(async () => {}) },
}));

import db from "../db/database";
import { documentCategories, documents } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990200;
const NEW_DOC = 990290;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function categoryId(slug: string, name: string): Promise<number> {
  await db
    .insert(documentCategories)
    .values({ slug, name })
    .onConflictDoNothing();
  const row = (
    await db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, slug))
  )[0]!;
  return row.id;
}

async function seedReviewed(id: number, sender: string, catId: number): Promise<void> {
  await db.delete(documents).where(eq(documents.id, id));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, sender, category_id, extracted_text, attributes_reviewed)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${id}.pdf`}, 'ready', ${sender}, ${catId},
           'irgendein text', true)`,
  );
}

async function seedNewDoc(): Promise<void> {
  await db.delete(documents).where(eq(documents.id, NEW_DOC));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, attributes_reviewed)
        VALUES
          (${NEW_DOC}, ${USER_ID}, ${`sha-${NEW_DOC}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${NEW_DOC}.pdf`}, 'classifying', 'neuer text von comdirect', false)`,
  );
}

async function readNew() {
  return (await db.select().from(documents).where(eq(documents.id, NEW_DOC)))[0]!;
}

let rechnungenId: number;
let learnedTargetId: number;

beforeEach(async () => {
  await ensureUser(USER_ID);
  rechnungenId = await categoryId("finanzen-rechnungen", "Rechnungen");
  // A learned target unrelated to the sender rules and to the LLM guess.
  learnedTargetId = await categoryId("familie-schule", "Schule");
  // Clean prior reviewed docs for this user so support counts are deterministic.
  await db.delete(documents).where(eq(documents.user_id, USER_ID));
});

describe("runClassify — learned per-user category override", () => {
  it("overrides the LLM category once >=3 reviewed docs of the sender agree", async () => {
    await seedReviewed(990201, SENDER, learnedTargetId);
    await seedReviewed(990202, SENDER, learnedTargetId);
    await seedReviewed(990203, SENDER, learnedTargetId);
    await seedNewDoc();

    const res = await runClassify(NEW_DOC);

    const row = await readNew();
    expect(row.category_id).toBe(learnedTargetId); // learned, not finanzen-rechnungen
    // Learned decision is treated as confident → no low-confidence review.
    expect("lowConfidence" in res && res.lowConfidence).toBe(false);
    expect(row.classification_confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the LLM category below the support threshold (only 2 reviewed)", async () => {
    await seedReviewed(990201, SENDER, learnedTargetId);
    await seedReviewed(990202, SENDER, learnedTargetId);
    await seedNewDoc();

    await runClassify(NEW_DOC);

    const row = await readNew();
    expect(row.category_id).toBe(rechnungenId); // no override
  });
});
