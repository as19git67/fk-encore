import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const EXPORT_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || "/tmp"}/collection-exports-test-${process.pid}`;
  process.env.COLLECTION_EXPORTS_DIR = dir;
  return dir;
});

import { getAuthData } from "~encore/auth";
import { inArray, sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { execFileSync } from "child_process";

import db from "../db/database";
import {
  documentCollectionItems,
  financeAccount,
  financeAccountAccess,
  financeAccountType,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  photos,
} from "../db/schema";
import { DOCUMENTS_DIR } from "../documents/documents.service";
import { createAnyCollection, getBasket, addToBasket } from "./collections";
import {
  awaitExportRun,
  deleteExportProfile,
  getExport,
  getExportSetup,
  listExports,
  purgeExpiredExports,
  saveExportAsDocument,
  saveExportProfile,
  startExport,
  COLLECTION_EXPORTS_DIR,
  type ExportRun,
} from "./exports";
import { ExportOptionsError, normalizeExportOptions, safeFileName, uniqueName } from "./export-options";
import { renderTable, sheetName, type TableDocument } from "./export-tables";

const OWNER = 952_001;
const MEMBER = 952_002;
const GROUP = 952_010;
const USERS = [OWNER, MEMBER];
const FILES_DIR = path.join(DOCUMENTS_DIR, `collections-export-test-${process.pid}`);

/** The combined document PDF counts pages with qpdf. */
const qpdf = (() => {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ALL_PERMISSIONS = [
  "module.documents",
  "documents.view",
  "documents.upload",
  "module.photos",
  "photos.view",
  "finance.view",
  "meters.view",
];

function as(userId: number, permissions: string[] = ALL_PERMISSIONS): void {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(userId), permissions });
}

const created = { photos: [] as number[], accounts: [] as number[], meters: [] as number[] };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM document_collections WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  await db.execute(sql`DELETE FROM documents WHERE user_id IN (${sql.join(USERS, sql`, `)})`);
  if (created.accounts.length) {
    await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, created.accounts));
    await db.delete(financeAccountAccess).where(inArray(financeAccountAccess.account_id, created.accounts));
    await db.delete(financeAccount).where(inArray(financeAccount.id, created.accounts));
  }
  if (created.meters.length) await db.delete(meters).where(inArray(meters.id, created.meters));
  if (created.photos.length) await db.delete(photos).where(inArray(photos.id, created.photos));
  created.photos = [];
  created.accounts = [];
  created.meters = [];
  await db.execute(sql`DELETE FROM group_members WHERE group_id = ${GROUP}`);
  await db.execute(sql`DELETE FROM groups WHERE id = ${GROUP}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

beforeEach(async () => {
  await cleanup();
  for (const id of USERS) {
    await db.execute(sql`
      INSERT INTO users (id, email, name, password_hash)
      VALUES (${id}, ${`u${id}@exports.test`}, ${`User ${id}`}, 'x')
    `);
  }
  await db.execute(sql`INSERT INTO groups (id, slug, name) VALUES (${GROUP}, ${`g${GROUP}`}, 'Haushalt')`);
  await db.execute(sql`
    INSERT INTO group_members (group_id, user_id, role)
    VALUES (${GROUP}, ${OWNER}, 'owner'), (${GROUP}, ${MEMBER}, 'member')
  `);
  await fs.promises.mkdir(FILES_DIR, { recursive: true });
  as(OWNER);
});

afterAll(async () => {
  await cleanup();
  await fs.promises.rm(FILES_DIR, { recursive: true, force: true });
  await fs.promises.rm(EXPORT_DIR, { recursive: true, force: true });
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0;

/** A real JPEG on disk carrying a camera make in its EXIF. */
async function photo(userId: number, name: string): Promise<number> {
  seq += 1;
  const file = path.join(FILES_DIR, `photo-${seq}.jpg`);
  await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "Beispielkamera" } })
    .toFile(file);
  const [row] = await db
    .insert(photos)
    .values({
      user_id: userId,
      filename: `exports-test-${seq}.jpg`,
      external_path: file,
      original_name: name,
      mime_type: "image/jpeg",
      size: 1000,
      taken_at: "2026-05-01 10:00:00",
    })
    .returning({ id: photos.id });
  created.photos.push(row!.id);
  return row!.id;
}

