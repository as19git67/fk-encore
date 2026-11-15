/**
 * The summary job retries only an outage on the next tick (all values
 * invented). An answer the model cannot give usefully waits an hour,
 * and after three tries the folder waits for its next change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { documentCollectionItems, documentCollections, documents, users } from "../db/schema";

vi.mock("./collection-summary", async (orig) => {
  const actual = await orig<typeof import("./collection-summary")>();
  return { ...actual, generateCollectionSummary: vi.fn() };
});
vi.mock("./collection-export", () => ({ discardCollectionExports: vi.fn(async () => {}) }));

import {
  generateCollectionSummary,
  LlmAnswerUnusableError,
  LlmServiceUnavailableError,
} from "./collection-summary";
import { MAX_SUMMARY_TRIES, refreshStaleCollectionSummaries } from "./collection-summary-cron";

let collectionId: number;

beforeEach(async () => {
  const [user] = await db.insert(users)
    .values({ email: `summary-cron-${crypto.randomUUID()}@test.invalid`, name: "Tester", password_hash: "x" })
    .returning({ id: users.id });
  const [doc] = await db.insert(documents).values({
    user_id: user.id, sha256: crypto.randomUUID(), original_filename: "beispiel.pdf",
    mime_type: "application/pdf", size_bytes: 1, disk_path: `/tmp/${crypto.randomUUID()}.pdf`,
    status: "ready", title: "Beispielrechnung",
  }).returning({ id: documents.id });
  const [col] = await db.insert(documentCollections)
    .values({ user_id: user.id, title: "Beispielmappe" })
    .returning({ id: documentCollections.id });
  collectionId = col.id;
  await db.insert(documentCollectionItems).values({ collection_id: col.id, document_id: doc.id, position: 0 });
});

afterEach(async () => {
  await db.delete(documentCollections).where(eq(documentCollections.id, collectionId));
  vi.mocked(generateCollectionSummary).mockReset();
});

async function row() {
  const [r] = await db.select().from(documentCollections).where(eq(documentCollections.id, collectionId));
  return r;
}

async function anHourLater(): Promise<void> {
  await db.update(documentCollections)
    .set({ summary_failed_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .where(eq(documentCollections.id, collectionId));
}

describe("refreshStaleCollectionSummaries", () => {
  it("tries an outage again on the next run", async () => {
    vi.mocked(generateCollectionSummary).mockRejectedValue(new LlmServiceUnavailableError("HTTP 503"));
    await refreshStaleCollectionSummaries();
    await refreshStaleCollectionSummaries();
    expect(generateCollectionSummary).toHaveBeenCalledTimes(2);
    expect((await row()).summary_stale).toBe(true);
  });

  it("waits an hour after a bad answer, and gives up after three", async () => {
    vi.mocked(generateCollectionSummary).mockRejectedValue(new LlmAnswerUnusableError("HTTP 422"));
    await refreshStaleCollectionSummaries();
    await refreshStaleCollectionSummaries();
    expect(generateCollectionSummary).toHaveBeenCalledTimes(1);

    for (let i = 1; i < MAX_SUMMARY_TRIES + 2; i += 1) {
      await anHourLater();
      await refreshStaleCollectionSummaries();
    }
    expect(generateCollectionSummary).toHaveBeenCalledTimes(MAX_SUMMARY_TRIES);
    const r = await row();
    expect(r.summary_stale).toBe(false);
    expect(r.summary_error).toContain("422");
  });

  it("clears the count when a summary is written", async () => {
    vi.mocked(generateCollectionSummary).mockRejectedValueOnce(new LlmAnswerUnusableError("HTTP 502"));
    await refreshStaleCollectionSummaries();
    await anHourLater();
    vi.mocked(generateCollectionSummary).mockResolvedValueOnce("Eine Beispielmappe.");
    await refreshStaleCollectionSummaries();
    const r = await row();
    expect(r.summary).toBe("Eine Beispielmappe.");
    expect(r.summary_failures).toBe(0);
    expect(r.summary_failed_at).toBeNull();
  });
});
