/**
 * A redacted bundle end to end (#1532): the purchase price is found on every
 * page it stands on, the boxes go into a Sammelmappe, and the exported PDF
 * carries no text under them. Synthetic documents only.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";
import { inArray, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { spawnSync, execFileSync } from "node:child_process";

vi.mock("./scan-worker", () => ({ triggerWorkers: vi.fn() }));
// The PDFs stay in a temp directory; DOCUMENTS_DIR is shared with the fsck tests.
vi.mock("./documents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documents.service")>()),
  assertPathUnderDocumentsRoot: vi.fn(),
}));

import db from "../db/database";
import { documentCollections, documents } from "../db/schema";
import { extractPdfText } from "./text-extract";
import { replacePageWords } from "./page-words-store";
import { findDocumentTextBoxes } from "./page-words-api";
import { createCollection, renderCollectionPdf, updateCollectionItem } from "./collections";
import { redactPage } from "./collection-pdf";

/** The bundle assembly merges with qpdf; without it only the per-page checks run. */
const HAS_QPDF = spawnSync("qpdf", ["--version"]).status === 0;

/** A page rendered to grayscale pixels, as the redaction step renders it. */
async function raster(pdfPath: string, page: number): Promise<{ data: Buffer; width: number; height: number }> {
  const prefix = path.join(dir, `raster-${path.basename(pdfPath)}-${page}`);
  execFileSync("pdftoppm", ["-f", String(page), "-l", String(page), "-r", "100", "-cropbox", "-png", "-singlefile", pdfPath, prefix]);
  const { data, info } = await sharp(`${prefix}.png`).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Dark pixels inside a 0..1 rectangle. */
function ink(img: { data: Buffer; width: number; height: number }, r: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(0, Math.floor(r.x * img.width));
  const y0 = Math.max(0, Math.floor(r.y * img.height));
  const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * img.height));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (img.data[y * img.width + x] < 128) n++;
  return n;
}

const USER_ID = 991532;
const OTHER_USER = 991533;
const DOC_IDS = [991541, 991542, 991543];
let dir: string;

async function writePdf(name: string, pages: string[][]): Promise<string> {
  const file = path.join(dir, name);
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 72, autoFirstPage: false });
    const out = fs.createWriteStream(file);
    out.on("finish", () => resolve());
    out.on("error", reject);
    doc.pipe(out);
    for (const lines of pages) {
      doc.addPage();
      doc.fontSize(12);
      // Room between lines, so the strips around a box measure only its own
      // line's ink, not the descenders of the one above.
      for (const line of lines) doc.text(line).moveDown(1);
    }
    doc.end();
  });
  return file;
}

async function pdfText(bytes: Buffer): Promise<string[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((i) => ("str" in i ? i.str : "")).join(" "));
  }
  await doc.destroy();
  return pages;
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

function setAuth(userID: number) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userID),
    permissions: ["module.documents", "documents.view"],
  } as never);
}

const FILLER = "Dieser Absatz enthält nur Fülltext, damit der Textlayer lang genug ist, um ihn zu verwenden.";
const SOURCES: Array<{ id: number; name: string; pages: string[][] }> = [
  {
    id: DOC_IDS[0],
    name: "kaufvertrag.pdf",
    pages: [
      ["Kaufvertrag über die Wohnung Beispielstraße 1, 12345 Musterstadt.", "Kaufpreis: 450.000,00 EUR", FILLER],
      ["Anlage: Grundriss und Lageplan.", FILLER],
    ],
  },
  {
    id: DOC_IDS[1],
    name: "finanzierung.pdf",
    pages: [
      ["Finanzierungsbestätigung der Beispielbank.", FILLER],
      ["Finanziert wird der Kaufpreis von 450.000 € zu 80 Prozent.", FILLER],
    ],
  },
  {
    id: DOC_IDS[2],
    name: "notar.pdf",
    pages: [["Notarrechnung über 12.500,00 EUR für die Beurkundung.", FILLER]],
  },
];

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "redaction-bundle-"));
  await ensureUser(USER_ID);
  await ensureUser(OTHER_USER);
});

