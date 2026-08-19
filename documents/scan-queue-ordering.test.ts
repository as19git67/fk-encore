/**
 * The pipeline stages (text_extract → classify → embed) run in independent
 * workers, so a re-queue puts all three in flight at once. On a RE-run the
 * document still carries the previous run's `extracted_text`, so the original
 * "no text yet" defer guard no longer fires and classify can overtake
 * text_extract.
 *
 * Two things went wrong when it did: the classification was computed from
 * stale text, and the text_extract landing afterwards pushed the document's
 * status from "ready" back to "classifying" — where it stayed forever,
 * because the classify job was already done. That stranded status is what
 * made the scoreboard's reclassify wait never finish and what "Fehlende
 * fortsetzen" kept finding.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const classifyDocument = vi.fn(async (_req: unknown) => ({
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
import { documentScanQueue, documents } from "../db/schema";
import { runClassify } from "./document-ops";
import { hasUnfinishedJob } from "./scan-queue";

const USER_ID = 990411;
const DOC_ID = 990411;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** A re-queued document: status back to "pending", old text still present. */
async function insertRequeuedDoc(): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${DOC_ID}.pdf`}, 'pending', 'Text aus dem vorherigen Lauf')`,
  );
}

beforeEach(async () => {
  classifyDocument.mockClear();
  await db.delete(documentScanQueue).where(eq(documentScanQueue.document_id, DOC_ID));
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await ensureUser(USER_ID);
});

describe("hasUnfinishedJob", () => {
  it("is true for a queued job and for one already running", async () => {
    await insertRequeuedDoc();
    await db.insert(documentScanQueue).values({
      document_id: DOC_ID,
      service: "text_extract",
      status: "pending",
    });
    expect(await hasUnfinishedJob(DOC_ID, "text_extract")).toBe(true);

    await db
      .update(documentScanQueue)
      .set({ status: "processing" })
      .where(eq(documentScanQueue.document_id, DOC_ID));
    expect(await hasUnfinishedJob(DOC_ID, "text_extract")).toBe(true);
  });

  it("is false once the job finished, and for a different service", async () => {
    await insertRequeuedDoc();
    await db.insert(documentScanQueue).values({
      document_id: DOC_ID,
      service: "text_extract",
      status: "done",
    });
    expect(await hasUnfinishedJob(DOC_ID, "text_extract")).toBe(false);

    await db.insert(documentScanQueue).values({
      document_id: DOC_ID,
      service: "classify",
      status: "pending",
    });
    expect(await hasUnfinishedJob(DOC_ID, "text_extract")).toBe(false);
  });
});

describe("runClassify — waits for text_extract on a re-queued document", () => {
  it("defers while text_extract is still outstanding, even with old text present", async () => {
    await insertRequeuedDoc();
    await db.insert(documentScanQueue).values({
      document_id: DOC_ID,
      service: "text_extract",
      status: "pending",
    });

    const res = await runClassify(DOC_ID);

    expect(res).toEqual({ deferred: true });
    // Classifying the previous run's text would also have set status "ready",
    // which the later text_extract then reverts to "classifying".
    expect(classifyDocument).not.toHaveBeenCalled();
    const [row] = await db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, DOC_ID));
    expect(row.status).toBe("pending");
  });

  it("runs once text_extract is done", async () => {
    await insertRequeuedDoc();
    await db.insert(documentScanQueue).values({
      document_id: DOC_ID,
      service: "text_extract",
      status: "done",
    });

    const res = await runClassify(DOC_ID);

    expect(res).not.toEqual({ deferred: true });
    expect(classifyDocument).toHaveBeenCalledOnce();
    const [row] = await db
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, DOC_ID));
    expect(row.status).toBe("ready");
  });
});
