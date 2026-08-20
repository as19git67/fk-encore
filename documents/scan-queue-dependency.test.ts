/**
 * `dequeueNextJob` must skip jobs whose upstream stage is still outstanding
 * instead of handing them to the worker, which would then defer them.
 *
 * Deferring is what starved the pipeline: a defer bumps `enqueued_at` (the
 * document moves to the back of its queue) and makes the worker treat the
 * tick as "no work", so it stops looping. With one wake-up per finished
 * text_extract, classify got exactly one attempt per upstream completion,
 * and that attempt always hit the queue head — a document text_extract had
 * not reached yet. Result: after a bulk re-classify, text_extract chewed
 * through the backlog while classify and embed sat at their initial count
 * for as long as text_extract kept running.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { inArray, sql } from "drizzle-orm";

import db from "../db/database";
import { documentScanQueue, documents } from "../db/schema";
import { dequeueNextJob } from "./scan-queue";

const USER_ID = 990412;
const DOC_A = 990412; // enqueued first — stays at the head of every queue
const DOC_B = 990413;
const DOC_IDS = [DOC_A, DOC_B];

async function insertDoc(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${id}.pdf`}, 'pending', 'Text aus dem vorherigen Lauf')`,
  );
}

/** Mirrors a bulk re-classify: all three services queued for every document. */
async function enqueueAll(id: number, enqueuedAt: string): Promise<void> {
  for (const service of ["text_extract", "classify", "embed"] as const) {
    await db.execute(
      sql`INSERT INTO document_scan_queue (document_id, service, status, priority, enqueued_at)
          VALUES (${id}, ${service}, 'pending', 2, ${enqueuedAt}::timestamptz)`,
    );
  }
}

beforeEach(async () => {
  await db.delete(documentScanQueue).where(inArray(documentScanQueue.document_id, DOC_IDS));
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  for (const id of DOC_IDS) await insertDoc(id);
  await enqueueAll(DOC_A, "2024-01-01T00:00:00Z");
  await enqueueAll(DOC_B, "2024-01-01T00:00:01Z");
});

describe("dequeueNextJob — upstream dependency", () => {
  it("claims nothing for classify/embed while text_extract is outstanding", async () => {
    expect(await dequeueNextJob("classify")).toBeUndefined();
    expect(await dequeueNextJob("embed")).toBeUndefined();

    // …and leaves the jobs untouched, so nothing gets pushed to the back.
    const rows = await db
      .select({ status: documentScanQueue.status, attempts: documentScanQueue.attempts })
      .from(documentScanQueue)
      .where(inArray(documentScanQueue.document_id, DOC_IDS));
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
  });

  it("skips the queue head and claims the document text_extract has finished", async () => {
    // text_extract is still busy with DOC_A (the head), DOC_B is done.
    await db.execute(
      sql`UPDATE document_scan_queue SET status = 'processing'
          WHERE document_id = ${DOC_A} AND service = 'text_extract'`,
    );
    await db.execute(
      sql`UPDATE document_scan_queue SET status = 'done'
          WHERE document_id = ${DOC_B} AND service = 'text_extract'`,
    );

    const job = await dequeueNextJob("classify");
    expect(job?.document_id).toBe(DOC_B);
    expect(job?.status).toBe("processing");

    // Nothing else is claimable until DOC_A's text_extract lands.
    expect(await dequeueNextJob("classify")).toBeUndefined();
  });

  it("claims a document whose text_extract failed, so it is not stuck forever", async () => {
    await db.execute(
      sql`UPDATE document_scan_queue SET status = 'failed'
          WHERE document_id = ${DOC_A} AND service = 'text_extract'`,
    );

    const job = await dequeueNextJob("classify");
    expect(job?.document_id).toBe(DOC_A);
  });

  it("does not constrain text_extract itself", async () => {
    const job = await dequeueNextJob("text_extract");
    expect(job?.document_id).toBe(DOC_A);
  });
});
