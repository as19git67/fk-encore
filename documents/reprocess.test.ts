import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import { reprocessDocuments, requeueClassifyOnly } from "./reprocess";

const USER_ID = 94_101;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${USER_ID}, ${`u${USER_ID}@reprocess.test`}, ${`User ${USER_ID}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
async function insertDoc(text: string | null): Promise<number> {
  seq += 1;
  const sha = `rp-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
       status, visibility, extracted_text, last_error)
    VALUES
      (${USER_ID}, ${sha}, ${`doc-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/rp-${seq}.pdf`}, 'ready', 'private', ${text}, 'old error')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function state(id: number): Promise<{ status: string; last_error: string | null; services: string[] }> {
  const doc = await db.execute<{ status: string; last_error: string | null }>(
    sql`SELECT status, last_error FROM documents WHERE id = ${id}`,
  );
  const queue = await db.execute<{ service: string }>(sql`
    SELECT service FROM document_scan_queue
    WHERE document_id = ${id} AND status = 'pending'
    ORDER BY service
  `);
  return { ...doc.rows[0]!, services: queue.rows.map((r) => r.service) };
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM document_tags WHERE name LIKE 'rp-test-%'`);
  await db.execute(sql`DELETE FROM document_scan_queue WHERE document_id IN (SELECT id FROM documents WHERE user_id = ${USER_ID})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
});

describe("documents.reprocess requeueClassifyOnly", () => {
  it("keeps the text and queues only classify and embed", async () => {
    await ensureUser();
    const id = await insertDoc("Rechnung Nr. 1 über 10,00 EUR");

    const res = await requeueClassifyOnly([{ id, has_text: true }]);

    expect(res).toEqual({ classified: 1, extractedFirst: 0 });
    expect(await state(id)).toEqual({ status: "classifying", last_error: null, services: ["classify", "embed"] });
    const text = await db.execute<{ extracted_text: string | null }>(
      sql`SELECT extracted_text FROM documents WHERE id = ${id}`,
    );
    expect(text.rows[0]!.extracted_text).toBe("Rechnung Nr. 1 über 10,00 EUR");
  });

  it("starts a document without text from text extraction", async () => {
    await ensureUser();
    const id = await insertDoc(null);

    const res = await requeueClassifyOnly([{ id, has_text: false }]);

    expect(res).toEqual({ classified: 0, extractedFirst: 1 });
    const s = await state(id);
    expect(s.status).toBe("pending");
    expect(s.last_error).toBeNull();
    expect(s.services).toContain("text_extract");
    expect(s.services).toContain("classify");
  });
});

describe("documents.reprocess reprocessDocuments", () => {
  async function pin(id: number): Promise<number> {
    await db.execute(sql`
      UPDATE documents SET attributes_reviewed = true, tax_reviewed = true, category_source = 'user'
      WHERE id = ${id}
    `);
    const tag = await db.execute<{ id: number }>(sql`
      INSERT INTO document_tags (name) VALUES (${`rp-test-${id}`}) RETURNING id
    `);
    const tagId = tag.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO document_tag_links (document_id, tag_id, source) VALUES (${id}, ${tagId}, 'user')
    `);
    return tagId;
  }

  async function pins(id: number) {
    const doc = await db.execute<{ attributes_reviewed: boolean; tax_reviewed: boolean; category_source: string; force_ocr: boolean }>(
      sql`SELECT attributes_reviewed, tax_reviewed, category_source, force_ocr FROM documents WHERE id = ${id}`,
    );
    const tags = await db.execute<{ source: string }>(
      sql`SELECT source FROM document_tag_links WHERE document_id = ${id}`,
    );
    return { ...doc.rows[0]!, tagSources: tags.rows.map((r) => r.source) };
  }

  it("leaves what a human pinned alone by default", async () => {
    await ensureUser();
    const id = await insertDoc("Text");
    await pin(id);

    await reprocessDocuments([{ id, has_text: true }]);

    expect(await pins(id)).toMatchObject({
      attributes_reviewed: true,
      tax_reviewed: true,
      category_source: "user",
      tagSources: ["user"],
    });
    expect((await state(id)).services).toEqual(["classify", "embed"]);
  });

  it("hands attribution and tax back to the classifier when asked", async () => {
    await ensureUser();
    const id = await insertDoc("Text");
    await pin(id);

    await reprocessDocuments([{ id, has_text: true }], { resetAttributes: true });
    expect(await pins(id)).toMatchObject({
      attributes_reviewed: false,
      tax_reviewed: true,
      category_source: "ai",
      tagSources: ["ai"],
    });

    await reprocessDocuments([{ id, has_text: true }], { resetTax: true });
    expect((await pins(id)).tax_reviewed).toBe(false);
  });

  it("runs the whole pipeline with OCR when asked", async () => {
    await ensureUser();
    const id = await insertDoc("Text");

    const res = await reprocessDocuments([{ id, has_text: true }], { ocr: true });

    expect(res.extractedFirst).toBe(1);
    expect((await pins(id)).force_ocr).toBe(true);
    const s = await state(id);
    expect(s.status).toBe("pending");
    expect(s.services).toContain("text_extract");
  });
});
