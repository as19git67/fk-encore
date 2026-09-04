/**
 * A deferred job goes back to `pending` without counting as a failure. That
 * used to be unbounded, which turned every permanent defer condition into an
 * invisible infinite loop: the `embed` job of a single document cycling
 * pending → processing → pending for hours (llm-service timing out for that
 * one document, an ai-queue slot that never becomes active, or a stale
 * `documents.status` left over from an interrupted run).
 *
 * It was invisible because `embed` deliberately never touches
 * `documents.status`: the queue panel showed "wartend", nothing showed an
 * error, and no filter in the document list could reproduce the set.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("./llm-client", () => ({
  classifyDocument: vi.fn(async () => ({})),
  embedTexts: vi.fn(async () => []),
}));

import db from "../db/database";
import { documentScanQueue, documents } from "../db/schema";
import { runEmbed } from "./document-ops";
import {
  deferJob,
  hasAnyJob,
  listOutstandingJobs,
  MAX_JOB_DEFERS,
  requeueDocument,
  retryFailedJobs,
} from "./scan-queue";

const USER_ID = 990412;
const DOC_ID = 990412;

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function insertDoc(status: string, text: string | null): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${DOC_ID}.pdf`}, ${sql.raw(`'${status}'`)}, ${text})`,
  );
}

async function insertJob(
  service: "text_extract" | "classify" | "embed",
  status: "pending" | "processing" | "failed" | "done",
): Promise<number> {
  const [row] = await db
    .insert(documentScanQueue)
    .values({ document_id: DOC_ID, service, status })
    .returning({ id: documentScanQueue.id });
  return row.id;
}

beforeEach(async () => {
  await db.delete(documentScanQueue).where(eq(documentScanQueue.document_id, DOC_ID));
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  await ensureUser(USER_ID);
});

describe("deferJob — bounded deferrals", () => {
  it("counts every deferral and reports the budget as exhausted", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "processing");

    for (let i = 1; i < MAX_JOB_DEFERS; i++) {
      const res = await deferJob(jobId, "llm-service unavailable");
      expect(res.deferCount).toBe(i);
      expect(res.exhausted).toBe(false);
    }

    const last = await deferJob(jobId, "llm-service unavailable");
    expect(last.deferCount).toBe(MAX_JOB_DEFERS);
    expect(last.exhausted).toBe(true);
  });

  it("stores the reason while the job is still pending, and does not burn attempts", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "processing");

    await deferJob(jobId, "POST /embed timed out");

    const [row] = await db
      .select({
        status: documentScanQueue.status,
        attempts: documentScanQueue.attempts,
        error: documentScanQueue.error_msg,
      })
      .from(documentScanQueue)
      .where(eq(documentScanQueue.id, jobId));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.error).toBe("POST /embed timed out");
  });

  it("hands a re-queued job a fresh budget", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "pending");
    await deferJob(jobId, "boom");
    await deferJob(jobId, "boom");

    await requeueDocument(DOC_ID, ["embed"]);

    const [row] = await db
      .select({ defers: documentScanQueue.defer_count, error: documentScanQueue.error_msg })
      .from(documentScanQueue)
      .where(eq(documentScanQueue.id, jobId));
    expect(row.defers).toBe(0);
    expect(row.error).toBeNull();
  });

  it("resets the budget when failed jobs are retried from the panel", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "pending");
    await deferJob(jobId, "boom");
    await db
      .update(documentScanQueue)
      .set({ status: "failed" })
      .where(eq(documentScanQueue.id, jobId));

    await retryFailedJobs();

    const [row] = await db
      .select({ status: documentScanQueue.status, defers: documentScanQueue.defer_count })
      .from(documentScanQueue)
      .where(eq(documentScanQueue.id, jobId));
    expect(row.status).toBe("pending");
    expect(row.defers).toBe(0);
  });
});

describe("hasAnyJob", () => {
  it("sees a finished job, unlike hasUnfinishedJob", async () => {
    await insertDoc("pending", null);
    expect(await hasAnyJob(DOC_ID, "text_extract")).toBe(false);
    await insertJob("text_extract", "done");
    expect(await hasAnyJob(DOC_ID, "text_extract")).toBe(true);
  });
});

describe("runEmbed — stale document status must not defer forever", () => {
  it("defers while a text_extract job is still queued", async () => {
    await insertDoc("pending", null);
    await insertJob("text_extract", "pending");
    expect(await runEmbed(DOC_ID)).toEqual({ deferred: true });
  });

  it("settles once text extraction has run and produced nothing", async () => {
    // Interrupted run: the status still says "extracting", but the
    // text_extract job is over. This is the case that sat in "wartend"
    // forever — a status nothing was going to move on any more.
    await insertDoc("extracting", null);
    await insertJob("text_extract", "done");
    expect(await runEmbed(DOC_ID)).toEqual({ chunks: 0 });
  });

  it("settles on a failed text extraction too", async () => {
    await insertDoc("pending", null);
    await insertJob("text_extract", "failed");
    expect(await runEmbed(DOC_ID)).toEqual({ chunks: 0 });
  });

  it("still waits out the narrow window before text_extract is enqueued", async () => {
    // A re-queue flips the status to "pending" for every document first and
    // inserts the queue rows afterwards.
    await insertDoc("pending", null);
    await insertJob("embed", "processing");
    expect(await runEmbed(DOC_ID)).toEqual({ deferred: true });
  });
});

describe("listOutstandingJobs", () => {
  it("names the document behind an outstanding job", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "pending");
    await deferJob(jobId, "llm-service unavailable");

    const jobs = await listOutstandingJobs();
    const mine = jobs.find((j) => j.id === jobId);
    expect(mine).toBeDefined();
    expect(mine!.document_id).toBe(DOC_ID);
    expect(mine!.service).toBe("embed");
    expect(mine!.defer_count).toBe(1);
    expect(mine!.error_msg).toBe("llm-service unavailable");
    expect(mine!.document_status).toBe("ready");
    expect(mine!.document_title).toBe("d.pdf");
  });

  it("leaves finished jobs out", async () => {
    await insertDoc("ready", "text");
    const jobId = await insertJob("embed", "done");
    const jobs = await listOutstandingJobs();
    expect(jobs.find((j) => j.id === jobId)).toBeUndefined();
  });
});