async function account(label: string, readers: number[]): Promise<number> {
  const [type] = await db.select({ id: financeAccountType.id }).from(financeAccountType).limit(1);
  const [row] = await db
    .insert(financeAccount)
    .values({ type_id: type!.id, currency_code: "EUR", account_number: `EXP-${++seq}`, label })
    .returning({ id: financeAccount.id });
  created.accounts.push(row!.id);
  for (const userId of readers) {
    await db.insert(financeAccountAccess).values({ account_id: row!.id, user_id: userId, level: "read" });
  }
  return row!.id;
}

async function transaction(accountId: number, counterparty: string, amount: string, date = "2026-03-01"): Promise<number> {
  const [row] = await db
    .insert(financeTransaction)
    .values({
      account_id: accountId,
      booking_date: date,
      amount,
      currency_code: "EUR",
      counterparty,
      purpose: "Beispielzweck",
      dedupe_hash: `exports-test-${++seq}`,
    })
    .returning({ id: financeTransaction.id });
  return row!.id;
}

async function meterWithReadings(values: Array<[string, string]>): Promise<number> {
  const [m] = await db
    .insert(meters)
    .values({ name: "Wasser Haupt", type: "water", unit: "m3", owner_user_id: OWNER })
    .returning({ id: meters.id });
  created.meters.push(m!.id);
  const [device] = await db
    .insert(meterDevices)
    .values({ meter_id: m!.id, installed_at: "2020-01-01T00:00:00Z", start_value: "0", serial_number: "SN-0000" })
    .returning({ id: meterDevices.id });
  for (const [day, value] of values) {
    await db.insert(meterReadings).values({ device_id: device!.id, value, taken_at: `${day}T08:00:00Z`, source: "manual" });
  }
  return m!.id;
}

/** A document with a real one-page PDF under DOCUMENTS_DIR. */
async function pdfDocument(userId: number, title: string): Promise<number> {
  seq += 1;
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText(title, { x: 20, y: 100, size: 12 });
  const file = path.join(FILES_DIR, `doc-${seq}.pdf`);
  await fs.promises.writeFile(file, await pdf.save());
  const row = await db.execute<{ id: number }>(sql`
    INSERT INTO documents
      (user_id, sha256, original_filename, mime_type, size_bytes, disk_path, status, title, visibility)
    VALUES
      (${userId}, ${`exp-${seq}-${"0".repeat(60)}`.slice(0, 64)}, ${`beleg-${seq}.pdf`},
       'application/pdf', 1000, ${file}, 'ready', ${title}, 'private')
    RETURNING id
  `);
  return row.rows[0]!.id;
}

async function finished(run: ExportRun): Promise<ExportRun> {
  await awaitExportRun(run.id);
  return await getExport({ exportId: run.id });
}

async function fileOf(run: ExportRun): Promise<Buffer> {
  return await fs.promises.readFile(path.join(COLLECTION_EXPORTS_DIR, String(run.id)));
}

// ─── Options and tables ─────────────────────────────────────────────────────

describe("export options", () => {
  it("fills what is missing and refuses what is wrong", () => {
    const o = normalizeExportOptions({ transaction: { format: "xlsx", columns: ["amount", "nonsense", "booking_date"] } });
    expect(o.transaction.format).toBe("xlsx");
    // Order follows the known columns, unknown ones drop out.
    expect(o.transaction.columns).toEqual(["booking_date", "amount"]);
    expect(o.document.format).toBe("pdf");
    expect(() => normalizeExportOptions({ photo: { size: "huge" } })).toThrow(ExportOptionsError);
    expect(() => normalizeExportOptions({ meter: { from: "2026-05-01", to: "2026-01-01" } })).toThrow(ExportOptionsError);
    expect(() => normalizeExportOptions({ transaction: { columns: [] } })).toThrow(ExportOptionsError);
  });

  it("makes safe and unique file names", () => {
    expect(safeFileName("a/b:c*?.pdf")).toBe("a-b-c--.pdf");
    expect(safeFileName("   ")).toBe("datei");
    const taken = new Set<string>();
    expect(uniqueName("Foto.jpg", taken)).toBe("Foto.jpg");
    expect(uniqueName("foto.jpg", taken)).toBe("foto (2).jpg");
  });

  it("keeps Excel sheet names legal and distinct", () => {
    const taken = new Set<string>();
    expect(sheetName("Konto [privat]: Haupt", taken)).toBe("Konto -privat-- Haupt");
    expect(sheetName("Konto [privat]: Haupt", taken)).toBe("Konto -privat-- Haupt 2");
  });
});

