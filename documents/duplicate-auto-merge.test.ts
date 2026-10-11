import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import db from "../db/database";
import {
  autoMergeDuplicates,
  contentKeeper,
  contentPairQualifies,
  contentPairVerdict,
  findContentPairs,
  findProvenancePairs,
  getAutoMergeState,
  numberDifference,
  numberTokens,
  oneSidedExtras,
  resetAutoMergeState,
  sameNumberMultiset,
  sameNumbers,
  scanNumberKey,
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

  it("treats a number OCR split or joined as the same, a changed digit as different", () => {
    expect(sameNumbers("vertrag 4711 0815 betrag 123 45", "vertrag 47110815 betrag 12345")).toBe(true);
    expect(sameNumbers("vertrag 4711 0815", "vertrag 4711 0816")).toBe(false);
    expect(numberDifference("betrag 123 45 vertrag 4711", "betrag 124 45 vertrag 4711")).toBe("A: 123 | B: 124");
    expect(numberDifference("a 1 2", "a 2 1")).toBe("same digits, other order");
  });

  it("accepts the same letter with OCR noise and rejects it with one other number", () => {
    const a = side({ id: 1 });
    const noisy = side({ id: 2, extracted_text: LETTER.replace("Ihrer", "lhrer") });
    expect(contentPairQualifies(a, noisy, 0.99)).toBe(true);
    const otherAmount = side({ id: 3, extracted_text: LETTER.replace("123,45", "124,45") });
    expect(contentPairQualifies(a, otherAmount, 0.99)).toBe(false);
  });

  it("rejects contradicting pages and names the first failed check", () => {
    const a = side({ id: 1 });
    const reason = (v: ReturnType<typeof contentPairVerdict>) => (v.ok ? null : v.reason);
    expect(reason(contentPairVerdict(a, side({ id: 2, pages_total: 3 }), 0.99))).toBe("pages");
    expect(reason(contentPairVerdict(a, side({ id: 2, pages_total: null }), 0.99))).toBe("pages");
    expect(reason(contentPairVerdict(a, side({ id: 2, extracted_text: LETTER.replace("123,45", "124,45") }), 0.99))).toBe("numbers");
    expect(reason(contentPairVerdict(a, side({ id: 2, extracted_text: "" }), 0.99))).toBe("text");
    expect(reason(contentPairVerdict(a, side({ id: 2, extracted_text: LETTER.replace("Ihrer", "lhrer") }), 0.5))).toBe("score");
    expect(contentPairVerdict(a, side({ id: 2 }), 0.99)).toEqual({ ok: true, via: "numbers" });
  });

  it("takes the same scan stored twice on its file names, whatever the numbers read", () => {
    const a = side({ id: 1, original_filename: "Scan5652-Jahr_2025.pdf", extracted_text: LETTER.replace("123,45", "128,45") });
    const b = side({ id: 2, original_filename: "#5652-Jahr_2025 Versicherung Beispiel AG Police.pdf" });
    expect(contentPairVerdict(a, b, 0.96)).toEqual({ ok: true, via: "scan_number" });
    expect(contentPairVerdict(a, side({ id: 3, original_filename: "Scan5652-Jahr_2025 2.pdf" }), 0.96)).toEqual({ ok: true, via: "scan_number" });
    // Another counter, another year, or no counter: no link.
    expect(contentPairVerdict(a, side({ id: 4, original_filename: "Scan5653-Jahr_2025.pdf" }), 0.99).ok).toBe(false);
    expect(contentPairVerdict(a, side({ id: 5, original_filename: "Scan5652-Jahr_2024.pdf" }), 0.99).ok).toBe(false);
    expect(scanNumberKey("Rechnung 2025.pdf")).toBeNull();
    expect(scanNumberKey("#05652-Jahr_2025 x.pdf")).toBe("5652-2025");
  });

  it("below the auto score identical numbers carry a pair only when there are enough of them", () => {
    // LETTER has seven digit runs: not a fingerprint on its own.
    const a = side({ id: 1 });
    expect(contentPairVerdict(a, side({ id: 2, extracted_text: LETTER.replace("Ihrer", "lhrer") }), 0.96)).toEqual({
      ok: false, reason: "score", extras: null,
    });
    const rich = `${LETTER} Kundennummer 99887766, IBAN DE00 0000 0000 0000 0000 00, Beleg 2024-0042.`;
    const richNoisy = rich.replace("Ihrer", "lhrer").replace("bestätigen", "bestatigen");
    expect(contentPairVerdict(side({ id: 1, extracted_text: rich }), side({ id: 2, extracted_text: richNoisy }), 0.96)).toEqual({
      ok: true, via: "numbers_low",
    });
    // One digit off: no.
    expect(contentPairVerdict(side({ id: 1, extracted_text: rich }), side({ id: 2, extracted_text: richNoisy.replace("0042", "0043") }), 0.96).ok).toBe(false);
  });

  it("takes the same numbers in another order and reports one-sided extras", () => {
    const a = side({ id: 1, extracted_text: "Posten 10 Euro und 20 Euro, Summe 30" });
    const b = side({ id: 2, extracted_text: "Posten 20 Euro und 10 Euro, Summe 30" });
    expect(sameNumberMultiset("posten 10 euro und 20 euro summe 30", "posten 20 euro und 10 euro summe 30")).toBe(true);
    expect(contentPairVerdict(a, b, 0.99)).toEqual({ ok: true, via: "order" });
    expect(oneSidedExtras("a 1 2 3", "a 1 2")).toEqual(["3"]);
    expect(oneSidedExtras("a 1 2", "a 1 2 3 3")).toEqual(["3", "3"]);
    expect(oneSidedExtras("a 1 4", "a 1 5")).toBeNull();
    const v = contentPairVerdict(side({ id: 1, extracted_text: `${LETTER} Tel 04106 7082500` }), side({ id: 2 }), 0.99);
    expect(v).toEqual({ ok: false, reason: "numbers", extras: ["04106", "7082500"] });
  });

  it("ignores a differing date or correspondent when the numbers agree", () => {
    // Both come out of the text through the classifier; with every number
    // identical a differing date is the classifier's doing, not the document's.
    const a = side({ id: 1 });
    expect(contentPairQualifies(a, side({ id: 2, doc_date: "2024-03-01" }), 0.99)).toBe(true);
    expect(contentPairQualifies(a, side({ id: 2, doc_date: null }), 0.99)).toBe(true);
    expect(contentPairQualifies(a, side({ id: 2, correspondent_slug: "andere" }), 0.99)).toBe(true);
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

    const { accepted, rejected } = await findContentPairs();
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ stage: "content", via: "numbers", keeper_id: a, loser_id: sandwich, score: 0.99 });
    // The other-number pair is reported with its reason; the one under the
    // auto score too, in its own band (LETTER has too few numbers to carry it).
    expect(rejected.map((r) => [r.loser_id, r.reason, r.detail, r.band]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([
      [otherNumber, "numbers", "A: 0815 | B: 0816", "auto"],
      [belowBar, "score", null, "low"],
    ]);
  });

  it("lets a scan-number pair in below the auto score and a repeated one-sided footer in as boilerplate", async () => {
    const scanA = await insertDoc({ filename: "Scan5700-Jahr_2025.pdf", text: LETTER.replace("123,45", "128,45") });
    const scanB = await insertDoc({ filename: "#5700-Jahr_2025 Police.pdf" });
    await insertPair(scanA, scanB, 0.96);

    // Five pairs where one side carries the same footer numbers and nothing else differs.
    const footerPairs: Array<[number, number]> = [];
    for (let i = 0; i < 5; i++) {
      const letter = LETTER.replace("4711-0815", `4711-08${20 + i}`);
      const plain = await insertDoc({ text: letter });
      const withFooter = await insertDoc({ text: `${letter} Beispiel AG, Musterstadt, Tel 04106 7082500` });
      await insertPair(plain, withFooter, 0.99);
      footerPairs.push([plain, withFooter]);
    }
    // One pair with a different one-sided addition: stays rejected.
    const draft = await insertDoc({ text: LETTER });
    const signed = await insertDoc({ text: `${LETTER} Unterschrieben am 08.07.2025 um 18:28` });
    await insertPair(draft, signed, 0.99);

    const { accepted, rejected } = await findContentPairs();
    expect(accepted.find((c) => c.loser_id === scanB || c.keeper_id === scanB)?.via).toBe("scan_number");
    expect(accepted.filter((c) => c.via === "boilerplate")).toHaveLength(5);
    expect(rejected.map((r) => [r.reason, r.detail])).toEqual([["numbers", "B: 08, 07, 2025, 18, 28"]]);
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
    expect(dry.content_rejected).toEqual({ pages: 0, numbers: 0, text: 0, score: 0 });
    expect(dry.content_rejected_low).toEqual({ pages: 0, numbers: 0, text: 0, score: 0 });
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
