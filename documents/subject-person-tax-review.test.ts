import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// The classifier always returns a personal-deduction tax section
// ("haushaltsnahe") so the only variable under test is whether the
// matched subject person opted into tax review (0137).
vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => ({
    category_slug: "sonstiges",
    title: "T",
    doc_date: null,
    sender: null,
    document_number: null,
    summary: null,
    confidence: 0.9,
    tags: [] as string[],
    tax_relevant: true,
    tax_year: 2024,
    tax_year_confidence: 0.9,
    tax_sections: [{ slug: "haushaltsnahe", confidence: 0.9 }],
  })),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents, userSubjectPersons } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990301;
const DOC_ID_A = 990301;
const DOC_ID_B = 990302;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function addPerson(fullName: string, relation: string, requiresTaxReview: boolean): Promise<number> {
  const [row] = await db
    .insert(userSubjectPersons)
    .values({
      user_id: USER_ID,
      full_name: fullName,
      relation_tag: relation,
      requires_tax_review: requiresTaxReview,
    })
    .returning({ id: userSubjectPersons.id });
  return row!.id;
}

async function insertDoc(id: number, text: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${id}.pdf`}, 'classifying', ${text})`,
  );
}

async function taxReviewNeeded(id: number): Promise<boolean> {
  const row = await db.execute<{ tax_review_needed: boolean }>(
    sql`SELECT tax_review_needed FROM documents WHERE id = ${id}`,
  );
  return row.rows[0]!.tax_review_needed;
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID_A));
  await db.delete(documents).where(eq(documents.id, DOC_ID_B));
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  await ensureUser(USER_ID);
});

describe("runClassify — subject-person tax review is opt-in (0137)", () => {
  it("does not flag a document for a subject person that is not opted in", async () => {
    await addPerson("Anna Muster", "ehefrau", false);
    await insertDoc(DOC_ID_A, "Rechnung für Anna Muster, Pflegeleistungen.");

    await runClassify(DOC_ID_A);

    expect(await taxReviewNeeded(DOC_ID_A)).toBe(false);
  });

  it("flags a document for a subject person that opted into tax review", async () => {
    await addPerson("Maria Schegg", "mutter", true);
    await insertDoc(DOC_ID_B, "Rechnung für Maria Schegg, Pflegeleistungen.");

    await runClassify(DOC_ID_B);

    expect(await taxReviewNeeded(DOC_ID_B)).toBe(true);
  });
});
