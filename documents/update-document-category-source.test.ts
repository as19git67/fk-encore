import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documentCategories, documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { updateDocument } from "./documents";

const USER_ID = 990601;
const DOC_ID = 990601;

function setAuth() {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(USER_ID),
    permissions: ["module.documents", "documents.edit"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

const TEST_CATEGORY_SLUG = "udcs-test-kategorie";

/** The taxonomy seed runs at service startup, not in migrations — create our own. */
async function ensureCategory(): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug: TEST_CATEGORY_SLUG, name: "UDCS Testkategorie" })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name: "UDCS Testkategorie" } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function seedDocument(categorySource: "ai" | "cloud" | "user"): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  const catId = await ensureCategory();
  const diskPath = path.join(DOCUMENTS_DIR, `u${USER_ID}`, "_inbox", "2026-01", `x-${DOC_ID}.pdf`);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, sender, category_id, category_source, attributes_reviewed, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'x.pdf', 'application/pdf', 1,
           ${diskPath}, 'ready', 'Alter Titel', 'Alte Quelle', ${catId}, ${categorySource},
           ${categorySource !== "ai"}, 'private')`,
  );
}

async function readDoc() {
  const [row] = await db
    .select({
      categorySource: documents.category_source,
      attributesReviewed: documents.attributes_reviewed,
    })
    .from(documents)
    .where(eq(documents.id, DOC_ID));
  return row!;
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  setAuth();
});

describe("updateDocument — category_source provenance", () => {
  it("marks the category 'user'-owned when a human sets category_slug", async () => {
    await seedDocument("ai");

    await updateDocument({ id: DOC_ID, category_slug: TEST_CATEGORY_SLUG });

    const row = await readDoc();
    expect(row.categorySource).toBe("user");
    expect(row.attributesReviewed).toBe(true);
  });

  it("releases a cloud-owned category back to 'ai' on explicit unpin", async () => {
    await seedDocument("cloud");

    await updateDocument({ id: DOC_ID, attributes_reviewed: false });

    const row = await readDoc();
    expect(row.categorySource).toBe("ai");
    expect(row.attributesReviewed).toBe(false);
  });

  it("leaves category_source untouched when editing unrelated fields", async () => {
    await seedDocument("cloud");

    await updateDocument({ id: DOC_ID, notes: "nur eine Notiz" });

    const row = await readDoc();
    expect(row.categorySource).toBe("cloud");
  });
});
