import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Stub the LLM client so runClassify exercises the persistence logic without a
// running llm-service. The classifier always "wants" to set these AI values.
const AI = {
  category_slug: "finanzen-rechnungen",
  title: "AI Titel",
  doc_date: "2024-01-02",
  sender: "AI Quelle",
  document_number: "9999",
  summary: "AI Zusammenfassung",
  confidence: 0.95,
  tags: [] as string[],
  tax_relevant: false,
  tax_year: null,
  tax_year_confidence: null,
  tax_sections: [] as { slug: string; confidence: number }[],
};

vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => AI),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documents } from "../db/schema";
import { runClassify } from "./document-ops";

const USER_ID = 990101;
const DOC_ID = 990101;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function seedDocument(reviewed: boolean): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, sender, summary, extracted_text, attributes_reviewed)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'doc.pdf', 'application/pdf', 1,
           ${`/tmp/doc-${DOC_ID}.pdf`}, 'classifying', 'Mein Titel', 'Meine Quelle',
           'Meine Zusammenfassung', 'irgendein extrahierter Text #9999', ${reviewed})`,
  );
}

async function readDoc() {
  return (await db.select().from(documents).where(eq(documents.id, DOC_ID)))[0]!;
}

beforeEach(async () => {
  await ensureUser(USER_ID);
});

describe("runClassify — attributes_reviewed guard", () => {
  it("does NOT overwrite pinned attributes when attributes_reviewed=true", async () => {
    await seedDocument(true);

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.title).toBe("Mein Titel");
    expect(row.sender).toBe("Meine Quelle");
    expect(row.summary).toBe("Meine Zusammenfassung");
    expect(row.document_number).toBeNull();
    expect(row.category_id).toBeNull();
    // status still advances so the pipeline completes.
    expect(row.status).toBe("ready");
  });

  it("DOES overwrite attributes when attributes_reviewed=false", async () => {
    await seedDocument(false);

    await runClassify(DOC_ID);

    const row = await readDoc();
    expect(row.title).toBe("AI Titel");
    expect(row.sender).toBe("AI Quelle");
    expect(row.summary).toBe("AI Zusammenfassung");
    expect(row.document_number).toBe("9999");
    expect(row.status).toBe("ready");
  });
});
