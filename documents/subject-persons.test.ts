import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";

import db from "../db/database";
import {
  computeEffectiveRequiresTaxReview,
  createSubjectPerson,
  deleteSubjectPerson,
  deriveRequiresTaxReview,
  hasOwnTaxReturn,
  listSubjectPersons,
  loadSubjectPersonsForMatch,
  normaliseRelationTag,
  updateSubjectPerson,
} from "./subject-persons";

const TEST_USER_ID = 92_001;
const OTHER_USER_ID = 92_002;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@subject-persons.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM user_subject_persons WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(
    sql`DELETE FROM users WHERE id IN (${TEST_USER_ID}, ${OTHER_USER_ID})`,
  );
}

describe("documents.subject-persons normaliseRelationTag", () => {
  it("lowercases and replaces inner whitespace with a single hyphen", () => {
    expect(normaliseRelationTag("Mutter")).toBe("mutter");
    expect(normaliseRelationTag("  Schwieger   Vater  ")).toBe("schwieger-vater");
  });

  it("preserves German umlauts and ß and drops other punctuation", () => {
    expect(normaliseRelationTag("Mütter & Söhne!")).toBe("mütter-söhne");
    expect(normaliseRelationTag("eltern-fuß")).toBe("eltern-fuß");
  });

  it("caps the result at 40 characters", () => {
    const long = "a".repeat(80);
    expect(normaliseRelationTag(long).length).toBe(40);
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(normaliseRelationTag("   ")).toBe("");
    expect(normaliseRelationTag("###")).toBe("");
  });
});

describe("documents.subject-persons tax review derivation", () => {
  const base = {
    relation_kind: "other" as const,
    in_household: false,
    tax_cost_bearer: "unknown" as const,
    birth_date: null,
    own_tax_return_from_tax_year: null,
  };
  const einzeln = { assessment_type: "einzeln" as const };
  const zusammen = { assessment_type: "zusammen" as const };

  it("never reviews the user themselves or costs the user provably bears", () => {
    expect(deriveRequiresTaxReview({ ...base, relation_kind: "self" }, einzeln)).toBe(false);
    expect(deriveRequiresTaxReview({ ...base, tax_cost_bearer: "user" }, einzeln)).toBe(false);
  });

  it("reviews a spouse only under Einzelveranlagung", () => {
    const spouse = { ...base, relation_kind: "spouse" as const };
    expect(deriveRequiresTaxReview(spouse, zusammen)).toBe(false);
    expect(deriveRequiresTaxReview(spouse, einzeln)).toBe(true);
  });

  it("applies the child age limit against the document's tax year", () => {
    // Born 1998 — under 25 in tax year 2020, over the limit in 2024.
    const kind = {
      ...base,
      relation_kind: "child" as const,
      in_household: true,
      birth_date: "1998-05-04",
    };
    expect(deriveRequiresTaxReview(kind, einzeln, 2020)).toBe(false);
    expect(deriveRequiresTaxReview(kind, einzeln, 2024)).toBe(true);
  });

  it("reviews a child that no longer lives in the household", () => {
    const kind = {
      ...base,
      relation_kind: "child" as const,
      in_household: false,
      birth_date: "2010-01-01",
    };
    expect(deriveRequiresTaxReview(kind, einzeln, 2024)).toBe(true);
  });

  it("hasOwnTaxReturn only covers years from the configured one on", () => {
    const p = { own_tax_return_from_tax_year: 2023 };
    expect(hasOwnTaxReturn(p, 2022)).toBe(false);
    expect(hasOwnTaxReturn(p, 2023)).toBe(true);
    expect(hasOwnTaxReturn(p, 2024)).toBe(true);
    expect(hasOwnTaxReturn({ own_tax_return_from_tax_year: null }, 2024)).toBe(false);
  });

  it("skips review for years the person files their own return", () => {
    const p = { ...base, own_tax_return_from_tax_year: 2023 };
    expect(deriveRequiresTaxReview(p, einzeln, 2022)).toBe(true);
    expect(deriveRequiresTaxReview(p, einzeln, 2023)).toBe(false);
  });

  it("lets a manual override win over the derived default", () => {
    const p = { ...base, requires_tax_review_override: false };
    expect(deriveRequiresTaxReview(p, einzeln)).toBe(true);
    expect(computeEffectiveRequiresTaxReview(p, einzeln)).toBe(false);
  });

  it("lets the own-return cutoff win over a manual override", () => {
    const p = {
      ...base,
      requires_tax_review_override: true,
      own_tax_return_from_tax_year: 2023,
    };
    expect(computeEffectiveRequiresTaxReview(p, einzeln, 2022)).toBe(true);
    expect(computeEffectiveRequiresTaxReview(p, einzeln, 2024)).toBe(false);
  });
});

