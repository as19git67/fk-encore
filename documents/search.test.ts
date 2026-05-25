import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { searchDocuments } from "./search";

/**
 * DB-backed regression tests for the tag-aware full-text search added
 * in migration 0090. A document tagged with `mutter` must surface for a
 * search query "mutter" even when the word never appears in the OCR
 * text — this proves the trigger on `document_tag_links` populates
 * `tags_text` and the regenerated `text_tsv` includes it.
 */

const TEST_USER_ID = 91_001;
const OTHER_USER_ID = 91_002;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@search.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertDocument(opts: {
  id: number;
  userId: number;
  extractedText: string;
  title?: string;
  sender?: string;
}): Promise<number> {
  await db.execute(sql`
    INSERT INTO documents (
      id, user_id, sha256, original_filename, mime_type,
      size_bytes, disk_path, status, title, sender, extracted_text
    )
    VALUES (
      ${opts.id}, ${opts.userId}, ${`sha-${opts.id}`}, ${`doc-${opts.id}.pdf`}, 'application/pdf',
      0, ${`/tmp/doc-${opts.id}.pdf`}, 'ready',
      ${opts.title ?? null}, ${opts.sender ?? null}, ${opts.extractedText}
    )
  `);
  return opts.id;
}

async function tagDocument(documentId: number, tagName: string): Promise<void> {
  const inserted = await db.execute<{ id: number }>(sql`
    INSERT INTO document_tags (name) VALUES (${tagName})
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `);
  const tagId = Number(inserted.rows[0].id);
  await db.execute(sql`
    INSERT INTO document_tag_links (document_id, tag_id)
    VALUES (${documentId}, ${tagId})
    ON CONFLICT DO NOTHING
  `);
}

async function untagDocument(documentId: number, tagName: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM document_tag_links
    WHERE document_id = ${documentId}
      AND tag_id = (SELECT id FROM document_tags WHERE name = ${tagName})
  `);
}

async function renameTag(oldName: string, newName: string): Promise<void> {
  await db.execute(sql`
    UPDATE document_tags SET name = ${newName} WHERE name = ${oldName}
  `);
}

async function readTagsText(documentId: number): Promise<string> {
  const r = await db.execute<{ tags_text: string }>(sql`
    SELECT tags_text FROM documents WHERE id = ${documentId}
  `);
  return r.rows[0].tags_text;
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM document_tag_links
    WHERE document_id IN (SELECT id FROM documents WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID}))
  `);
  await db.execute(sql`
    DELETE FROM documents WHERE user_id IN (${TEST_USER_ID}, ${OTHER_USER_ID})
  `);
  await db.execute(sql`
    DELETE FROM document_tags
    WHERE name IN ('mutter', 'vater', 'mama', 'bezugsperson-x')
  `);
  await db.execute(sql`
    DELETE FROM users WHERE id IN (${TEST_USER_ID}, ${OTHER_USER_ID})
  `);
}

describe("documents.search FTS includes tag names", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureUser(TEST_USER_ID);
    await ensureUser(OTHER_USER_ID);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("finds a document tagged 'mutter' when its OCR text does not contain the word", async () => {
    const docId = await insertDocument({
      id: 910_001,
      userId: TEST_USER_ID,
      title: "Rechnung Sozialstation",
      sender: "Caritas",
      extractedText: "Pflegeleistungen Juni 2026 für Erika Mustermann.",
    });
    await tagDocument(docId, "mutter");

    expect(await readTagsText(docId)).toBe("mutter");

    const hits = await searchDocuments({
      userId: TEST_USER_ID,
      query: "mutter",
      mode: "fts",
      limit: 10,
    });
    expect(hits.map((h) => h.document_id)).toContain(docId);
  });

  it("drops the tag from FTS after the link is removed", async () => {
    const docId = await insertDocument({
      id: 910_002,
      userId: TEST_USER_ID,
      extractedText: "Pflegerechnung ohne Schlüsselwort.",
    });
    await tagDocument(docId, "mutter");
    await untagDocument(docId, "mutter");

    expect(await readTagsText(docId)).toBe("");

    const hits = await searchDocuments({
      userId: TEST_USER_ID,
      query: "mutter",
      mode: "fts",
      limit: 10,
    });
    expect(hits.map((h) => h.document_id)).not.toContain(docId);
  });

  it("propagates a tag rename into the FTS index", async () => {
    const docId = await insertDocument({
      id: 910_003,
      userId: TEST_USER_ID,
      extractedText: "Rechnung ohne Trefferwort.",
    });
    await tagDocument(docId, "mama");
    await renameTag("mama", "mutter");

    expect(await readTagsText(docId)).toBe("mutter");

    const hits = await searchDocuments({
      userId: TEST_USER_ID,
      query: "mutter",
      mode: "fts",
      limit: 10,
    });
    expect(hits.map((h) => h.document_id)).toContain(docId);
  });

  it("still scopes results by visibility — other users' tagged docs do not leak", async () => {
    const otherDocId = await insertDocument({
      id: 910_004,
      userId: OTHER_USER_ID,
      extractedText: "Fremdes Dokument.",
    });
    await tagDocument(otherDocId, "mutter");

    const hits = await searchDocuments({
      userId: TEST_USER_ID,
      query: "mutter",
      mode: "fts",
      limit: 10,
    });
    expect(hits.map((h) => h.document_id)).not.toContain(otherDocId);
  });
});
