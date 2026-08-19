import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Capture the request runClassify hands to the LLM client. The classification
// result itself is irrelevant here — this suite only asserts what goes *in*.
const classifyDocument = vi.fn(async () => ({
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
}));

vi.mock("./llm-client", () => ({
  classifyDocument: (req: unknown) => classifyDocument(req as never),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents, userSubjectPersons, userAssessmentSettings } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990311;
const DOC_ID = 990311;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function insertDoc(): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${DOC_ID}.pdf`}, 'classifying',
           'Arztrechnung für Erika Mustermann vom 1.1.')`,
  );
}

/** The `subject_persons` entry the classifier received for `fullName`. */
function sentPerson(fullName: string): Record<string, unknown> | undefined {
  const req = classifyDocument.mock.calls[0]?.[0] as
    | { subject_persons?: Array<Record<string, unknown>> }
    | undefined;
  return req?.subject_persons?.find((p) => p.full_name === fullName);
}

beforeEach(async () => {
  classifyDocument.mockClear();
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.delete(userSubjectPersons).where(eq(userSubjectPersons.user_id, USER_ID));
  await db.delete(userAssessmentSettings).where(eq(userAssessmentSettings.user_id, USER_ID));
  await ensureUser(USER_ID);
});

describe("runClassify — household context in the classify request", () => {
  it("forwards relation_kind, tax_cost_bearer and in_household per person", async () => {
    await db.insert(userSubjectPersons).values({
      user_id: USER_ID,
      full_name: "Erika Mustermann",
      relation_tag: "ehepartner",
      relation_kind: "spouse",
      tax_cost_bearer: "user",
      in_household: true,
    });
    await insertDoc();

    await runClassify(DOC_ID);

    // Regression guard: #991 sent relation_kind but the llm-service model
    // dropped it, so the prompt explained a field that never arrived.
    expect(sentPerson("Erika Mustermann")).toMatchObject({
      relation_tag: "ehepartner",
      relation_kind: "spouse",
      tax_cost_bearer: "user",
      in_household: true,
    });
  });

  it("forwards the effective assessment type", async () => {
    await db.insert(userAssessmentSettings).values({
      user_id: USER_ID,
      assessment_type: "zusammen",
      valid_from_tax_year: null,
    });
    await insertDoc();

    await runClassify(DOC_ID);

    const req = classifyDocument.mock.calls[0]?.[0] as { assessment_type?: string };
    expect(req.assessment_type).toBe("zusammen");
  });

  it("falls back to 'unknown' when no assessment setting exists", async () => {
    await insertDoc();

    await runClassify(DOC_ID);

    const req = classifyDocument.mock.calls[0]?.[0] as { assessment_type?: string };
    expect(req.assessment_type).toBe("unknown");
  });
});
