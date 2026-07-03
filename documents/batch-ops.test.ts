import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";

import db from "../db/database";
import {
  batchSetAttributes,
  batchSetSubjectPersons,
  batchSetTax,
} from "./batch-ops";

const USER_ID = 94_001;
const OTHER_USER_ID = 94_002;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@batch-ops.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
/** Insert a private document and return its id. */
async function insertDoc(opts: { userId?: number } = {}): Promise<number> {
  seq += 1;
  const sha = `bo-test-${seq}-${"0".repeat(50)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, visibility)
    VALUES
      (${opts.userId ?? USER_ID}, ${sha}, ${`doc-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/bo-${seq}.pdf`}, 'ready', 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

const TEST_CATEGORY_SLUG = "bo-test-kategorie";

/** The taxonomy seed runs at service startup, not in migrations — create our own. */
async function ensureCategory(): Promise<void> {
  await db.execute(sql`
    INSERT INTO document_categories (slug, name)
    VALUES (${TEST_CATEGORY_SLUG}, 'Batch-Ops Testkategorie')
    ON CONFLICT (slug) DO NOTHING
  `);
}

async function insertSubjectPerson(userId: number, name: string): Promise<number> {
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO user_subject_persons (user_id, full_name, relation_tag)
    VALUES (${userId}, ${name}, ${name.toLowerCase()})
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function docRow(id: number): Promise<Record<string, unknown>> {
  const res = await db.execute<Record<string, unknown>>(
    sql`SELECT * FROM documents WHERE id = ${id}`,
  );
  return res.rows[0]!;
}

async function taxSectionSlugs(id: number): Promise<string[]> {
  const res = await db.execute<{ tax_section: string; source: string }>(
    sql`SELECT tax_section, source FROM document_tax_sections WHERE document_id = ${id} ORDER BY tax_section`,
  );
  return res.rows.map((r) => `${r.tax_section}:${r.source}`);
}

async function subjectPersonLinks(id: number): Promise<string[]> {
  const res = await db.execute<{ subject_person_id: number; source: string }>(
    sql`SELECT subject_person_id, source FROM document_subject_persons WHERE document_id = ${id} ORDER BY subject_person_id`,
  );
  return res.rows.map((r) => `${r.subject_person_id}:${r.source}`);
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM documents WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(
    sql`DELETE FROM user_subject_persons WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  await db.execute(sql`DELETE FROM document_categories WHERE slug = ${TEST_CATEGORY_SLUG}`);
}

describe("documents.batch-ops batchSetAttributes", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
    await ensureUser(OTHER_USER_ID);
    await ensureCategory();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("sets category and doc_date and pins attributes_reviewed", async () => {
    const a = await insertDoc();
    const b = await insertDoc();

    const affected = await batchSetAttributes(USER_ID, [a, b], {
      category_slug: TEST_CATEGORY_SLUG,
      doc_date: "2025-04-01",
    });
    expect(affected).toBe(2);

    for (const id of [a, b]) {
      const row = await docRow(id);
      expect(row.category_id).not.toBeNull();
      expect(row.doc_date).toBe("2025-04-01");
      expect(row.attributes_reviewed).toBe(true);
    }
  });

  it("clears category / doc_date with null", async () => {
    const a = await insertDoc();
    await batchSetAttributes(USER_ID, [a], {
      category_slug: TEST_CATEGORY_SLUG,
      doc_date: "2025-04-01",
    });

    await batchSetAttributes(USER_ID, [a], { category_slug: null, doc_date: null });
    const row = await docRow(a);
    expect(row.category_id).toBeNull();
    expect(row.doc_date).toBeNull();
  });

  it("skips documents the caller cannot see", async () => {
    const mine = await insertDoc();
    const foreign = await insertDoc({ userId: OTHER_USER_ID });

    const affected = await batchSetAttributes(USER_ID, [mine, foreign], {
      doc_date: "2024-12-24",
    });
    expect(affected).toBe(1);
    expect((await docRow(foreign)).doc_date).toBeNull();
  });

  it("rejects an unknown category slug and malformed dates", async () => {
    const a = await insertDoc();
    await expect(
      batchSetAttributes(USER_ID, [a], { category_slug: "no-such-category" }),
    ).rejects.toBeInstanceOf(APIError);
    await expect(
      batchSetAttributes(USER_ID, [a], { doc_date: "2026-13-40" }),
    ).rejects.toBeInstanceOf(APIError);
    await expect(batchSetAttributes(USER_ID, [a], {})).rejects.toBeInstanceOf(APIError);
  });
});

