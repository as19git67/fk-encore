import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documents, documentSubjectPersons, userSubjectPersons } from "../db/schema";
import { syncOwnTaxReturnAssignment, syncTaxReviewFlagForSubjectPerson } from "./documents";

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

async function addPerson(
  fullName: string,
  relation: string,
  extra: {
    relation_kind?: "self" | "spouse" | "child" | "parent" | "sibling" | "ward" | "other";
    birth_date?: string | null;
    in_household?: boolean;
    own_tax_return_from_tax_year?: number | null;
  } = {},
): Promise<number> {
  const [row] = await db
    .insert(userSubjectPersons)
    .values({
      user_id: USER_ID,
      full_name: fullName,
      relation_tag: relation,
      relation_kind: extra.relation_kind ?? "other",
      birth_date: extra.birth_date ?? null,
      in_household: extra.in_household ?? false,
      own_tax_return_from_tax_year: extra.own_tax_return_from_tax_year ?? null,
    })
    .returning({ id: userSubjectPersons.id });
  return row!.id;
}

/** In production, updateSubjectPersonEndpoint writes this column via
 *  updateSubjectPerson() *before* calling syncTaxReviewFlagForSubjectPerson —
 *  the sync reads it back to decide whether another Bezugsperson on the same
 *  document still justifies the flag. */
async function setRequiresTaxReview(personId: number, value: boolean): Promise<void> {
  await db.execute(
    sql`UPDATE user_subject_persons SET requires_tax_review = ${value} WHERE id = ${personId}`,
  );
}

/** The manual override (NULL = follow the derived default). */
async function setOverride(personId: number, value: boolean | null): Promise<void> {
  await db.execute(
    sql`UPDATE user_subject_persons SET requires_tax_review_override = ${value} WHERE id = ${personId}`,
  );
}

async function insertDoc(
  id: number,
  opts: { taxReviewed?: boolean; taxYear?: number | null; taxRelevant?: boolean } = {},
): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, tax_reviewed, tax_year, tax_relevant)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${id}.pdf`}, 'ready', ${opts.taxReviewed ?? false},
           ${opts.taxYear ?? null}, ${opts.taxRelevant ?? false})`,
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

async function taxReturnPersonId(id: number): Promise<number | null> {
  const [row] = await db
    .select({ v: documents.tax_return_person_id })
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
  it("retroactively flags existing documents when the derivation says review", async () => {
    // relation_kind 'other' derives requires_tax_review = true.
    const mutter = await addPerson("Maria Beispiel", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);

    expect(await taxReviewNeeded(DOC_ID)).toBe(true);
  });

  it("does not flag a tax_reviewed (user-pinned) document", async () => {
    const mutter = await addPerson("Maria Beispiel", "mutter");
    await insertDoc(DOC_ID, { taxReviewed: true });
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("does not flag a document without a personal-deduction tax section", async () => {
    const mutter = await addPerson("Maria Beispiel", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "anlage-r"); // income section, not a personal deduction

    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("clears the flag on opt-out", async () => {
    const mutter = await addPerson("Maria Beispiel", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);

    await setOverride(mutter, false);
    await setRequiresTaxReview(mutter, false);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  it("keeps the flag on opt-out when another opted-in person still matches", async () => {
    const mutter = await addPerson("Maria Beispiel", "mutter");
    const vater = await addPerson("Anton Beispiel", "vater");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await linkPerson(DOC_ID, vater);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await setRequiresTaxReview(mutter, true);
    await setRequiresTaxReview(vater, true);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);

    await setOverride(mutter, false);
    await setRequiresTaxReview(mutter, false);
    await syncTaxReviewFlagForSubjectPerson(USER_ID, mutter);

    // Anton is still opted in and still linked — the flag must survive.
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);
  });

  it("does not touch another user's documents", async () => {
    const mutter = await addPerson("Maria Beispiel", "mutter");
    await insertDoc(DOC_ID);
    await linkPerson(DOC_ID, mutter);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID + 1, mutter);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });

  // ── Per-tax-year decisions (migration 0146) ───────────────────────────────

  it("decides per document tax year for an aging child in the household", async () => {
    // Born 1998: in tax year 2020 the child is 22 (under the limit → no
    // review), in 2024 it is 26 (over the limit → review).
    const kind = await addPerson("Kim Beispiel", "kind", {
      relation_kind: "child",
      birth_date: "1998-05-04",
      in_household: true,
    });
    await insertDoc(DOC_ID, { taxYear: 2020 });
    await linkPerson(DOC_ID, kind);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await insertDoc(OTHER_DOC_ID, { taxYear: 2024 });
    await linkPerson(OTHER_DOC_ID, kind);
    await addTaxSection(OTHER_DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, kind);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
    expect(await taxReviewNeeded(OTHER_DOC_ID)).toBe(true);
  });

  it("never flags documents from years the person files their own return", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      relation_kind: "other", // would derive review=true
      own_tax_return_from_tax_year: 2023,
    });
    await insertDoc(DOC_ID, { taxYear: 2022 });
    await linkPerson(DOC_ID, kind);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await insertDoc(OTHER_DOC_ID, { taxYear: 2023 });
    await linkPerson(OTHER_DOC_ID, kind);
    await addTaxSection(OTHER_DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, kind);

    // 2022 predates the own return — still the user's business.
    expect(await taxReviewNeeded(DOC_ID)).toBe(true);
    // 2023 belongs to the person's own Steuerakte.
    expect(await taxReviewNeeded(OTHER_DOC_ID)).toBe(false);
  });

  it("lets the own-return cutoff win over a manual review override", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    await setOverride(kind, true);
    await insertDoc(DOC_ID, { taxYear: 2024 });
    await linkPerson(DOC_ID, kind);
    await addTaxSection(DOC_ID, "haushaltsnahe");

    await syncTaxReviewFlagForSubjectPerson(USER_ID, kind);

    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });
});

