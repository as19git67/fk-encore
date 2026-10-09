import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  DUPLICATE_MIN_SCORE,
  defaultKeeper,
  findDuplicatePairs,
  foreignKeysOntoDocuments,
  looksLikeSpeakingName,
  mergeDocuments,
  normalizeForSimilarity,
  recordDuplicatePairs,
  trigramJaccard,
} from "./duplicates";

describe("text similarity", () => {
  it("normalises case, punctuation and whitespace", () => {
    expect(normalizeForSimilarity("  Hallo,\n  WELT!  42 ")).toBe("hallo welt 42");
    expect(normalizeForSimilarity(null)).toBe("");
  });

  it("scores identical texts 1 and unrelated texts near 0", () => {
    const a = normalizeForSimilarity("Versicherungsschein Hausrat Beispiel AG Beitrag jährlich");
    expect(trigramJaccard(a, a)).toBe(1);
    const b = normalizeForSimilarity("Kontoauszug Musterbank Umsätze Oktober");
    expect(trigramJaccard(a, b)).toBeLessThan(0.1);
  });

  it("tolerates OCR noise", () => {
    const clean = normalizeForSimilarity(
      "Sehr geehrte Damen und Herren, anbei erhalten Sie die Bedingungen zu Ihrem Vertrag. " +
        "Die Laufzeit beginnt am ersten des Folgemonats und verlängert sich jeweils um ein Jahr.",
    );
    const noisy = normalizeForSimilarity(
      "Sehr geehrte Damen und Herren, anbei erhalten Sie die Bedingungen zu lhrem Vertrag. " +
        "Die Laufzeit beginnt am ersten des Folgemonats und verlangert sich jeweils um ein Jahr.",
    );
    expect(trigramJaccard(clean, noisy)).toBeGreaterThan(DUPLICATE_MIN_SCORE);
  });

  it("recognises the speaking filename shape", () => {
    expect(looksLikeSpeakingName("2024_beispiel-ag_police__0a1b2c3d.pdf")).toBe(true);
    expect(looksLikeSpeakingName("Scan_0001.pdf")).toBe(false);
  });
});

describe("defaultKeeper", () => {
  it("keeps the OCR'd scan over its text-layer copy, else the lower id", () => {
    expect(defaultKeeper({ id: 5, text_source: "text_layer" }, { id: 9, text_source: "ocr" })).toBe(9);
    expect(defaultKeeper({ id: 5, text_source: "ocr" }, { id: 9, text_source: "text_layer" })).toBe(5);
    expect(defaultKeeper({ id: 5, text_source: "text_layer" }, { id: 9, text_source: "text_layer" })).toBe(5);
    expect(defaultKeeper({ id: 5, text_source: null }, { id: 9, text_source: null })).toBe(5);
  });
});

// ─── Scan and merge against the database ────────────────────────────────────

const OWNER_ID = 949_101;
const OTHER_ID = 949_102;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@duplicates.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

const LETTER =
  "Beispiel Versicherung AG, Musterstraße 1, 12345 Musterstadt. Sehr geehrte Frau Beispiel, " +
  "wir bestätigen den Abschluss Ihrer Hausratversicherung. Der Jahresbeitrag beträgt 123,45 Euro " +
  "und wird jährlich zum ersten Februar fällig. Die beigefügten Bedingungen gelten ab Vertragsbeginn. " +
  "Mit freundlichen Grüßen, Ihre Beispiel Versicherung AG.";

