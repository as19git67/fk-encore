/**
 * Word positions end to end (#1531): a born-digital PDF through
 * `extractPdfText`, the rows in `document_page_words`, and the backfill
 * queue. Synthetic text only.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";

vi.mock("./scan-worker", () => ({ triggerWorkers: vi.fn() }));
// The PDF stays in a temp directory: DOCUMENTS_DIR is shared with the fsck
// tests, which count what lies there.
vi.mock("./documents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents.service")>()),
  assertPathUnderDocumentsRoot: vi.fn(),
}));

import db from "../db/database";
import { documentPageWords, documentScanQueue, documents } from "../db/schema";
import { extractPdfText } from "./text-extract";
import { findBoxes } from "./page-words";
import { findTextBoxes, hasPageWords, loadPageWords, replacePageWords } from "./page-words-store";
import { queuePageWordsBackfill } from "./page-words-api";
import { topUpPageWordsBackfill } from "./page-words-backfill";
import { runPageWords, runTextExtract } from "./document-ops";

const USER_ID = 991531;
const DOC_IDS = [991531, 991532, 991533, 991534];

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

async function insertDoc(id: number, opts: { status?: string; text?: string | null; confidence?: number | null } = {}): Promise<void> {
  await db.execute(
    sql`INSERT INTO documents
          (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path,
           status, extracted_text, ocr_mean_confidence)
        VALUES
          (${id}, ${USER_ID}, ${`sha-${id}`}, 'd.pdf', 'application/pdf', 1,
           ${`/tmp/d-${id}.pdf`}, ${sql.raw(`'${opts.status ?? "ready"}'`)},
           ${opts.text === undefined ? "Text" : opts.text}, ${opts.confidence ?? null})`,
  );
}

let pdfPath: string;

beforeAll(async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "page-words-"));
  pdfPath = path.join(dir, "kaufvertrag.pdf");
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 72 });
    const out = fs.createWriteStream(pdfPath);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.pipe(out);
    doc.fontSize(12);
    doc.text("Kaufvertrag über die Wohnung Beispielstraße 1, 12345 Musterstadt.");
    doc.text("Kaufpreis: 450.000,00 EUR");
    doc.text("Die Anzahlung beträgt laut Vereinbarung 450.000 € und ist sofort fällig.");
    doc.text("Restbetrag: EUR 450.000,- bei Übergabe.");
    doc.text("Nebenkosten: 12.500,00 EUR für Notar und Grundbuch.");
    doc.end();
  });
});

afterAll(async () => {
  // Rows pointing at temp files must not outlive them: fsck walks every row.
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
  await fs.promises.rm(path.dirname(pdfPath), { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(documentScanQueue).where(inArray(documentScanQueue.document_id, DOC_IDS));
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
  await ensureUser(USER_ID);
});

describe("a born-digital page", () => {
  it("keeps the words its text layer was read from, and the amounts are found in every form", async () => {
    const result = await extractPdfText(pdfPath);
    expect(result.source).toBe("text_layer");
    expect(result.pageWords).toHaveLength(1);
    const [page] = result.pageWords;
    expect(page).toMatchObject({ page: 1, unit: "pt", rotation: 0 });
    expect(page.width).toBeCloseTo(595.28, 1);
    expect(page.height).toBeCloseTo(841.89, 1);

    // The words are the text's words.
    const textWords = result.text.split(/\s+/).filter(Boolean);
    expect(page.words.map((w) => w.text)).toEqual(textWords);

    const boxes = findBoxes(result.pageWords, "450.000 EUR");
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThan(0);
      expect(b.x + b.w).toBeLessThan(1);
      expect(b.h).toBeGreaterThan(0);
    }
    // Top to bottom, as printed.
    expect(boxes[0].y).toBeLessThan(boxes[1].y);
    expect(boxes[1].y).toBeLessThan(boxes[2].y);
  });
});

describe("stored rows", () => {
  it("are replaced as a whole and found again by findTextBoxes", async () => {
    await insertDoc(DOC_IDS[0]);
    const result = await extractPdfText(pdfPath);

    expect(await findTextBoxes(DOC_IDS[0], "450.000")).toEqual({ status: "no_words", boxes: [] });
    expect(await hasPageWords(DOC_IDS[0])).toBe(false);

    await db.transaction((tx) => replacePageWords(tx, DOC_IDS[0], result.pageWords));
    await db.transaction((tx) => replacePageWords(tx, DOC_IDS[0], result.pageWords));
    expect(await hasPageWords(DOC_IDS[0])).toBe(true);
    const stored = await loadPageWords(DOC_IDS[0]);
    expect(stored).toHaveLength(1);
    expect(stored[0].words).toEqual(result.pageWords[0].words);

    const found = await findTextBoxes(DOC_IDS[0], "Kaufpreis");
    expect(found.status).toBe("ok");
    expect(found.boxes).toHaveLength(1);
    expect((await findTextBoxes(DOC_IDS[0], "450.000,00 EUR")).boxes).toHaveLength(3);

    // Deleting the document takes its rows along.
    await db.delete(documents).where(eq(documents.id, DOC_IDS[0]));
    expect(await db.select().from(documentPageWords).where(eq(documentPageWords.document_id, DOC_IDS[0]))).toEqual([]);
  });

  it("drop pages without words", async () => {
    await insertDoc(DOC_IDS[1]);
    await db.transaction((tx) => replacePageWords(tx, DOC_IDS[1], [
      { page: 1, width: 100, height: 100, unit: "px", rotation: 0, words: [] },
    ]));
    expect(await hasPageWords(DOC_IDS[1])).toBe(false);
  });

  it("store words with NUL bytes cleaned instead of failing the insert", async () => {
    await insertDoc(DOC_IDS[2]);
    await db.transaction((tx) => replacePageWords(tx, DOC_IDS[2], [
      {
        page: 1, width: 612, height: 792, unit: "pt", rotation: 0,
        words: [
          { text: "Rechnung", left: 10, top: 10, right: 50, bottom: 20 },
          { text: "\u0000", left: 50, top: 10, right: 54, bottom: 20 },
          { text: "RE-0000\u00001", left: 54, top: 10, right: 90, bottom: 20 },
        ],
      },
    ]));
    const [stored] = await loadPageWords(DOC_IDS[2]);
    expect(stored.words.map((w) => w.text)).toEqual(["Rechnung", "RE-00001"]);
  });
});

describe("the backfill queue", () => {
  it("queues ready documents without words, lowest confidence first, and none twice", async () => {
    await insertDoc(DOC_IDS[0], { confidence: 80 });
    await insertDoc(DOC_IDS[1], { confidence: 40 });
    await insertDoc(DOC_IDS[2], { status: "classifying" });
    await insertDoc(DOC_IDS[3], { confidence: 10 });
    const result = await extractPdfText(pdfPath);
    await db.transaction((tx) => replacePageWords(tx, DOC_IDS[3], result.pageWords));

    const queuedIds = async () => (await db
      .select({ id: documentScanQueue.document_id })
      .from(documentScanQueue)
      .where(and(inArray(documentScanQueue.document_id, DOC_IDS), eq(documentScanQueue.service, "page_words")))
      .orderBy(documentScanQueue.id)).map((r) => r.id);

    // Other test files may hold ready documents of their own; only ours are asserted.
    await queuePageWordsBackfill(5000);
    expect(await queuedIds()).toEqual([DOC_IDS[1], DOC_IDS[0]]);

    const again = await queuePageWordsBackfill(5000);
    expect(await queuedIds()).toEqual([DOC_IDS[1], DOC_IDS[0]]);
    expect(again.remaining).toBeGreaterThanOrEqual(2);
  });

  it("tops itself up after a job, skipping documents a job already ran for", async () => {
    await insertDoc(DOC_IDS[0], { confidence: 80 });
    await insertDoc(DOC_IDS[1], { confidence: 40 });
    await insertDoc(DOC_IDS[2], { confidence: 20 });
    // Tried before and still without words (a failed read, an empty scan).
    await db.insert(documentScanQueue).values([
      { document_id: DOC_IDS[1], service: "page_words", priority: 9, status: "done" },
      { document_id: DOC_IDS[2], service: "page_words", priority: 9, status: "failed" },
    ]);

    const pendingIds = async () => (await db
      .select({ id: documentScanQueue.document_id })
      .from(documentScanQueue)
      .where(and(
        inArray(documentScanQueue.document_id, DOC_IDS),
        eq(documentScanQueue.service, "page_words"),
        eq(documentScanQueue.status, "pending"),
      ))).map((r) => r.id);

    // Nothing of a running batch waits (never started, or cancelled while a
    // job was processing): the job on its way out starts nothing.
    await topUpPageWordsBackfill();
    expect(await pendingIds()).toEqual([]);

    // One job of the running batch still waits: the next batch follows.
    await insertDoc(DOC_IDS[3], { confidence: 90 });
    await db.insert(documentScanQueue).values({ document_id: DOC_IDS[3], service: "page_words", priority: 9, status: "pending" });
    await topUpPageWordsBackfill();
    expect((await pendingIds()).sort()).toEqual([DOC_IDS[0], DOC_IDS[3]].sort());

    // A click retries the tried ones too.
    await queuePageWordsBackfill(5000);
    expect((await pendingIds()).sort()).toEqual([DOC_IDS[0], DOC_IDS[1], DOC_IDS[2], DOC_IDS[3]].sort());
  });
});

describe("the pipeline", () => {
  let diskPath: string;

  beforeAll(() => {
    diskPath = pdfPath;
  });

  async function insertPipelineDoc(id: number, status: string, text: string | null): Promise<void> {
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, extracted_text)
          VALUES
            (${id}, ${USER_ID}, ${`sha-${id}`}, 'kaufvertrag.pdf', 'application/pdf', 1,
             ${diskPath}, ${sql.raw(`'${status}'`)}, ${text})`,
    );
  }

  it("text_extract writes the text and its words together", async () => {
    await insertPipelineDoc(DOC_IDS[0], "pending", null);
    await runTextExtract(DOC_IDS[0]);

    const [doc] = await db.select().from(documents).where(eq(documents.id, DOC_IDS[0]));
    expect(doc.text_source).toBe("text_layer");
    const pages = await loadPageWords(DOC_IDS[0]);
    expect(pages).toHaveLength(1);
    expect(pages[0].words.map((w) => w.text)).toEqual(doc.extracted_text!.split(/\s+/).filter(Boolean));
    expect((await findTextBoxes(DOC_IDS[0], "450.000")).boxes).toHaveLength(3);
  });

  it("the backfill adds words to a finished document and leaves the rest alone", async () => {
    await insertPipelineDoc(DOC_IDS[1], "pending", null);
    await runTextExtract(DOC_IDS[1]);
    await db.update(documents).set({ status: "ready" }).where(eq(documents.id, DOC_IDS[1]));
    await db.delete(documentPageWords).where(eq(documentPageWords.document_id, DOC_IDS[1]));
    const [before] = await db.select().from(documents).where(eq(documents.id, DOC_IDS[1]));

    await runPageWords(DOC_IDS[1]);

    const [after] = await db.select().from(documents).where(eq(documents.id, DOC_IDS[1]));
    expect(after.status).toBe("ready");
    expect(after.extracted_text).toBe(before.extracted_text);
    expect(await hasPageWords(DOC_IDS[1])).toBe(true);
    // Same text: nothing to re-embed.
    const embeds = await db.select().from(documentScanQueue)
      .where(and(eq(documentScanQueue.document_id, DOC_IDS[1]), eq(documentScanQueue.service, "embed")));
    expect(embeds).toEqual([]);
  });

  it("the backfill skips a document that is not finished", async () => {
    await insertPipelineDoc(DOC_IDS[2], "classifying", "Text");
    await runPageWords(DOC_IDS[2]);
    expect(await hasPageWords(DOC_IDS[2])).toBe(false);
  });
});