describe("documents.syncOwnTaxReturnAssignment", () => {
  it("assigns tax documents from the own-return years to the person", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    await insertDoc(DOC_ID, { taxYear: 2024, taxRelevant: true });
    await linkPerson(DOC_ID, kind);
    await insertDoc(OTHER_DOC_ID, { taxYear: 2022, taxRelevant: true });
    await linkPerson(OTHER_DOC_ID, kind);

    await syncOwnTaxReturnAssignment(USER_ID, kind, 2023);

    expect(await taxReturnPersonId(DOC_ID)).toBe(kind);
    expect(await taxReturnPersonId(OTHER_DOC_ID)).toBeNull();
  });

  it("releases the documents when the own-return setting is removed", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    await insertDoc(DOC_ID, { taxYear: 2024, taxRelevant: true });
    await linkPerson(DOC_ID, kind);
    await syncOwnTaxReturnAssignment(USER_ID, kind, 2023);
    expect(await taxReturnPersonId(DOC_ID)).toBe(kind);

    await db.execute(
      sql`UPDATE user_subject_persons SET own_tax_return_from_tax_year = NULL WHERE id = ${kind}`,
    );
    await syncOwnTaxReturnAssignment(USER_ID, kind, null);

    expect(await taxReturnPersonId(DOC_ID)).toBeNull();
  });

  it("does not assign a document that is not tax-relevant or has no tax year", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    await insertDoc(DOC_ID, { taxYear: 2024, taxRelevant: false });
    await linkPerson(DOC_ID, kind);
    await insertDoc(OTHER_DOC_ID, { taxYear: null, taxRelevant: true });
    await linkPerson(OTHER_DOC_ID, kind);

    await syncOwnTaxReturnAssignment(USER_ID, kind, 2023);

    expect(await taxReturnPersonId(DOC_ID)).toBeNull();
    expect(await taxReturnPersonId(OTHER_DOC_ID)).toBeNull();
  });

  it("leaves the assignment open when two own-return persons share a document", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    const zweit = await addPerson("Alex Beispiel", "zweitkind", {
      own_tax_return_from_tax_year: 2020,
    });
    await insertDoc(DOC_ID, { taxYear: 2024, taxRelevant: true });
    await linkPerson(DOC_ID, kind);
    await linkPerson(DOC_ID, zweit);

    await syncOwnTaxReturnAssignment(USER_ID, kind, 2023);

    expect(await taxReturnPersonId(DOC_ID)).toBeNull();
  });

  it("clears a stale review flag when the document moves into the Steuerakte", async () => {
    const kind = await addPerson("Kim Beispiel", "kind", {
      own_tax_return_from_tax_year: 2023,
    });
    await insertDoc(DOC_ID, { taxYear: 2024, taxRelevant: true });
    await linkPerson(DOC_ID, kind);
    await addTaxSection(DOC_ID, "haushaltsnahe");
    await db.execute(sql`UPDATE documents SET tax_review_needed = true WHERE id = ${DOC_ID}`);

    await syncOwnTaxReturnAssignment(USER_ID, kind, 2023);

    expect(await taxReturnPersonId(DOC_ID)).toBe(kind);
    expect(await taxReviewNeeded(DOC_ID)).toBe(false);
  });
});