let seq = 0;
async function insertDoc(opts: {
  userId?: number;
  text?: string | null;
  pages?: number | null;
  docDate?: string | null;
  correspondent?: string | null;
  textSource?: string | null;
  filename?: string;
  title?: string;
  attributesReviewed?: boolean;
  notes?: string | null;
  folder?: string | null;
}): Promise<number> {
  seq += 1;
  const sha = `dup-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status,
       title, extracted_text, pages_total, doc_date, correspondent_slug, text_source,
       attributes_reviewed, notes, source_folder, visibility)
    VALUES
      (${opts.userId ?? OWNER_ID}, ${sha}, ${opts.filename ?? `dup-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/dup-test-${seq}.pdf`}, 'ready',
       ${opts.title ?? `Dokument ${seq}`}, ${opts.text === undefined ? LETTER : opts.text},
       ${opts.pages === undefined ? 2 : opts.pages}, ${opts.docDate ?? "2024-02-01"},
       ${opts.correspondent === undefined ? "beispiel-ag" : opts.correspondent},
       ${opts.textSource ?? "ocr"}, ${opts.attributesReviewed ?? false}, ${opts.notes ?? null},
       ${opts.folder ?? null}, 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_duplicate_candidates`);
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`);
  await db.execute(sql`DELETE FROM document_tags WHERE name LIKE 'dup-test-%'`);
}

describe("findDuplicatePairs", () => {
  beforeEach(async () => {
    await ensureUser(OWNER_ID);
    await ensureUser(OTHER_ID);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_ID})`);
  });

  it("finds a scan next to its re-imported sandwich and skips the rest", async () => {
    const scan = await insertDoc({ textSource: "ocr", filename: "Scan_0001.pdf" });
    const sandwich = await insertDoc({
      textSource: "text_layer",
      filename: "2024_beispiel-ag_police__0a1b2c3d.pdf",
      text: LETTER.replace("Ihrer", "lhrer"), // one OCR-ish slip
    });
    // Same sender, same day, different letter: not a duplicate.
    await insertDoc({
      text:
        "Beispiel Versicherung AG, Musterstraße 1, 12345 Musterstadt. Sehr geehrte Frau Beispiel, " +
        "hiermit kündigen wir die Beitragsanpassung zum kommenden Versicherungsjahr an. Der neue Beitrag " +
        "beträgt 130,00 Euro. Die Anpassung beruht auf gestiegenen Schadenaufwendungen. Mit freundlichen Grüßen.",
    });
    // Same text but another user's: never paired across owners.
    await insertDoc({ userId: OTHER_ID });
    // Same text, different page count: not even a candidate.
    await insertDoc({ pages: 5 });

    const pairs = await findDuplicatePairs(null);
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([[scan, sandwich]]);
    const p = pairs[0]!;
    expect(p.score).toBeGreaterThanOrEqual(DUPLICATE_MIN_SCORE);
    expect(p.evidence.same_date).toBe(true);
    expect(p.evidence.same_correspondent).toBe(true);
    expect(p.evidence.text_source_a).toBe("ocr");
    expect(p.evidence.text_source_b).toBe("text_layer");
    expect(p.evidence.speaking_name_b).toBe(true);
    expect(defaultKeeper(p.a, p.b)).toBe(scan);
  });

  it("anchors on one document and remembers decided pairs", async () => {
    const first = await insertDoc({});
    const second = await insertDoc({});
    const anchored = await findDuplicatePairs(second);
    expect(anchored).toHaveLength(1);

    const rec1 = await recordDuplicatePairs(anchored);
    expect(rec1).toEqual({ found: 1, new_open: 1, already_known: 0 });
    const rec2 = await recordDuplicatePairs(await findDuplicatePairs(null));
    expect(rec2).toEqual({ found: 1, new_open: 0, already_known: 1 });

    await db.execute(sql`UPDATE document_duplicate_candidates SET status = 'dismissed'`);
    const rec3 = await recordDuplicatePairs(await findDuplicatePairs(null));
    expect(rec3.new_open).toBe(0);
    const rows = await db.execute<{ status: string }>(
      sql`SELECT status FROM document_duplicate_candidates WHERE document_a_id = ${first} AND document_b_id = ${second}`,
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["dismissed"]);
  });
});