describe("tables", () => {
  const doc: TableDocument = {
    title: "Test",
    columns: [
      { label: "Datum", kind: "date" },
      { label: "Text", kind: "text" },
      { label: "Betrag", kind: "money" },
    ],
    sections: [
      { title: "A", rows: [["2026-01-02", 'Zitat "hier", mit Komma', -12.5]], footer: ["Summe", null, -12.5] },
      { title: "B", rows: [["2026-02-03", "Zweite", 3]] },
    ],
  };

  it("writes CSV with one header and escaped fields", async () => {
    const csv = (await renderTable(doc, "csv")).bytes.toString("utf8");
    expect(csv.startsWith("﻿Datum,Text,Betrag\n")).toBe(true);
    expect(csv).toContain('2026-01-02,"Zitat ""hier"", mit Komma",-12.5');
    expect(csv.trim().split("\n")).toHaveLength(3);
  });

  it("writes one Excel sheet per section with numbers as numbers", async () => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await renderTable(doc, "xlsx")).bytes);
    expect(book.worksheets.map((s) => s.name)).toEqual(["A", "B"]);
    expect(book.worksheets[0]!.getRow(2).getCell(3).value).toBe(-12.5);
    expect(book.worksheets[0]!.getRow(3).getCell(1).value).toBe("Summe");
  });

  it("writes a PDF", async () => {
    const pdf = (await renderTable(doc, "pdf")).bytes;
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

// ─── Runs ───────────────────────────────────────────────────────────────────

describe("exporting a collection", () => {
  it("writes a transaction collection as one workbook with a sheet per account in the chosen order", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const card = await account("Kreditkarte", [OWNER]);
    const a = await transaction(giro, "Bäckerei Muster", "-4.20");
    const b = await transaction(card, "Versand GmbH", "-19.99");
    const c = await transaction(card, "Erstattung", "5.00");
    const col = await createAnyCollection({
      name: "Steuer 2026",
      members: [a, b, c].map((id) => ({ entity_type: "transaction" as const, entity_id: id })),
    });

    const setup = await getExportSetup({ id: col.id });
    expect(setup.groups).toEqual({ transaction: 3 });
    expect(setup.accounts.map((x) => x.label)).toEqual(["Girokonto", "Kreditkarte"]);

    const run = await finished(
      await startExport({ id: col.id, options: { transaction: { format: "xlsx", account_order: [card, giro] } } }),
    );
    expect(run.status).toBe("done");
    expect(run.filename).toBe("Steuer 2026 - Buchungen.xlsx");
    expect(run.item_count).toBe(3);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await fileOf(run));
    expect(book.worksheets.map((s) => s.name)).toEqual(["Kreditkarte", "Girokonto"]);
    const card_sheet = book.worksheets[0]!;
    const sumRow = card_sheet.getRow(card_sheet.rowCount);
    expect(sumRow.values).toContain(-14.99);
  });

  it("puts a mixed collection into a ZIP with a folder per type and an index naming what is missing", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const tx = await transaction(giro, "Stadtwerke Beispiel", "-80.00");
    const ph = await photo(OWNER, "Zaehler.jpg");
    const meterId = await meterWithReadings([
      ["2026-01-01", "100"],
      ["2026-02-01", "112.5"],
    ]);
    const doc = await pdfDocument(OWNER, "Abrechnung");
    const switchedOff = await pdfDocument(OWNER, "Entwurf");
    const col = await createAnyCollection({
      name: "Nebenkosten",
      members: [
        { entity_type: "transaction", entity_id: tx },
        { entity_type: "photo", entity_id: ph },
        { entity_type: "meter", entity_id: meterId },
        { entity_type: "document", entity_id: doc },
        { entity_type: "document", entity_id: switchedOff },
      ],
    });
    await db.execute(sql`
      UPDATE ${documentCollectionItems} SET included = false
      WHERE collection_id = ${col.id} AND document_id = ${switchedOff}
    `);

    const run = await finished(
      await startExport({
        id: col.id,
        options: { document: { format: "zip" }, transaction: { format: "csv" }, meter: { format: "csv" }, photo: { strip_metadata: true } },
      }),
    );
    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    expect(run.filename).toBe("Nebenkosten.zip");
    expect(run.skipped).toEqual([{ entity_type: "document", entity_id: switchedOff, reason: "switched_off" }]);

    const zip = await JSZip.loadAsync(await fileOf(run));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir).sort();
    expect(names).toEqual([
      "Buchungen/Buchungen.csv",
      `Dokumente/beleg-${seq - 1}.pdf`,
      "Fotos/Zaehler.jpg",
      "Inhalt.csv",
      "Inhalt.pdf",
      "Zaehler/Zaehler.csv",
    ]);
    const index = await zip.file("Inhalt.csv")!.async("string");
    expect(index).toContain("Entwurf");
    expect(index).toContain("in der Mappe ausgeschaltet");
    const readings = await zip.file("Zaehler/Zaehler.csv")!.async("string");
    expect(readings).toContain("2026-02-01,112.5,12.5,m3");

    // Re-encoded without metadata: the camera make is gone.
    const jpeg = await zip.file("Fotos/Zaehler.jpg")!.async("nodebuffer");
    expect((await sharp(jpeg).metadata()).exif).toBeUndefined();
  });

  it.skipIf(!qpdf)("joins the documents into one PDF and leaves out the switched-off one", async () => {
    const a = await pdfDocument(OWNER, "Erste Seite");
    const b = await pdfDocument(OWNER, "Zweite Seite");
    const off = await pdfDocument(OWNER, "Ausgeschaltet");
    const col = await createAnyCollection({
      name: "Akte",
      members: [a, b, off].map((id) => ({ entity_type: "document" as const, entity_id: id })),
    });
    await db.execute(sql`
      UPDATE ${documentCollectionItems} SET included = false
      WHERE collection_id = ${col.id} AND document_id = ${off}
    `);
    const run = await finished(await startExport({ id: col.id }));
    expect(run.error).toBeNull();
    expect(run.filename).toBe("Akte.pdf");
    expect(run.item_count).toBe(2);
    const pdf = await PDFDocument.load(await fileOf(run));
    // Two documents and a table of contents in front.
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("hands a photo out untouched when neither size nor metadata change", async () => {
    const ph = await photo(OWNER, "Original.jpg");
    const col = await createAnyCollection({ name: "Fotos", members: [{ entity_type: "photo", entity_id: ph }] });
    const run = await finished(await startExport({ id: col.id }));
    const zip = await JSZip.loadAsync(await fileOf(run));
    const jpeg = await zip.file("Fotos/Original.jpg")!.async("nodebuffer");
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
  });

  it("exports the basket like any collection", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const tx = await transaction(giro, "Kiosk", "-2.00");
    await addToBasket({ members: [{ entity_type: "transaction", entity_id: tx }] });
    const basket = await getBasket();
    const run = await finished(await startExport({ id: basket.id, options: { transaction: { format: "pdf" } } }));
    expect(run.filename).toBe("Basket - Buchungen.pdf");
    expect(run.mime_type).toBe("application/pdf");
  });

  it("leaves out what a reader of a group collection may not see, and keeps runs per reader", async () => {
    const own = await account("Privatkonto", [OWNER]);
    const shared = await account("Haushaltskonto", [OWNER, MEMBER]);
    const hidden = await transaction(own, "Privat", "-1.00");
    const visible = await transaction(shared, "Supermarkt", "-30.00");
    const col = await createAnyCollection({
      name: "Haushalt",
      visibility: "group",
      group_id: GROUP,
      members: [hidden, visible].map((id) => ({ entity_type: "transaction" as const, entity_id: id })),
    });
    const ownerRun = await finished(await startExport({ id: col.id, options: { transaction: { format: "csv" } } }));

    as(MEMBER);
    const run = await finished(await startExport({ id: col.id, options: { transaction: { format: "csv" } } }));
    const csv = (await fileOf(run)).toString("utf8");
    expect(csv).toContain("Supermarkt");
    expect(csv).not.toContain("Privat");
    expect((await listExports({ id: col.id })).items.map((r) => r.id)).toEqual([run.id]);
    await expect(getExport({ exportId: ownerRun.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a collection with nothing to export", async () => {
    const col = await createAnyCollection({ name: "Leer" });
    await expect(startExport({ id: col.id })).resolves.toMatchObject({ status: "running" });
    const runs = (await listExports({ id: col.id })).items;
    await awaitExportRun(runs[0]!.id);
    expect(await getExport({ exportId: runs[0]!.id })).toMatchObject({ status: "failed" });
  });
});

describe("profiles", () => {
  it("saves options under a name, overwrites by name and drives a run", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const tx = await transaction(giro, "Bäckerei", "-3.10");
    const col = await createAnyCollection({ name: "Belege", members: [{ entity_type: "transaction", entity_id: tx }] });

    const first = await saveExportProfile({ id: col.id, name: "Steuerberater", options: { transaction: { format: "csv" } } });
    const again = await saveExportProfile({ id: col.id, name: "steuerberater", options: { transaction: { format: "xlsx", columns: ["amount"] } } });
    expect(again.id).toBe(first.id);
    expect(again.options.transaction).toMatchObject({ format: "xlsx", columns: ["amount"] });
    expect((await getExportSetup({ id: col.id })).profiles).toHaveLength(1);

    const run = await finished(await startExport({ id: col.id, profile_id: first.id }));
    expect(run.profile_id).toBe(first.id);
    expect(run.filename?.endsWith(".xlsx")).toBe(true);

    await deleteExportProfile({ id: col.id, profileId: first.id });
    expect((await getExportSetup({ id: col.id })).profiles).toHaveLength(0);
    await expect(saveExportProfile({ id: col.id, name: "x", options: { document: { format: "docx" } } })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("after the run", () => {
  it("files a PDF export as a document, once", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const tx = await transaction(giro, "Versicherung", "-120.00");
    const col = await createAnyCollection({ name: "Versicherung", members: [{ entity_type: "transaction", entity_id: tx }] });
    const run = await finished(await startExport({ id: col.id }));
    expect(run.mime_type).toBe("application/pdf");
    const saved = await saveExportAsDocument({ exportId: run.id });
    expect(saved.already_existed).toBe(false);
    const again = await saveExportAsDocument({ exportId: run.id });
    expect(again).toEqual({ document_id: saved.document_id, already_existed: true });
  });

  it("refuses to file a ZIP as a document", async () => {
    const ph = await photo(OWNER, "Bild.jpg");
    const col = await createAnyCollection({ name: "Bilder", members: [{ entity_type: "photo", entity_id: ph }] });
    const run = await finished(await startExport({ id: col.id }));
    await expect(saveExportAsDocument({ exportId: run.id })).rejects.toMatchObject({ code: "failed_precondition" });
  });

  it("drops expired runs and their files", async () => {
    const giro = await account("Girokonto", [OWNER]);
    const tx = await transaction(giro, "Alt", "-1.00");
    const col = await createAnyCollection({ name: "Alt", members: [{ entity_type: "transaction", entity_id: tx }] });
    const run = await finished(await startExport({ id: col.id }));
    await db.execute(sql`UPDATE collection_exports SET expires_at = now() - interval '1 minute' WHERE id = ${run.id}`);
    await purgeExpiredExports();
    expect(fs.existsSync(path.join(COLLECTION_EXPORTS_DIR, String(run.id)))).toBe(false);
    expect((await listExports({ id: col.id })).items).toHaveLength(0);
  });
});
