import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  autoMergeDuplicates,
  contentKeeper,
  contentPairQualifies,
  findContentPairs,
  findProvenancePairs,
  getAutoMergeState,
  numberTokens,
  resetAutoMergeState,
  startAutoMerge,
  type ContentSide,
} from "./duplicate-auto-merge";

const OWNER_ID = 951_101;
const OTHER_ID = 951_102;

const LETTER =
  "Beispiel Versicherung AG, Musterstraße 1, 12345 Musterstadt. Sehr geehrte Frau Beispiel, " +
  "wir bestätigen den Abschluss Ihrer Hausratversicherung zur Vertragsnummer 4711-0815. Der " +
  "Jahresbeitrag beträgt 123,45 Euro und wird jährlich zum 1. Februar fällig. Mit freundlichen Grüßen.";

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`u${id}@auto-merge.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

let seq = 0;
async function insertDoc(opts: {
  userId?: number;
  sha?: string;
  filename?: string;
  text?: string | null;
  pages?: number | null;
  docDate?: string | null;
  correspondent?: string | null;
  textSource?: string | null;
}): Promise<number> {
  seq += 1;
  const sha = opts.sha ?? `am-test-${seq}-${"0".repeat(60)}`.slice(0, 64);
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status,
       title, extracted_text, pages_total, doc_date, correspondent_slug, text_source, visibility)
    VALUES
      (${opts.userId ?? OWNER_ID}, ${sha}, ${opts.filename ?? `am-${seq}.pdf`}, 'application/pdf',
       ${1000 + seq}, ${`/tmp/am-test-${seq}.pdf`}, 'ready', ${`Dokument ${seq}`},
       ${opts.text === undefined ? LETTER : opts.text}, ${opts.pages === undefined ? 2 : opts.pages},
       ${opts.docDate === undefined ? "2024-02-01" : opts.docDate},
       ${opts.correspondent === undefined ? "beispiel-ag" : opts.correspondent},
       ${opts.textSource ?? "ocr"}, 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function insertPair(a: number, b: number, score: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO document_duplicate_candidates (document_a_id, document_b_id, score, evidence)
    VALUES (${Math.min(a, b)}, ${Math.max(a, b)}, ${score}, '{}'::jsonb)
  `);
}

