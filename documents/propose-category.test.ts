import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import path from "path";
import { eq, sql } from "drizzle-orm";

import db from "../db/database";
import { documentCategories, documentCategorySuggestions, documents } from "../db/schema";
import { DOCUMENTS_DIR } from "./documents.service";
import { proposeCategory } from "./documents";

const USER_ID = 990801;
const DOC_ID = 990801;

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

/** The taxonomy seed runs at service startup, not in migrations — create our own
 *  "sonstiges" so the move-to-catch-all path is exercised. */
async function ensureSonstiges(): Promise<number> {
  const [row] = await db
    .insert(documentCategories)
    .values({ slug: "sonstiges", name: "Sonstiges" })
    .onConflictDoUpdate({ target: documentCategories.slug, set: { name: "Sonstiges" } })
    .returning({ id: documentCategories.id });
  return row!.id;
}

async function seedDocument(): Promise<void> {
  await db.delete(documents).where(eq(documents.id, DOC_ID));
  const diskPath = path.join(DOCUMENTS_DIR, `u${USER_ID}`, "_inbox", "2026-01", `x-${DOC_ID}.pdf`);
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, title, sender, visibility)
        VALUES
          (${DOC_ID}, ${USER_ID}, ${`sha-${DOC_ID}`}, 'x.pdf', 'application/pdf', 1,
           ${diskPath}, 'ready', 'Ein Titel', 'Turnverein Musterhausen', 'private')`,
  );
}

async function openUserProposals() {
  return db
    .select()
    .from(documentCategorySuggestions)
    .where(eq(documentCategorySuggestions.status, "open"));
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  setAuth();
  await ensureSonstiges();
  await seedDocument();
  // Start from a clean suggestion queue so assertions are deterministic.
  await db.delete(documentCategorySuggestions);
});

describe("proposeCategory", () => {
  it("files a user-proposed suggestion and parks the document in sonstiges", async () => {
    const detail = await proposeCategory({
      id: DOC_ID,
      suggested_name: "Vereinsbeiträge",
      move_to_sonstiges: true,
    });

    expect(detail.category_slug).toBe("sonstiges");
    expect(detail.category_source).toBe("user");

    const open = await openUserProposals();
    expect(open).toHaveLength(1);
    expect(open[0]!.suggested_name).toBe("Vereinsbeiträge");
    expect(open[0]!.example_document_ids).toContain(DOC_ID);
    expect(open[0]!.rationale ?? "").toContain("user-proposed:");
  });

  it("keeps the current category when move_to_sonstiges is false", async () => {
    const detail = await proposeCategory({
      id: DOC_ID,
      suggested_name: "Vereinsbeiträge",
      move_to_sonstiges: false,
    });

    expect(detail.category_slug).toBeNull();
    const open = await openUserProposals();
    expect(open).toHaveLength(1);
  });

  it("falls back to the sender when no name is given", async () => {
    await proposeCategory({ id: DOC_ID, move_to_sonstiges: false });

    const open = await openUserProposals();
    expect(open).toHaveLength(1);
    expect(open[0]!.suggested_name).toBe("Turnverein Musterhausen");
  });
});
