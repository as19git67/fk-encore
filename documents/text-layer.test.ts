/**
 * A born-digital PDF is read from its text layer, not OCR'd.
 *
 * pdf-parse 2 dropped the function this module used to call, so the text
 * layer read threw on every PDF and every document fell through to OCR. Read
 * with pdf.js directly, a PDF that carries its text gets it back in a few
 * milliseconds. Synthetic text only.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { extractPdfText } from "./text-extract";

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
      for (const line of lines) doc.text(line);
    }
    doc.end();
  });
  return file;
}

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "text-layer-"));
});

afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe("the text layer", () => {
  it("is used for a born-digital PDF", async () => {
    const file = await writePdf("kaufvertrag.pdf", [[
      "Kaufvertrag über die Wohnung Beispielstraße 1, 12345 Musterstadt.",
      "Kaufpreis: 450.000,00 EUR",
      "Nebenkosten: 12.500,00 EUR für Notar und Grundbuch.",
    ]]);
    expect((await fs.promises.stat(file)).size).toBeLessThan(8192);

    const result = await extractPdfText(file);
    expect(result.source).toBe("text_layer");
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain("Kaufpreis: 450.000,00 EUR");
    expect(result.text).toContain("Beispielstraße 1, 12345 Musterstadt.");
    expect(result.ocrMeanConfidence).toBeNull();
  });

  it("joins pages with a blank line", async () => {
    const file = await writePdf("zwei-seiten.pdf", [
      ["Seite eins mit genug Text, damit der Textlayer als brauchbar gilt und nicht verworfen wird."],
      ["Seite zwei mit ebenso viel Text, damit beide Seiten im Ergebnis stehen."],
    ]);
    const result = await extractPdfText(file);
    expect(result.source).toBe("text_layer");
    expect(result.pageCount).toBe(2);
    expect(result.text).toMatch(/wird\.\n{2,}Seite zwei/);
  });
});
