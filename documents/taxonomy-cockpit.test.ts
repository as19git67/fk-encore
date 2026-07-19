import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql, eq } from "drizzle-orm";

import db from "../db/database";
import { documents, documentCategories, documentCategorySuggestions, taxonomySnapshots } from "../db/schema";
import { runTaxonomyCockpit, getTaxonomyCockpit } from "./taxonomy-cockpit";

const USER_ID = 990901;

function setAuth() {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["data.manage"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function ensureSonstiges(): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug: "sonstiges", name: "Sonstiges" })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name: "Sonstiges" } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function ensureCategory(slug: string, name: string): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug, name })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

beforeEach(async () => {
  setAuth();
  await ensureUser(USER_ID);
  // Clean up test snapshots
  await db.delete(taxonomySnapshots);
});

describe("taxonomy cockpit snapshot", () => {
  it("captures a snapshot with correct counts", async () => {
    const sonstigesId = await ensureSonstiges();
    const rechnungenId = await ensureCategory("rechnungen", "Rechnungen");

    // Seed a few documents
    for (let i = 1; i <= 3; i++) {
      await db.execute(
        sql`INSERT INTO documents
              (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
               status, category_id, classification_confidence, visibility)
            VALUES
              (${990900 + i}, ${USER_ID}, ${`snap-sha-${990900 + i}`}, 'x.pdf', 'application/pdf', 1,
               '/tmp/snap-test.pdf', 'ready', ${rechnungenId}, ${0.85}, 'private')
            ON CONFLICT (id) DO NOTHING`,
      );
    }
    // One in sonstiges with low confidence
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
             status, category_id, classification_confidence, visibility)
          VALUES
            (${990904}, ${USER_ID}, ${"snap-sha-990904"}, 'y.pdf', 'application/pdf', 1,
             '/tmp/snap-test.pdf', 'ready', ${sonstigesId}, ${0.3}, 'private')
          ON CONFLICT (id) DO NOTHING`,
    );
    // One teacher-requested
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
             status, category_id, classification_confidence, teacher_requested, visibility)
          VALUES
            (${990905}, ${USER_ID}, ${"snap-sha-990905"}, 'z.pdf', 'application/pdf', 1,
             '/tmp/snap-test.pdf', 'ready', ${rechnungenId}, ${0.4}, true, 'private')
          ON CONFLICT (id) DO NOTHING`,
    );

    const snapshot = await runTaxonomyCockpit();

    expect(snapshot.total_documents).toBeGreaterThanOrEqual(5);
    expect(snapshot.classified_documents).toBeGreaterThanOrEqual(5);
    expect(snapshot.sonstiges_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.sonstiges_pct).toBeGreaterThan(0);
    expect(snapshot.avg_confidence).not.toBeNull();
    expect(snapshot.low_confidence_count).toBeGreaterThanOrEqual(2); // 0.3 and 0.4
    expect(snapshot.teacher_requested_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.category_count).toBeGreaterThanOrEqual(2);
    expect(snapshot.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("upserts on the same day without error", async () => {
    await ensureSonstiges();
    const s1 = await runTaxonomyCockpit();
    const s2 = await runTaxonomyCockpit();
    expect(s2.snapshot_date).toBe(s1.snapshot_date);
  });

  it("getTaxonomyCockpit returns snapshots and recommendations", async () => {
    await ensureSonstiges();
    await runTaxonomyCockpit();

    const result = await getTaxonomyCockpit();
    expect(result.snapshots).toHaveLength(1);
    expect(result.recommendations).toBeInstanceOf(Array);
  });
});
