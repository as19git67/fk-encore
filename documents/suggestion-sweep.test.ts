import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { sql, eq, inArray } from "drizzle-orm";

import db from "../db/database";
import { documentCategories, documentCategorySuggestions, documents } from "../db/schema";
import {
  AUTO_MINING_MARKER,
  AUTO_SENDER_MARKER,
  USER_PROPOSED_MARKER,
  isAutoMinedSuggestion,
  pruneStaleCategorySuggestions,
} from "./suggestion-writer";
import { runTaxonomyCockpit } from "./taxonomy-cockpit";

const USER_ID = 990931;
const DOC_IDS = [990931, 990932, 990933, 990934, 990935];

beforeEach(async () => {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["data.manage"],
  });
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  await db.delete(documentCategorySuggestions);
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
});

async function category(slug: string): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug, name: slug })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name: slug } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function doc(id: number, categoryId: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, category_id, visibility)
        VALUES
          (${id}, ${USER_ID}, ${`sweep-sha-${id}`}, 'x.pdf', 'application/pdf', 1,
           '/tmp/sweep-test.pdf', 'ready', ${categoryId}, 'private')`,
  );
}

async function suggestion(rationale: string, ids: number[]): Promise<number> {
  const [row] = await db
    .insert(documentCategorySuggestions)
    .values({ suggested_name: "Beispielabsender", example_document_ids: ids, rationale, status: "open" })
    .returning({ id: documentCategorySuggestions.id });
  return row!.id;
}

async function examples(id: number): Promise<number[] | null> {
  const [row] = await db
    .select({ ids: documentCategorySuggestions.example_document_ids })
    .from(documentCategorySuggestions)
    .where(eq(documentCategorySuggestions.id, id));
  return row ? row.ids : null;
}

describe("isAutoMinedSuggestion", () => {
  it("knows the sender and mining markers, not a user's proposal", () => {
    expect(isAutoMinedSuggestion(`${AUTO_SENDER_MARKER}x`)).toBe(true);
    expect(isAutoMinedSuggestion(`${AUTO_MINING_MARKER}x`)).toBe(true);
    expect(isAutoMinedSuggestion(`${USER_PROPOSED_MARKER}x`)).toBe(false);
    expect(isAutoMinedSuggestion(null)).toBe(false);
  });
});

describe("pruneStaleCategorySuggestions", () => {
  it("drops documents that left Sonstiges or are gone, and suggestions left empty", async () => {
    const sonstiges = await category("sonstiges");
    const other = await category("sweep-test-andere");
    await doc(990931, sonstiges);
    await doc(990932, other); // got a real category since
    await doc(990933, other);
    // 990939 never existed / was deleted.

    const trimmed = await suggestion(`${AUTO_SENDER_MARKER}a`, [990932, 990931, 990939]);
    const emptied = await suggestion(`${AUTO_SENDER_MARKER}b`, [990933, 990939]);
    const mined = await suggestion(`${AUTO_MINING_MARKER}c`, [990939]);
    const untouched = await suggestion(`${AUTO_SENDER_MARKER}d`, [990931]);
    const userProposed = await suggestion(`${USER_PROPOSED_MARKER}e`, [990933]);

    const result = await pruneStaleCategorySuggestions();

    expect(result).toEqual({ removed: 2, trimmed: 1 });
    expect(await examples(trimmed)).toEqual([990931]);
    expect(await examples(emptied)).toBeNull();
    expect(await examples(mined)).toBeNull();
    expect(await examples(untouched)).toEqual([990931]);
    // A person's proposal is never swept, even though its document is categorized.
    expect(await examples(userProposed)).toEqual([990933]);
  });

  it("leaves accepted and rejected suggestions alone", async () => {
    const [row] = await db
      .insert(documentCategorySuggestions)
      .values({
        suggested_name: "Beispielabsender",
        example_document_ids: [990939],
        rationale: `${AUTO_SENDER_MARKER}f`,
        status: "rejected",
      })
      .returning({ id: documentCategorySuggestions.id });

    expect(await pruneStaleCategorySuggestions()).toEqual({ removed: 0, trimmed: 0 });
    expect(await examples(row!.id)).toEqual([990939]);
  });
});

describe("taxonomy cockpit open suggestions", () => {
  it("counts only what the suggestions list shows, after the sweep", async () => {
    const sonstiges = await category("sonstiges");
    const other = await category("sweep-test-andere");
    for (const id of [990931, 990932, 990933]) await doc(id, sonstiges);
    await doc(990934, other);

    await suggestion(`${AUTO_SENDER_MARKER}visible`, [990931, 990932, 990933]); // 3 → shown
    await suggestion(`${AUTO_SENDER_MARKER}hidden`, [990931]); // 1 → hidden in the list
    await suggestion(`${AUTO_SENDER_MARKER}stale`, [990934]); // swept
    await suggestion(`${USER_PROPOSED_MARKER}mine`, [990934]); // always shown

    const snapshot = await runTaxonomyCockpit();

    expect(snapshot.open_suggestions_count).toBe(2);
  });
});
