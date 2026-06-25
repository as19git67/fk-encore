import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { APIError } from "encore.dev/api";

import db from "../db/database";
import {
  listBasket,
  listFollowUps,
  setFollowUps,
  removeFollowUp,
  processDueFollowUps,
  todayIsoDate,
} from "./follow-ups";

const USER_ID = 93_001;
const OTHER_USER_ID = 93_002;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@follow-ups.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
/** Insert a private document for USER_ID and return its id. */
async function insertDoc(opts: {
  status?: string;
  confidence?: number | null;
  reviewed?: boolean;
  userId?: number;
}): Promise<number> {
  seq += 1;
  const sha = `fu-test-${seq}-${"0".repeat(50)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, classification_confidence, attributes_reviewed, visibility)
    VALUES
      (${opts.userId ?? USER_ID}, ${sha}, ${`doc-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/fu-${seq}.pdf`}, ${opts.status ?? "ready"},
       ${opts.confidence ?? null}, ${opts.reviewed ?? false}, 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM document_follow_ups WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(
    sql`DELETE FROM documents WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`,
  );
  await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
}

function futureDate(daysAhead = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return todayIsoDate(d);
}

describe("documents.follow-ups basket", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("includes low-confidence and failed documents, excludes confident/reviewed ones", async () => {
    const lowConf = await insertDoc({ status: "ready", confidence: 0.3 });
    const failed = await insertDoc({ status: "failed" });
    await insertDoc({ status: "ready", confidence: 0.95 }); // confident → not in basket
    await insertDoc({ status: "ready", confidence: 0.3, reviewed: true }); // pinned → not in basket

    const basket = await listBasket(USER_ID, false, 50, 0);
    const ids = basket.items.map((i) => i.id).sort();
    expect(ids).toEqual([lowConf, failed].sort());
    expect(basket.total).toBe(2);
  });

  it("does not leak another user's private documents into the basket", async () => {
    await insertDoc({ status: "failed", userId: OTHER_USER_ID });
    const basket = await listBasket(USER_ID, false, 50, 0);
    expect(basket.items).toHaveLength(0);
  });
});

describe("documents.follow-ups scheduling", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("snoozes a document out of the basket and lists it under follow-ups", async () => {
    const doc = await insertDoc({ status: "ready", confidence: 0.2 });
    expect((await listBasket(USER_ID, false, 50, 0)).total).toBe(1);

    const date = futureDate(5);
    const n = await setFollowUps(USER_ID, [doc], date, "  später prüfen  ");
    expect(n).toBe(1);

    // Removed from the basket…
    expect((await listBasket(USER_ID, false, 50, 0)).total).toBe(0);
    // …and visible under "Later" with a trimmed note.
    const later = await listFollowUps(USER_ID);
    expect(later).toHaveLength(1);
    expect(later[0].document.id).toBe(doc);
    expect(later[0].follow_up_date).toBe(date);
    expect(later[0].note).toBe("später prüfen");
  });

  it("rejects malformed or past follow-up dates", async () => {
    const doc = await insertDoc({ status: "failed" });
    await expect(setFollowUps(USER_ID, [doc], "2026-13-40", null)).rejects.toBeInstanceOf(APIError);
    await expect(setFollowUps(USER_ID, [doc], "not-a-date", null)).rejects.toBeInstanceOf(APIError);
    await expect(setFollowUps(USER_ID, [doc], todayIsoDate(), null)).rejects.toBeInstanceOf(APIError);
  });

  it("rejects documents the user cannot see", async () => {
    const foreign = await insertDoc({ status: "failed", userId: OTHER_USER_ID });
    await expect(setFollowUps(USER_ID, [foreign], futureDate(), null)).rejects.toBeInstanceOf(APIError);
  });

  it("reschedules an existing follow-up instead of duplicating it", async () => {
    const doc = await insertDoc({ status: "failed" });
    await setFollowUps(USER_ID, [doc], futureDate(3), "first");
    await setFollowUps(USER_ID, [doc], futureDate(10), "second");
    const later = await listFollowUps(USER_ID);
    expect(later).toHaveLength(1);
    expect(later[0].follow_up_date).toBe(futureDate(10));
    expect(later[0].note).toBe("second");
  });

  it("removeFollowUp brings the document straight back into the basket", async () => {
    const doc = await insertDoc({ status: "failed" });
    await setFollowUps(USER_ID, [doc], futureDate(), null);
    expect((await listBasket(USER_ID, false, 50, 0)).total).toBe(0);

    expect(await removeFollowUp(USER_ID, doc)).toBe(true);
    expect((await listBasket(USER_ID, false, 50, 0)).total).toBe(1);
    expect(await removeFollowUp(USER_ID, doc)).toBe(false);
  });
});

describe("documents.follow-ups processDueFollowUps", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("surfaces due follow-ups and leaves future ones untouched", async () => {
    const dueDoc = await insertDoc({ status: "failed" });
    const futureDoc = await insertDoc({ status: "failed" });

    // Schedule both in the future, then back-date one row directly so it is due.
    await setFollowUps(USER_ID, [dueDoc], futureDate(2), null);
    await setFollowUps(USER_ID, [futureDoc], futureDate(30), null);
    await db.execute(
      sql`UPDATE document_follow_ups SET follow_up_date = '2000-01-01' WHERE document_id = ${dueDoc}`,
    );

    const res = await processDueFollowUps();
    expect(res.surfaced).toBe(1);

    // The due document is back in the basket; the future one is still snoozed.
    const basketIds = (await listBasket(USER_ID, false, 50, 0)).items.map((i) => i.id);
    expect(basketIds).toContain(dueDoc);
    expect(basketIds).not.toContain(futureDoc);
    expect((await listFollowUps(USER_ID)).map((f) => f.document.id)).toEqual([futureDoc]);
  });
});