async function exists(id: number): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM documents WHERE id = ${id}`);
  return Number(r.rows[0]!.n) === 1;
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_duplicate_candidates`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${OWNER_ID}, ${OTHER_ID})`);
}

/** A sha256 that starts with the given eight hex digits. */
const SHA_A = "0a1b2c3d" + "f".repeat(56);
const SHA_B = "9e8d7c6b" + "e".repeat(56);

describe("numberTokens / contentPairQualifies", () => {
  const side = (over: Partial<ContentSide>): ContentSide => ({
    id: 1,
    original_filename: "a.pdf",
    pages_total: 2,
    doc_date: "2024-02-01",
    correspondent_slug: "beispiel-ag",
    text_source: "ocr",
    extracted_text: LETTER,
    ...over,
  });

  it("lists every digit run in order", () => {
    expect(numberTokens("vertrag 4711 0815 betrag 123 45 euro")).toEqual(["4711", "0815", "123", "45"]);
    expect(numberTokens("keine zahlen")).toEqual([]);
  });

  it("accepts the same letter with OCR noise and rejects it with one other number", () => {
    const a = side({ id: 1 });
    const noisy = side({ id: 2, extracted_text: LETTER.replace("Ihrer", "lhrer") });
    expect(contentPairQualifies(a, noisy, 0.99)).toBe(true);
    const otherAmount = side({ id: 3, extracted_text: LETTER.replace("123,45", "124,45") });
    expect(contentPairQualifies(a, otherAmount, 0.99)).toBe(false);
  });

  it("rejects contradicting pages, date or correspondent but tolerates a missing one", () => {
    const a = side({ id: 1 });
    expect(contentPairQualifies(a, side({ id: 2, pages_total: 3 }), 0.99)).toBe(false);
    expect(contentPairQualifies(a, side({ id: 2, pages_total: null }), 0.99)).toBe(false);
    expect(contentPairQualifies(a, side({ id: 2, doc_date: "2024-03-01" }), 0.99)).toBe(false);
    expect(contentPairQualifies(a, side({ id: 2, doc_date: null }), 0.99)).toBe(true);
    expect(contentPairQualifies(a, side({ id: 2, correspondent_slug: "andere" }), 0.99)).toBe(false);
    expect(contentPairQualifies(a, side({ id: 2, correspondent_slug: null }), 0.99)).toBe(true);
  });

  it("needs the text score unless the normalised texts are identical", () => {
    const a = side({ id: 1 });
    // Punctuation and spacing differ, the normalised text does not.
    const same = side({ id: 2, extracted_text: LETTER.replace(/, /g, " ,\n  ").replace(/\. /g, " .  ") });
    expect(contentPairQualifies(a, same, 0.5)).toBe(true);
    // One OCR slip in a short letter recomputes to about 0.97: the recorded
    // score alone cannot carry it over the bar.
    const noisy = side({ id: 2, extracted_text: LETTER.replace("Ihrer", "lhrer") });
    expect(contentPairQualifies(a, noisy, 0.5)).toBe(false);
    const different = side({
      id: 2,
      extracted_text: LETTER.replace("Sehr geehrte Frau Beispiel", "Guten Tag liebe Kundin, vielen Dank für Ihr Vertrauen"),
    });
    expect(contentPairQualifies(a, different, 0.5)).toBe(false);
  });

  it("keeps the side that was not exported from the volume", () => {
    const original = side({ id: 5, original_filename: "Scan_0001.pdf", text_source: "text_layer" });
    const exported = side({ id: 4, original_filename: "2024_beispiel__0a1b2c3d.pdf", text_source: "ocr" });
    expect(contentKeeper(original, exported)).toBe(5);
    expect(contentKeeper(exported, original)).toBe(5);
    // Without that signal the general rule decides (lower id here).
    const plain = side({ id: 4, original_filename: "Scan_0002.pdf" });
    expect(contentKeeper(plain, side({ id: 5, original_filename: "Scan_0003.pdf" }))).toBe(4);
  });
});

describe("auto-merge against the database", () => {
  beforeEach(async () => {
    await ensureUser(OWNER_ID);
    await ensureUser(OTHER_ID);
    await cleanup();
    resetAutoMergeState();
  });
  afterAll(async () => {
    await cleanup();
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_ID})`);
  });

  it("stage A links a re-imported file to the document its name hashes, within the owner scope", async () => {
    const original = await insertDoc({ sha: SHA_A, filename: "Scan_0001.pdf" });
    const reimport = await insertDoc({ filename: "2024_beispiel-ag_police__0a1b2c3d.pdf", textSource: "text_layer" });
    // Same hash in the name but another owner: never linked.
    await insertDoc({ userId: OTHER_ID, filename: "2024_beispiel-ag_police__0a1b2c3d.pdf" });
    // Hash names nothing that exists.
    await insertDoc({ filename: "2024_beispiel-ag_police__deadbeef.pdf" });
    // Page count contradicts.
    await insertDoc({ filename: "2024_beispiel-ag_police__0a1b2c3d.pdf", pages: 7 });
    // Case in the hash does not matter.
    const originalB = await insertDoc({ sha: SHA_B, filename: "Scan_0002.pdf" });
    const reimportB = await insertDoc({ filename: "x__9E8D7C6B.PDF", pages: null });

    const pairs = await findProvenancePairs();
    expect(pairs.map((p) => [p.keeper_id, p.loser_id])).toEqual([
      [original, reimport],
      [originalB, reimportB],
    ]);
    expect(pairs[0]!.stage).toBe("provenance");
    expect(pairs[0]!.score).toBeNull();
  });

  it("stage B takes only open pairs above the auto score whose numbers agree", async () => {
    const a = await insertDoc({ filename: "Scan_0001.pdf" });
    const sandwich = await insertDoc({ filename: "2024_x__ffffffff.pdf", text: LETTER.replace("Ihrer", "lhrer"), textSource: "text_layer" });
    const otherNumber = await insertDoc({ text: LETTER.replace("4711-0815", "4711-0816") });
    const belowBar = await insertDoc({ text: LETTER.replace("Ihrer", "lhrer") });
    await insertPair(a, sandwich, 0.99);
    await insertPair(a, otherNumber, 0.99);
    await insertPair(a, belowBar, 0.96);

    const pairs = await findContentPairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ stage: "content", keeper_id: a, loser_id: sandwich, score: 0.99 });
  });

  it("dry run reports and writes nothing; apply merges both stages and follows a chain", async () => {
    // Chain: `second` was exported from `first`, `third` from `second`.
    const first = await insertDoc({ sha: SHA_A, filename: "Scan_0001.pdf" });
    const second = await insertDoc({ sha: SHA_B, filename: "a__0a1b2c3d.pdf", textSource: "text_layer" });
    const third = await insertDoc({ filename: "b__9e8d7c6b.pdf", textSource: "text_layer" });
    // A content pair elsewhere.
    const c1 = await insertDoc({ filename: "Scan_0003.pdf" });
    const c2 = await insertDoc({ filename: "Scan_0004.pdf", text: LETTER.replace("Ihrer", "lhrer") });
    await insertPair(c1, c2, 0.99);
    await db.execute(sql`INSERT INTO document_tag_links (document_id, tag_id)
      SELECT ${third}, id FROM document_tags WHERE name = 'am-test-tag'`);

    const dry = await autoMergeDuplicates(false);
    expect(dry.dry_run).toBe(true);
    expect(dry.provenance.found).toBe(2);
    expect(dry.content.found).toBe(1);
    expect(dry.items.every((i) => i.outcome === "planned")).toBe(true);
    for (const id of [first, second, third, c1, c2]) expect(await exists(id)).toBe(true);

    const applied = await autoMergeDuplicates(true);
    expect(applied.provenance).toEqual({ found: 2, merged: 2, failed: 0 });
    expect(applied.content).toEqual({ found: 1, merged: 1, failed: 0 });
    expect(await exists(first)).toBe(true);
    expect(await exists(second)).toBe(false);
    expect(await exists(third)).toBe(false);
    expect(await exists(c1)).toBe(true);
    expect(await exists(c2)).toBe(false);
    // The chain ended on the first document, not on the deleted middle one.
    const thirdItem = applied.items.find((i) => i.loser_id === third)!;
    expect(thirdItem.keeper_id).toBe(first);
    expect(thirdItem.outcome).toBe("merged");
    // Nothing left to decide on the review page.
    const open = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM document_duplicate_candidates WHERE status = 'open'`,
    );
    expect(Number(open.rows[0]!.n)).toBe(0);
  });

  it("runs in the background and keeps the report", async () => {
    const original = await insertDoc({ sha: SHA_A, filename: "Scan_0001.pdf" });
    await insertDoc({ filename: "a__0a1b2c3d.pdf" });

    const { started, state } = startAutoMerge(false);
    expect(started).toBe(true);
    expect(state.status).toBe("running");
    expect(startAutoMerge(true).started).toBe(false);

    for (let i = 0; i < 200 && getAutoMergeState().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const done = getAutoMergeState();
    expect(done.status).toBe("done");
    expect(done.report?.provenance.found).toBe(1);
    expect(done.report?.items[0]?.keeper_id).toBe(original);
    expect(await exists(original)).toBe(true);
  });
});