describe("documents.subject-persons CRUD", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(TEST_USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a subject person and lists it back for the same user", async () => {
    const created = await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "Mutter",
    });
    expect(created.full_name).toBe("Erika Mustermann");
    // relation_tag is normalised to lowercase on the way in.
    expect(created.relation_tag).toBe("mutter");
    // relation_kind defaults to 'other' → deriveRequiresTaxReview returns true.
    expect(created.requires_tax_review).toBe(true);

    const items = await listSubjectPersons(TEST_USER_ID);
    expect(items.map((i) => i.id)).toContain(created.id);
  });

  it("creates a subject person opted into tax review and can toggle it back off", async () => {
    const created = await createSubjectPerson(TEST_USER_ID, {
      full_name: "Maria Beispiel",
      relation_tag: "mutter",
      requires_tax_review: true,
    });
    expect(created.requires_tax_review).toBe(true);

    const { person: toggledOff } = await updateSubjectPerson(TEST_USER_ID, created.id, {
      requires_tax_review: false,
    });
    expect(toggledOff.requires_tax_review).toBe(false);
  });

  it("scopes the list to the calling user", async () => {
    await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
    });
    await createSubjectPerson(OTHER_USER_ID, {
      full_name: "Jemand Anders",
      relation_tag: "fremd",
    });

    const mine = await listSubjectPersons(TEST_USER_ID);
    expect(mine.map((i) => i.full_name)).toEqual(["Erika Mustermann"]);

    const matches = await loadSubjectPersonsForMatch(TEST_USER_ID);
    expect(matches.map((m) => m.full_name)).toEqual(["Erika Mustermann"]);
    // Carries the household attributes runClassify forwards to the classifier.
    expect(matches[0]).toMatchObject({
      relation_tag: "mutter",
      relation_kind: "other",
      tax_cost_bearer: "unknown",
      in_household: false,
    });
  });

  it("rejects duplicate names for the same user (case-insensitive)", async () => {
    await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
    });
    await expect(
      createSubjectPerson(TEST_USER_ID, {
        full_name: "erika mustermann",
        relation_tag: "mama",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("allows the same name across different users", async () => {
    await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
    });
    const other = await createSubjectPerson(OTHER_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "tante",
    });
    expect(other.relation_tag).toBe("tante");
  });

  it("rejects empty full_name", async () => {
    await expect(
      createSubjectPerson(TEST_USER_ID, { full_name: "  ", relation_tag: "mutter" }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("rejects a relation_tag that has no usable characters", async () => {
    await expect(
      createSubjectPerson(TEST_USER_ID, { full_name: "X", relation_tag: "###" }),
    ).rejects.toThrow(/at least one usable character/);
  });

  it("updates an existing entry and refuses to update someone else's", async () => {
    const own = await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
    });
    const other = await createSubjectPerson(OTHER_USER_ID, {
      full_name: "Jemand Anders",
      relation_tag: "fremd",
    });

    const { person: patched } = await updateSubjectPerson(TEST_USER_ID, own.id, {
      relation_tag: "mama",
    });
    expect(patched.relation_tag).toBe("mama");

    await expect(
      updateSubjectPerson(TEST_USER_ID, other.id, { relation_tag: "egal" }),
    ).rejects.toBeInstanceOf(APIError);
  });

  it("deletes only the caller's entry", async () => {
    const own = await createSubjectPerson(TEST_USER_ID, {
      full_name: "Erika Mustermann",
      relation_tag: "mutter",
    });
    const other = await createSubjectPerson(OTHER_USER_ID, {
      full_name: "Jemand Anders",
      relation_tag: "fremd",
    });

    await deleteSubjectPerson(TEST_USER_ID, own.id);
    expect((await listSubjectPersons(TEST_USER_ID)).length).toBe(0);

    await expect(
      deleteSubjectPerson(TEST_USER_ID, other.id),
    ).rejects.toBeInstanceOf(APIError);

    // The other user's row is still there.
    expect((await listSubjectPersons(OTHER_USER_ID)).length).toBe(1);
  });
});
