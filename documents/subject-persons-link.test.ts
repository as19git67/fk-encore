import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Stub the LLM client so runClassify runs without a llm-service. The mock emits
// no tags / sections; the Bezugsperson link must come from deterministic
// in-text detection, not the model.
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
    tax_relevant: false,
    tax_year: null,
    tax_year_confidence: null,
    tax_sections: [] as { slug: string; confidence: number }[],
  })),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents, documentSubjectPersons, userSubjectPersons } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990201;
const DOC_ID = 990201;

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

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID)); // cascades links
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  await ensureUser(USER_ID);
});

describe("runClassify — Bezugsperson linking", () => {
  it("links subject persons found in the text and preserves manual links", async () => {
    const erika = await addPerson("Erika Mustermann", "mutter");
    const anton = await addPerson("Anton Schegg", "vater");

    // The text mentions Erika but not Anton.
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
             status, extracted_text)
          VALUES
            (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
             ${`/tmp/d-${DOC_ID}.pdf`}, 'classifying',
             'Befund für Patientin Erika Mustermann vom 1.1.')`,
    );
    // A manual link to Anton must survive the re-classify.
    await db
      .insert(documentSubjectPersons)
      .values({ document_id: DOC_ID, subject_person_id: anton, source: "user" });

    await runClassify(DOC_ID);

    const rows = await db
      .select({
        subject_person_id: documentSubjectPersons.subject_person_id,
        source: documentSubjectPersons.source,
      })
      .from(documentSubjectPersons)
      .where(eq(documentSubjectPersons.document_id, DOC_ID));
    const bySource = Object.fromEntries(rows.map((r) => [r.subject_person_id, r.source]));

    expect(bySource[erika]).toBe("ai"); // detected in text
    expect(bySource[anton]).toBe("user"); // manual link preserved
    expect(rows.length).toBe(2);
  });
});
