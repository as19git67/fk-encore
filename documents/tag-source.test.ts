import { describe, it, expect, beforeEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

import db from "../db/database";
import { documentTagLinks, documentTags, documents } from "../db/schema";
import { replaceTagLinks } from "./document-ops";

// Re-classify replaces only AI-owned tag links; human-curated ('user') tags
// must survive. These tests exercise the real DB behaviour of replaceTagLinks
// against the (document_id, tag_id) primary key + source column (migration
// 0100).

const USER_ID = 990001;
const DOC_ID = 990001;
const TAG_NAMES = ["test-mutter", "test-altertag", "test-neutag", "test-strom"];

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function ensureDocument(id: number, userId: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path)
        VALUES (${id}, ${userId}, ${`sha-${id}`}, 'doc.pdf', 'application/pdf', 1, ${`/tmp/doc-${id}.pdf`})
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function tagId(name: string): Promise<number> {
  const inserted = await db
    .insert(documentTags)
    .values({ name })
    .onConflictDoNothing()
    .returning({ id: documentTags.id });
  if (inserted[0]?.id !== undefined) return inserted[0].id;
  const found = await db
    .select({ id: documentTags.id })
    .from(documentTags)
    .where(eq(documentTags.name, name));
  return found[0]!.id;
}

async function link(name: string, source: "ai" | "user"): Promise<void> {
  await db
    .insert(documentTagLinks)
    .values({ document_id: DOC_ID, tag_id: await tagId(name), source })
    .onConflictDoNothing();
}

async function currentLinks(): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: documentTags.name, source: documentTagLinks.source })
    .from(documentTagLinks)
    .innerJoin(documentTags, eq(documentTags.id, documentTagLinks.tag_id))
    .where(eq(documentTagLinks.document_id, DOC_ID));
  return Object.fromEntries(rows.map((r) => [r.name, r.source]));
}

beforeEach(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID)); // cascades links
  const ids = await db
    .select({ id: documentTags.id })
    .from(documentTags)
    .where(inArray(documentTags.name, TAG_NAMES));
  if (ids.length > 0) {
    await db.delete(documentTags).where(
      inArray(documentTags.id, ids.map((r) => r.id)),
    );
  }
  await ensureUser(USER_ID);
  await ensureDocument(DOC_ID, USER_ID);
});

describe("replaceTagLinks — tag source preservation", () => {
  it("keeps user tags, replaces AI tags on re-classify", async () => {
    await link("test-mutter", "user");
    await link("test-altertag", "ai");

    // A re-classify suggests a different AI tag set.
    await replaceTagLinks(DOC_ID, ["test-neutag"]);

    const links = await currentLinks();
    expect(links["test-mutter"]).toBe("user"); // human tag survived
    expect(links["test-altertag"]).toBeUndefined(); // old AI tag replaced
    expect(links["test-neutag"]).toBe("ai"); // new AI tag added
  });

  it("does not demote a user tag the AI also suggests", async () => {
    await link("test-strom", "user");

    await replaceTagLinks(DOC_ID, ["test-strom"]);

    const links = await currentLinks();
    expect(links["test-strom"]).toBe("user"); // stays user
    // …and exactly one link row for the document (no duplicate ai row).
    const rows = await db
      .select({ tag_id: documentTagLinks.tag_id })
      .from(documentTagLinks)
      .where(eq(documentTagLinks.document_id, DOC_ID));
    expect(rows.length).toBe(1);
  });
});
