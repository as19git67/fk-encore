import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents, documentSubjectPersons, userSubjectPersons } from "../db/schema";
import { syncTaxReviewFlagForSubjectPerson } from "./documents";

const USER_ID = 990401;
const DOC_ID = 990401;
const OTHER_DOC_ID = 990402;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function addPerson(fullName: string, relation: string): Promise<number> {
  const [row] = await db
    .insert(userSubjectPersons)
    .values({ user_id: USER_ID, full_name: fullName, relation_tag: relation })
    .returning({ id: userSubjectPersons.id });
  return row!.id;
}

/** In production, updateSubjectPersonEndpoint writes this column via
 *  updateSubjectPerson() *before* calling syncTaxReviewFlagForSubjectPerson —
 *  the sync's opt-out branch reads it back to decide whether another
 *  Bezugsperson on the same document still justifies the flag. */
async function setRequiresTaxReview(personId: number, value: boolean): Promise<void> {
  await db.execute(
    sql`UPDATE user_subject_persons SET requires_tax_review = ${value} WHERE id = ${personId}`,
  );
}

async function insertDoc(id: number, opts: { taxReviewed?: boolean } = {}): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, tax_reviewed)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${id}.pdf`}, 'ready', ${opts.taxReviewed ?? false})`,
  );
}

async function linkPerson(documentId: number, personId: number): Promise<void> {
  await db
    .insert(documentSubjectPersons)
    .values({ document_id: documentId, subject_person_id: personId, source: "ai" });
}

async function addTaxSection(documentId: number, slug: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO document_tax_sections (document_id, tax_section, confidence, source)
        VALUES (${documentId}, ${slug}, 0.9, 'ai')`,
  );
}

async function taxReviewNeeded(id: number): Promise<boolean> {
  const [row] = await db
    .select({ v: documents.tax_review_needed })
    .from(documents)
    .where(eq(documents.id, id));
  return row!.v;
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID)); // cascades links/sections
  await db.delete(documents).where(eq(documents.id, OTHER_DOC_ID));
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  await ensureUser(USER_ID);
});

describe("documents.syncTaxReviewFlagForSubjectPerson", () => {
  it("retroactively flags existing documents when opted in", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, true);

    expect(await taxReviewNeeded(DOC_ID)).toBe(true);
  });

  it("does not flag a tax_reviewed (user-pinned) document", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    await insertDoc(DOC_ID, { taxReviewed: true });
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, true);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("does not flag a document without a personal-deduction tax section", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "anlage-r"); // income section, not a personal deduction

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, true);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("clears the flag on opt-out", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, true);
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, false);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("keeps the flag on opt-out when another opted-in person still matches", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    const vater = await addPerson("Anton Schegg", "vater");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await linkPerson(DOC_ID, vater);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await setRequiresTaxReview(mutter, true);
    await setRequiresTaxReview(vater, true);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, true);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, vater, true);
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);

    await setRequiresTaxReview(mutter, false);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter, false);

    // Anton is still opted in and still linked — the flag must survive.
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);
  });

  it("does not touch another user's documents", async () => {
    const mutter = await addPerson("Maria Schegg", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID + 1, mutter, true);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });
});
