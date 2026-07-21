import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

// Stub the LLM client so runClassify runs without a llm-service (same setup
// as subject-persons-link.test.ts): the Bezugsperson link comes from the
// deterministic in-text detection, which is exactly what the removal marker
// must override.
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
import {
  documents,
  documentSubjectPersons,
  documentSubjectPersonRemovals,
  userSubjectPersons,
} from "../db/schema";
import { runClassify } from "./document-ops";
import { updateDocument } from "./documents";

const USER_ID = 990501;
const DOC_ID = 990501;

function setAuth() {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["module.documents", "documents.edit", "documents.view"],
  });
}

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

async function insertDoc(text: string, status = "ready"): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${DOC_ID}.pdf`}, ${status}, ${text}, 'private')`,
  );
}

async function linkedPersonIds(): Promise<number[]> {
  const rows = await db
    .select({ id: documentSubjectPersons.subject_person_id })
    .from(documentSubjectPersons)
    .where(eq(documentSubjectPersons.document_id, DOC_ID));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function removalIds(): Promise<number[]> {
  const rows = await db
    .select({ id: documentSubjectPersonRemovals.subject_person_id })
    .from(documentSubjectPersonRemovals)
    .where(eq(documentSubjectPersonRemovals.document_id, DOC_ID));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID)); // cascades links + removals
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  await ensureUser(USER_ID);
  setAuth();
});

describe("subject-person removal sticks (migration 0138)", () => {
  it("deselecting an AI-linked person deletes the link and records the removal", async () => {
    const erika = await addPerson("Erika Mustermann", "mutter");
    const anton = await addPerson("Anton Beispiel", "vater");
    await insertDoc("Befund für Erika Mustermann und Anton Beispiel");
    await db.insert(documentSubjectPersons).values([
      { document_id: DOC_ID, subject_person_id: erika, source: "ai" },
      { document_id: DOC_ID, subject_person_id: anton, source: "ai" },
    ]);

    // The edit dialog submits the remaining selection: Anton stays, Erika out.
    await updateDocument({ id: DOC_ID, subject_person_ids: [anton] });

    expect(await linkedPersonIds()).toEqual([anton]);
    expect(await removalIds()).toEqual([erika]);
  });

  it("a re-classify does not re-link a removed person even when the name is in the text", async () => {
    const erika = await addPerson("Erika Mustermann", "mutter");
    await insertDoc("Befund für Patientin Erika Mustermann", "classifying");
    await db.insert(documentSubjectPersons).values({
      document_id: DOC_ID,
      subject_person_id: erika,
      source: "ai",
    });

    await updateDocument({ id: DOC_ID, subject_person_ids: [] });
    expect(await linkedPersonIds()).toEqual([]);

    await db.execute(
      sql`UPDATE documents SET status = 'classifying' WHERE id = ${DOC_ID}`,
    );
    await runClassify(DOC_ID);

    // Name is in the text, but the explicit removal wins.
    expect(await linkedPersonIds()).toEqual([]);
  });

  it("re-adding the person manually lifts the block for future re-classifies", async () => {
    const erika = await addPerson("Erika Mustermann", "mutter");
    await insertDoc("Befund für Patientin Erika Mustermann");
    await db.insert(documentSubjectPersons).values({
      document_id: DOC_ID,
      subject_person_id: erika,
      source: "ai",
    });

    await updateDocument({ id: DOC_ID, subject_person_ids: [] });
    expect(await removalIds()).toEqual([erika]);

    await updateDocument({ id: DOC_ID, subject_person_ids: [erika] });
    expect(await removalIds()).toEqual([]);
    expect(await linkedPersonIds()).toEqual([erika]);

    await db.execute(
      sql`UPDATE documents SET status = 'classifying' WHERE id = ${DOC_ID}`,
    );
    await runClassify(DOC_ID);
    expect(await linkedPersonIds()).toEqual([erika]);
  });
});