afterAll(async () => {
  // Rows pointing at temp files must not outlive them: fsck walks every row.
  await db.delete(documentCollections).where(inArray(documentCollections.user_id, [USER_ID, OTHER_USER]));
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
  await fs.promises.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(documentCollections).where(inArray(documentCollections.user_id, [USER_ID, OTHER_USER]));
  await db.delete(documents).where(inArray(documents.id, DOC_IDS));
  for (const source of SOURCES) {
    const file = await writePdf(source.name, source.pages);
    const result = await extractPdfText(file);
    await db.execute(
      sql`INSERT INTO documents
            (id, user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, extracted_text, title)
          VALUES
            (${source.id}, ${USER_ID}, ${`sha-${source.id}`}, ${source.name}, 'application/pdf', 1,
             ${file}, 'ready', ${result.text}, ${source.name})`,
    );
    await db.transaction((tx) => replacePageWords(tx, source.id, result.pageWords));
  }
  setAuth(USER_ID);
});

describe("a redacted bundle", () => {
  it("finds the price on every page it stands on, with boxes that cover it", async () => {
    const found = await Promise.all(DOC_IDS.map((id) => findDocumentTextBoxes({ id, q: "450.000,00" })));
    expect(found.map((f) => f.pages)).toEqual([[1], [2], []]);

    for (const [i, f] of found.entries()) {
      const [row] = await db.select({ disk_path: documents.disk_path }).from(documents).where(inArray(documents.id, [DOC_IDS[i]]));
      for (const box of f.boxes) {
        const page = await raster(row.disk_path, box.page);
        // The price's ink is inside the box …
        expect(ink(page, box)).toBeGreaterThan(20);
        // … and none of it spills over the edges: thin strips just outside
        // the box are blank.
        // Above and below: 3px. Left and right: 1px — the next word is only
        // a space away.
        const dy = 3 / page.height;
        const dx = 1 / page.width;
        expect(ink(page, { x: box.x, y: box.y - dy, w: box.w, h: dy })).toBe(0);
        expect(ink(page, { x: box.x, y: box.y + box.h, w: box.w, h: dy })).toBe(0);
        expect(ink(page, { x: box.x - dx, y: box.y, w: dx, h: box.h })).toBe(0);
        expect(ink(page, { x: box.x + box.w, y: box.y, w: dx, h: box.h })).toBe(0);

        // After redaction nothing of it is left: the box is black, and the
        // page carries no text that could be copied out.
        const out = await redactPage(row.disk_path, box.page, [box], path.join(dir, `red-${DOC_IDS[i]}-${box.page}`));
        const redacted = await raster(out, 1);
        const area = Math.round(box.w * redacted.width) * Math.round(box.h * redacted.height);
        expect(ink(redacted, box)).toBeGreaterThanOrEqual(area * 0.9);
        expect((await pdfText(fs.readFileSync(out))).join(" ")).not.toContain("450.000");
      }
    }
  });

  it.skipIf(!HAS_QPDF)("builds the bundle with the boxes burnt in and the other pages untouched", async () => {
    const found = await Promise.all(DOC_IDS.map((id) => findDocumentTextBoxes({ id, q: "450.000,00" })));
    const collection = await createCollection({ title: "Kauf Musterstadt", document_ids: DOC_IDS });
    for (const [i, id] of DOC_IDS.entries()) {
      if (found[i].boxes.length) {
        await updateCollectionItem({ id: collection.id, documentId: id, redactions: found[i].boxes });
      }
    }

    const pdf = await renderCollectionPdf(collection.id, USER_ID, false);
    expect(pdf.skipped).toEqual([]);
    const text = (await pdfText(pdf.bytes)).join("\n");
    expect(text).not.toContain("450.000");
    // Pages without a box keep their text layer.
    expect(text).toContain("Notarrechnung über 12.500,00 EUR");
    expect(text).toContain("Anlage: Grundriss und Lageplan.");
    expect(text).toContain("Finanzierungsbestätigung der Beispielbank.");
  });

  it("answers only for documents the caller may see", async () => {
    setAuth(OTHER_USER);
    await expect(findDocumentTextBoxes({ id: DOC_IDS[0], q: "450.000" })).rejects.toThrow("not found");
  });

  it("reports a document without word positions", async () => {
    await db.execute(sql`DELETE FROM document_page_words WHERE document_id = ${DOC_IDS[2]}`);
    expect(await findDocumentTextBoxes({ id: DOC_IDS[2], q: "12.500,00" })).toEqual({ status: "no_words", boxes: [], pages: [] });
  });
});