describe("mergeDocuments", () => {
  beforeEach(async () => {
    await ensureUser(OWNER_ID);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_ID})`);
  });

  it("sees every foreign key onto documents, including the raw-SQL tables", async () => {
    const fks = await foreignKeysOntoDocuments();
    const tables = new Set(fks.map((f) => f.table_name));
    for (const t of [
      "document_tag_links",
      "document_tax_sections",
      "document_subject_persons",
      "document_follow_ups",
      "document_collection_items",
      "document_embeddings",
      "document_scan_queue",
      "finance_transaction_document",
      "document_duplicate_candidates",
    ]) {
      expect(tables.has(t), `${t} missing from FK catalogue`).toBe(true);
    }
  });

  it("moves the loser's work onto the keeper, keeps what the keeper has, and deletes the loser", async () => {
    const keeper = await insertDoc({ title: "Original", notes: "vom Scanner" });
    const loser = await insertDoc({
      title: "Geprüfter Titel",
      attributesReviewed: true,
      notes: "Hinweis aus dem Import",
      folder: "Versicherungen/Hausrat",
    });

    // Tags: one shared, one only on the loser.
    const tagShared = await db.execute<{ id: number }>(
      sql`INSERT INTO document_tags (name) VALUES ('dup-test-shared') RETURNING id`,
    );
    const tagLoser = await db.execute<{ id: number }>(
      sql`INSERT INTO document_tags (name) VALUES ('dup-test-only-loser') RETURNING id`,
    );
    const sharedId = tagShared.rows[0]!.id;
    const loserTagId = tagLoser.rows[0]!.id;
    await db.execute(sql`INSERT INTO document_tag_links (document_id, tag_id) VALUES (${keeper}, ${sharedId}), (${loser}, ${sharedId}), (${loser}, ${loserTagId})`);

    // Tax section only on the loser.
    await db.execute(sql`INSERT INTO document_tax_sections (document_id, tax_section) VALUES (${loser}, 'sonderausgaben')`);

    // Collection: loser is a member, keeper is not.
    const coll = await db.execute<{ id: number }>(
      sql`INSERT INTO document_collections (user_id, title, visibility) VALUES (${OWNER_ID}, 'Akte', 'private') RETURNING id`,
    );
    const collId = coll.rows[0]!.id;
    await db.execute(sql`INSERT INTO document_collection_items (collection_id, document_id, position) VALUES (${collId}, ${loser}, 0)`);

    // An open pair between them.
    await db.execute(sql`
      INSERT INTO document_duplicate_candidates (document_a_id, document_b_id, score, evidence)
      VALUES (${Math.min(keeper, loser)}, ${Math.max(keeper, loser)}, 0.95, '{}'::jsonb)
    `);

    const res = await mergeDocuments(keeper, loser);
    expect(res.attributes_copied).toBe(true);
    expect(res.moved.document_tag_links).toBe(1);
    expect(res.dropped.document_tag_links).toBe(1);
    expect(res.moved.document_tax_sections).toBe(1);
    expect(res.moved.document_collection_items).toBe(1);

    const gone = await db.execute(sql`SELECT 1 FROM documents WHERE id = ${loser}`);
    expect(gone.rows).toHaveLength(0);

    const tags = await db.execute<{ tag_id: number }>(
      sql`SELECT tag_id FROM document_tag_links WHERE document_id = ${keeper} ORDER BY tag_id`,
    );
    expect(tags.rows.map((r) => r.tag_id).sort()).toEqual([sharedId, loserTagId].sort());

    const tax = await db.execute<{ tax_section: string }>(
      sql`SELECT tax_section FROM document_tax_sections WHERE document_id = ${keeper}`,
    );
    expect(tax.rows.map((r) => r.tax_section)).toEqual(["sonderausgaben"]);

    const member = await db.execute(
      sql`SELECT 1 FROM document_collection_items WHERE collection_id = ${collId} AND document_id = ${keeper}`,
    );
    expect(member.rows).toHaveLength(1);

    const k = await db.execute<{ title: string; attributes_reviewed: boolean; notes: string; source_folder: string }>(
      sql`SELECT title, attributes_reviewed, notes, source_folder FROM documents WHERE id = ${keeper}`,
    );
    expect(k.rows[0]).toEqual({
      title: "Geprüfter Titel",
      attributes_reviewed: true,
      notes: "vom Scanner\n\nHinweis aus dem Import",
      source_folder: "Versicherungen/Hausrat",
    });

    const pair = await db.execute<{ status: string; keeper_id: number; document_a_id: number | null; document_b_id: number | null }>(
      sql`SELECT status, keeper_id, document_a_id, document_b_id FROM document_duplicate_candidates`,
    );
    expect(pair.rows).toHaveLength(1);
    expect(pair.rows[0]!.status).toBe("merged");
    expect(pair.rows[0]!.keeper_id).toBe(keeper);
    // The loser's side was set to NULL by its FK when the row went.
    expect([pair.rows[0]!.document_a_id, pair.rows[0]!.document_b_id]).toContain(null);
  });

  it("does not let an unreviewed loser overwrite a reviewed keeper", async () => {
    const keeper = await insertDoc({ title: "Geprüft", attributesReviewed: true });
    const loser = await insertDoc({ title: "KI-Titel", attributesReviewed: false });
    const res = await mergeDocuments(keeper, loser);
    expect(res.attributes_copied).toBe(false);
    const k = await db.execute<{ title: string }>(sql`SELECT title FROM documents WHERE id = ${keeper}`);
    expect(k.rows[0]!.title).toBe("Geprüft");
  });
});