describe("documents.batch-ops batchSetTax", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("marks documents tax-relevant with year and sections, pinning tax_reviewed", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    // Pre-existing AI assignment must be replaced by the human override.
    await db.execute(sql`
      INSERT INTO document_tax_sections (document_id, tax_section, confidence, source)
      VALUES (${a}, 'anlage-v', 0.5, 'ai')
    `);

    const affected = await batchSetTax(USER_ID, [a, b], {
      tax_relevant: true,
      tax_year: 2024,
      tax_sections: ["anlage-n"],
    });
    expect(affected).toBe(2);

    for (const id of [a, b]) {
      const row = await docRow(id);
      expect(row.tax_relevant).toBe(true);
      expect(row.tax_year).toBe(2024);
      expect(row.tax_reviewed).toBe(true);
      expect(await taxSectionSlugs(id)).toEqual(["anlage-n:user"]);
    }
  });

  it("clears tax metadata when tax_relevant=false", async () => {
    const a = await insertDoc();
    await batchSetTax(USER_ID, [a], {
      tax_relevant: true,
      tax_year: 2024,
      tax_sections: ["anlage-n"],
    });

    const affected = await batchSetTax(USER_ID, [a], { tax_relevant: false });
    expect(affected).toBe(1);

    const row = await docRow(a);
    expect(row.tax_relevant).toBe(false);
    expect(row.tax_year).toBeNull();
    expect(row.tax_reviewed).toBe(true);
    expect(await taxSectionSlugs(a)).toEqual([]);
  });

  it("validates year and section slugs like the single-document endpoint", async () => {
    const a = await insertDoc();
    await expect(
      batchSetTax(USER_ID, [a], { tax_relevant: true, tax_sections: ["anlage-n"] }),
    ).rejects.toBeInstanceOf(APIError);
    await expect(
      batchSetTax(USER_ID, [a], { tax_relevant: true, tax_year: 2024, tax_sections: [] }),
    ).rejects.toBeInstanceOf(APIError);
    await expect(
      batchSetTax(USER_ID, [a], {
        tax_relevant: true,
        tax_year: 2024,
        tax_sections: ["not-a-section"],
      }),
    ).rejects.toBeInstanceOf(APIError);
  });

  it("skips documents the caller cannot see", async () => {
    const foreign = await insertDoc({ userId: OTHER_USER_ID });
    const affected = await batchSetTax(USER_ID, [foreign], {
      tax_relevant: true,
      tax_year: 2024,
      tax_sections: ["anlage-n"],
    });
    expect(affected).toBe(0);
    expect((await docRow(foreign)).tax_relevant).toBe(false);
  });
});

describe("documents.batch-ops batchSetSubjectPersons", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("adds user-source links and promotes existing AI links", async () => {
    const a = await insertDoc();
    const b = await insertDoc();
    const person = await insertSubjectPerson(USER_ID, "Anna");
    await db.execute(sql`
      INSERT INTO document_subject_persons (document_id, subject_person_id, source)
      VALUES (${a}, ${person}, 'ai')
    `);

    const affected = await batchSetSubjectPersons(USER_ID, [a, b], {
      add_ids: [person],
    });
    expect(affected).toBe(2);
    expect(await subjectPersonLinks(a)).toEqual([`${person}:user`]);
    expect(await subjectPersonLinks(b)).toEqual([`${person}:user`]);
  });

  it("removes links regardless of source", async () => {
    const a = await insertDoc();
    const person = await insertSubjectPerson(USER_ID, "Ben");
    await db.execute(sql`
      INSERT INTO document_subject_persons (document_id, subject_person_id, source)
      VALUES (${a}, ${person}, 'ai')
    `);

    const affected = await batchSetSubjectPersons(USER_ID, [a], {
      remove_ids: [person],
    });
    expect(affected).toBe(1);
    expect(await subjectPersonLinks(a)).toEqual([]);
  });

  it("rejects subject persons owned by another user and empty patches", async () => {
    const a = await insertDoc();
    const foreignPerson = await insertSubjectPerson(OTHER_USER_ID, "Cleo");

    await expect(
      batchSetSubjectPersons(USER_ID, [a], { add_ids: [foreignPerson] }),
    ).rejects.toBeInstanceOf(APIError);
    await expect(batchSetSubjectPersons(USER_ID, [a], {})).rejects.toBeInstanceOf(
      APIError,
    );
  });

  it("skips documents the caller cannot see", async () => {
    const foreign = await insertDoc({ userId: OTHER_USER_ID });
    const person = await insertSubjectPerson(USER_ID, "Dora");

    const affected = await batchSetSubjectPersons(USER_ID, [foreign], {
      add_ids: [person],
    });
    expect(affected).toBe(0);
    expect(await subjectPersonLinks(foreign)).toEqual([]);
  });
});
