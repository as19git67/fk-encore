/**
 * One exporter per member type (#1548, stage 6).
 *
 * Each takes the ids of the members the reader may see (collections.ts has
 * already asked every module's access rule) and turns them into files: one
 * PDF, CSV or workbook for the table types, one file per item for documents
 * and photos. What could not go in is reported per item, never dropped
 * silently, so the index of the ZIP can say why.
 *
 * Exporters read the modules' tables directly, as the member resolvers do;
 * none of them calls another service's endpoint.
 */

import fs from "fs";
import sharp, { type Sharp } from "sharp";
import { and, asc, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import {
  albumPhotos,
  albums,
  documentCollectionItems,
  documents,
  financeAccount,
  financeAccountHolding,
  financeDepotSecurity,
  financeTag,
  financeTagTransaction,
  financeTransaction,
  meterDevices,
  meterReadings,
  meters,
  photos,
  type CollectionEntityType,
} from "../db/schema";
import { accessiblePhotoCondition } from "../photo/photo-file-access";
import { getPhotoDiskPath } from "../photo/photo.service";
import { buildCollectionPdf, type CollectionPdfMember } from "../documents/collection-pdf";
import { exportSourcePath } from "../documents/collection-export";
import { latestQuotes } from "../finance/quote-store";
import {
  TYPE_FOLDERS,
  safeFileName,
  uniqueName,
  type ExportOptions,
  type PhotoExportOptions,
  type TransactionColumn,
} from "./export-options";
import { renderTable, type Cell, type TableColumn, type TableDocument, type TableSection } from "./export-tables";

/** A file of the export: bytes in memory, or a file on disk streamed in. */
export interface ExportFile {
  /** Path inside the ZIP (folder/name), or the download name of a single file. */
  name: string;
  mime: string;
  bytes?: Buffer;
  source?: string;
}

export interface ExportSkip {
  entity_type: CollectionEntityType;
  entity_id: number;
  reason: string;
}

/** One line of the ZIP's index: every item, and where it went. */
export interface IndexLine {
  type: CollectionEntityType;
  id: number;
  title: string;
  date: string | null;
  file: string | null;
}

export interface TypeExport {
  files: ExportFile[];
  skipped: ExportSkip[];
  index: IndexLine[];
}

export interface ExportContext {
  userId: number;
  collectionId: number;
  collectionName: string;
  /** Visible member ids of this type, in the collection's order. */
  ids: number[];
  /** Titles and dates as the collection shows them, for the index. */
  display: Map<number, { title: string; date: string | null }>;
  options: ExportOptions;
  /** Folder inside the ZIP, or "" when this type is the whole export. */
  folder: string;
}

type Exporter = (ctx: ExportContext) => Promise<TypeExport>;

function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : null;
}

function indexFor(ctx: ExportContext, type: CollectionEntityType, id: number, file: string | null): IndexLine {
  const shown = ctx.display.get(id);
  return { type, id, title: shown?.title ?? `#${id}`, date: shown?.date ?? null, file };
}

/** A table export as one file named after the collection and the type. */
async function tableFile(ctx: ExportContext, label: string, doc: TableDocument, format: ExportOptions["transaction"]["format"]): Promise<ExportFile> {
  const rendered = await renderTable(doc, format);
  const base = ctx.folder ? label : `${ctx.collectionName} - ${label}`;
  return {
    name: joinPath(ctx.folder, `${safeFileName(base, label)}.${rendered.ext}`),
    mime: rendered.mime,
    bytes: rendered.bytes,
  };
}

// ─── Documents ──────────────────────────────────────────────────────────────

interface DocRow {
  id: number;
  title: string | null;
  original_filename: string;
  mime_type: string;
  disk_path: string;
  receipt_ocr_state: string | null;
  sender: string | null;
  doc_date: string | null;
  included: boolean;
  excluded_pages: number[];
  redactions: Array<{ page: number; x: number; y: number; w: number; h: number }>;
}

async function loadDocRows(collectionId: number, ids: number[]): Promise<DocRow[]> {
  if (ids.length === 0) return [];
  return await dbAll<DocRow>(
    db
      .select({
        id: documents.id,
        title: documents.title,
        original_filename: documents.original_filename,
        mime_type: documents.mime_type,
        disk_path: documents.disk_path,
        receipt_ocr_state: documents.receipt_ocr_state,
        sender: documents.sender,
        doc_date: documents.doc_date,
        included: documentCollectionItems.included,
        excluded_pages: documentCollectionItems.excluded_pages,
        redactions: documentCollectionItems.redactions,
      })
      .from(documentCollectionItems)
      .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
      .where(and(eq(documentCollectionItems.collection_id, collectionId), inArray(documents.id, ids)))
      .orderBy(asc(documentCollectionItems.position)),
  );
}

const exportDocuments: Exporter = async (ctx) => {
  const rows = await loadDocRows(ctx.collectionId, ctx.ids);
  const out: TypeExport = { files: [], skipped: [], index: [] };

  if (ctx.options.document.format === "pdf") {
    // The collection's own page selection and redactions apply: a page blacked
    // out for the folder's PDF is blacked out here too.
    const members: CollectionPdfMember[] = [];
    for (const row of rows) {
      if (!row.included) {
        out.skipped.push({ entity_type: "document", entity_id: row.id, reason: "switched_off" });
        out.index.push(indexFor(ctx, "document", row.id, null));
        continue;
      }
      const source = await exportSourcePath({ id: row.id, disk_path: row.disk_path, receipt_ocr_state: row.receipt_ocr_state });
      if (!source) {
        out.skipped.push({ entity_type: "document", entity_id: row.id, reason: "file_missing" });
        out.index.push(indexFor(ctx, "document", row.id, null));
        continue;
      }
      members.push({
        document_id: row.id,
        title: row.title?.trim() || row.original_filename,
        sender: row.sender,
        doc_date: row.doc_date,
        source_path: source.path,
        mime_type: source.mime || row.mime_type,
        excluded_pages: row.excluded_pages ?? [],
        redactions: row.redactions ?? [],
      });
    }
    if (members.length === 0) return out;
    const built = await buildCollectionPdf(
      {
        title: ctx.collectionName,
        notes: null,
        summary: null,
        include_cover: false,
        include_toc: members.length > 1,
        include_summary: false,
      },
      members,
    );
    const name = joinPath(ctx.folder, `${safeFileName(ctx.folder ? "Dokumente" : ctx.collectionName, "Dokumente")}.pdf`);
    out.files.push({ name, mime: "application/pdf", bytes: built.bytes });
    const left = new Set(built.skipped.map((s) => s.document_id));
    for (const s of built.skipped) out.skipped.push({ entity_type: "document", entity_id: s.document_id, reason: s.reason });
    for (const m of members) out.index.push(indexFor(ctx, "document", m.document_id, left.has(m.document_id) ? null : name));
    return out;
  }

  // The original files, as uploaded. A document switched off in the folder
  // stays out here too; redactions only exist in the PDF, so a document with
  // blacked-out parts does not go out as its original.
  const taken = new Set<string>();
  for (const row of rows) {
    if (!row.included) {
      out.skipped.push({ entity_type: "document", entity_id: row.id, reason: "switched_off" });
      out.index.push(indexFor(ctx, "document", row.id, null));
      continue;
    }
    if ((row.redactions ?? []).length > 0) {
      out.skipped.push({ entity_type: "document", entity_id: row.id, reason: "redacted" });
      out.index.push(indexFor(ctx, "document", row.id, null));
      continue;
    }
    try {
      await fs.promises.access(row.disk_path, fs.constants.R_OK);
    } catch {
      out.skipped.push({ entity_type: "document", entity_id: row.id, reason: "file_missing" });
      out.index.push(indexFor(ctx, "document", row.id, null));
      continue;
    }
    const name = joinPath(ctx.folder, uniqueName(safeFileName(row.original_filename, `dokument-${row.id}`), taken));
    out.files.push({ name, mime: row.mime_type, source: row.disk_path });
    out.index.push(indexFor(ctx, "document", row.id, name));
  }
  return out;
};

// ─── Photos and albums ──────────────────────────────────────────────────────

interface PhotoRow {
  id: number;
  filename: string;
  external_path: string | null;
  original_name: string;
  mime_type: string;
}

const LARGE_EDGE = 2560;

const KEEP_FORMAT: Record<string, { ext: string; apply: (s: Sharp) => Sharp }> = {
  "image/jpeg": { ext: ".jpg", apply: (s) => s.jpeg({ quality: 95 }) },
  "image/jpg": { ext: ".jpg", apply: (s) => s.jpeg({ quality: 95 }) },
  "image/png": { ext: ".png", apply: (s) => s.png() },
  "image/webp": { ext: ".webp", apply: (s) => s.webp({ quality: 95 }) },
};

function withExt(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + ext;
}

/**
 * One photo as the options ask: the stored file untouched, or re-encoded —
 * which is what drops EXIF and XMP (GPS, camera), since sharp writes no
 * metadata unless told to. The image is turned upright first, because the
 * orientation flag goes with the metadata.
 */
export async function photoFile(
  row: PhotoRow,
  options: PhotoExportOptions,
  folder: string,
  taken: Set<string>,
): Promise<ExportFile | { reason: string }> {
  const source = getPhotoDiskPath(row);
  try {
    await fs.promises.access(source, fs.constants.R_OK);
  } catch {
    return { reason: "file_missing" };
  }
  const base = safeFileName(row.original_name, `foto-${row.id}`);
  if (options.size === "original" && !options.strip_metadata) {
    return { name: joinPath(folder, uniqueName(base, taken)), mime: row.mime_type, source };
  }
  try {
    let image = sharp(source, { failOn: "none" }).rotate();
    let ext = ".jpg";
    let mime = "image/jpeg";
    if (options.size === "large") {
      image = image
        .resize({ width: LARGE_EDGE, height: LARGE_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 88 });
    } else {
      const keep = KEEP_FORMAT[row.mime_type.toLowerCase()];
      if (keep) {
        image = keep.apply(image);
        ext = keep.ext;
        mime = row.mime_type.toLowerCase() === "image/jpg" ? "image/jpeg" : row.mime_type.toLowerCase();
      } else {
        image = image.jpeg({ quality: 95 });
      }
    }
    const bytes = await image.toBuffer();
    return { name: joinPath(folder, uniqueName(withExt(base, ext), taken)), mime, bytes };
  } catch {
    return { reason: "unreadable" };
  }
}

async function loadPhotoRows(userId: number, ids: number[]): Promise<Map<number, PhotoRow>> {
  if (ids.length === 0) return new Map();
  const rows = await dbAll<PhotoRow>(
    db
      .select({
        id: photos.id,
        filename: photos.filename,
        external_path: photos.external_path,
        original_name: photos.original_name,
        mime_type: photos.mime_type,
      })
      .from(photos)
      .where(and(inArray(photos.id, ids), accessiblePhotoCondition(userId))),
  );
  return new Map(rows.map((r) => [Number(r.id), r]));
}

const exportPhotos: Exporter = async (ctx) => {
  const rows = await loadPhotoRows(ctx.userId, ctx.ids);
  const out: TypeExport = { files: [], skipped: [], index: [] };
  const taken = new Set<string>();
  const folder = ctx.folder || TYPE_FOLDERS.photo;
  for (const id of ctx.ids) {
    const row = rows.get(id);
    const file = row ? await photoFile(row, ctx.options.photo, folder, taken) : { reason: "not_visible" };
    if ("reason" in file) {
      out.skipped.push({ entity_type: "photo", entity_id: id, reason: file.reason });
      out.index.push(indexFor(ctx, "photo", id, null));
    } else {
      out.files.push(file);
      out.index.push(indexFor(ctx, "photo", id, file.name));
    }
  }
  return out;
};

/** An album is a folder of the photos in it that the reader may see. */
const exportAlbums: Exporter = async (ctx) => {
  const out: TypeExport = { files: [], skipped: [], index: [] };
  if (ctx.ids.length === 0) return out;
  const albumRows = await dbAll<{ id: number; name: string }>(
    db.select({ id: albums.id, name: albums.name }).from(albums).where(inArray(albums.id, ctx.ids)),
  );
  const names = new Map(albumRows.map((a) => [Number(a.id), a.name]));
  const root = ctx.folder || TYPE_FOLDERS.album;
  const folders = new Set<string>();
  for (const albumId of ctx.ids) {
    const members = await dbAll<{ photo_id: number }>(
      db
        .select({ photo_id: albumPhotos.photo_id })
        .from(albumPhotos)
        .where(eq(albumPhotos.album_id, albumId))
        .orderBy(asc(albumPhotos.added_at)),
    );
    const rows = await loadPhotoRows(ctx.userId, members.map((m) => Number(m.photo_id)));
    const folder = `${root}/${uniqueName(safeFileName(names.get(albumId) ?? `album-${albumId}`), folders)}`;
    const taken = new Set<string>();
    let written = 0;
    for (const m of members) {
      const row = rows.get(Number(m.photo_id));
      if (!row) continue;
      const file = await photoFile(row, ctx.options.album, folder, taken);
      if ("reason" in file) {
        out.skipped.push({ entity_type: "photo", entity_id: row.id, reason: file.reason });
      } else {
        out.files.push(file);
        written++;
      }
    }
    out.index.push(indexFor(ctx, "album", albumId, written > 0 ? `${folder}/` : null));
  }
  return out;
};

// ─── Transactions ───────────────────────────────────────────────────────────

const TX_COLUMN_DEFS: Record<TransactionColumn, TableColumn> = {
  booking_date: { label: "Buchungstag", kind: "date" },
  value_date: { label: "Valuta", kind: "date" },
  account: { label: "Konto", kind: "text", weight: 1.5 },
  counterparty: { label: "Gegenseite", kind: "text" },
  counterparty_iban: { label: "IBAN Gegenseite", kind: "text", weight: 1.6 },
  purpose: { label: "Verwendungszweck", kind: "text", weight: 3 },
  amount: { label: "Betrag", kind: "money" },
  currency: { label: "Währung", kind: "text", weight: 0.6 },
  tags: { label: "Tags", kind: "text", weight: 1.4 },
  notice: { label: "Notiz", kind: "text", weight: 1.6 },
};

interface TxRow {
  id: number;
  account_id: number;
  account_label: string;
  booking_date: string;
  value_date: string | null;
  counterparty: string | null;
  counterparty_iban: string | null;
  purpose: string | null;
  amount: string;
  currency_code: string | null;
  notice: string | null;
}

/** Sums per currency; one number when there is one currency. */
function sumCells(rows: TxRow[], columns: TransactionColumn[], label: string): Cell[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const cur = r.currency_code ?? "EUR";
    sums.set(cur, (sums.get(cur) ?? 0) + Number(r.amount));
  }
  const single = sums.size <= 1;
  const [onlyCurrency, onlySum] = [...sums.entries()][0] ?? ["EUR", 0];
  const mixed = [...sums.entries()].map(([c, v]) => `${v.toFixed(2)} ${c}`).join("; ");
  let labelled = false;
  return columns.map((c) => {
    if (c === "amount") return single ? Math.round(onlySum * 100) / 100 : null;
    if (c === "currency") return single ? onlyCurrency : mixed;
    if (!labelled && TX_COLUMN_DEFS[c].kind === "text") {
      labelled = true;
      return single || columns.includes("currency") ? label : `${label}: ${mixed}`;
    }
    return null;
  });
}

const exportTransactions: Exporter = async (ctx) => {
  const opts = ctx.options.transaction;
  const out: TypeExport = { files: [], skipped: [], index: [] };
  const rows =
    ctx.ids.length === 0
      ? []
      : await dbAll<TxRow>(
          db
            .select({
              id: financeTransaction.id,
              account_id: financeTransaction.account_id,
              account_label: financeAccount.label,
              booking_date: financeTransaction.booking_date,
              value_date: financeTransaction.value_date,
              counterparty: financeTransaction.counterparty,
              counterparty_iban: financeTransaction.counterparty_iban,
              purpose: financeTransaction.purpose,
              amount: financeTransaction.amount,
              currency_code: financeTransaction.currency_code,
              notice: financeTransaction.notice,
            })
            .from(financeTransaction)
            .innerJoin(financeAccount, eq(financeAccount.id, financeTransaction.account_id))
            .where(inArray(financeTransaction.id, ctx.ids))
            .orderBy(asc(financeTransaction.booking_date), asc(financeTransaction.id)),
        );
  if (rows.length === 0) return out;

  const tags = new Map<number, string[]>();
  if (opts.columns.includes("tags")) {
    const tagRows = await dbAll<{ transaction_id: number; name: string }>(
      db
        .select({ transaction_id: financeTagTransaction.transaction_id, name: financeTag.name })
        .from(financeTagTransaction)
        .innerJoin(financeTag, eq(financeTag.id, financeTagTransaction.tag_id))
        .where(and(inArray(financeTagTransaction.transaction_id, rows.map((r) => r.id)), eq(financeTag.source, "user"))),
    );
    for (const t of tagRows) tags.set(Number(t.transaction_id), [...(tags.get(Number(t.transaction_id)) ?? []), t.name]);
  }

  const cell = (r: TxRow, c: TransactionColumn): Cell => {
    switch (c) {
      case "booking_date":
        return dayOf(r.booking_date);
      case "value_date":
        return dayOf(r.value_date);
      case "account":
        return r.account_label;
      case "amount":
        return Number(r.amount);
      case "currency":
        return r.currency_code ?? "EUR";
      case "tags":
        return (tags.get(Number(r.id)) ?? []).join("; ") || null;
      default:
        return r[c];
    }
  };

  // Sections per account, in the order the user set, the rest by name.
  const sections: TableSection[] = [];
  const groups = new Map<number, TxRow[]>();
  for (const r of rows) groups.set(r.account_id, [...(groups.get(r.account_id) ?? []), r]);
  const rank = new Map(opts.account_order.map((id, i) => [id, i]));
  const accountIds = [...groups.keys()].sort((a, b) => {
    const ra = rank.get(a) ?? Infinity;
    const rb = rank.get(b) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return groups.get(a)![0]!.account_label.localeCompare(groups.get(b)![0]!.account_label, "de");
  });
  if (opts.group_by_account) {
    for (const id of accountIds) {
      const list = groups.get(id)!;
      sections.push({
        title: list[0]!.account_label,
        rows: list.map((r) => opts.columns.map((c) => cell(r, c))),
        footer: sumCells(list, opts.columns, "Summe"),
      });
    }
  } else {
    sections.push({ title: "Buchungen", rows: rows.map((r) => opts.columns.map((c) => cell(r, c))) });
  }

  const doc: TableDocument = {
    title: `${ctx.collectionName}: Buchungen`,
    note:
      `${rows.length} ausgewählte Buchung${rows.length === 1 ? "" : "en"}. Eine Auswahl, kein Kontoauszug: ` +
      "Anfangs- und Endsaldo fehlen, die Summen gelten nur für die ausgewählten Buchungen.",
    columns: opts.columns.map((c) => TX_COLUMN_DEFS[c]),
    sections,
    total: opts.group_by_account && accountIds.length > 1 ? sumCells(rows, opts.columns, "Gesamt") : sumCells(rows, opts.columns, "Summe"),
  };
  const file = await tableFile(ctx, "Buchungen", doc, opts.format);
  out.files.push(file);
  for (const r of rows) out.index.push(indexFor(ctx, "transaction", Number(r.id), file.name));
  return out;
};

// ─── Securities ─────────────────────────────────────────────────────────────

const exportSecurities: Exporter = async (ctx) => {
  const out: TypeExport = { files: [], skipped: [], index: [] };
  if (ctx.ids.length === 0) return out;
  const rows = await dbAll<{
    id: number;
    account_id: number;
    account_label: string | null;
    name: string | null;
    isin: string | null;
    wkn: string | null;
    status: string;
  }>(
    db
      .select({
        id: financeDepotSecurity.id,
        account_id: financeDepotSecurity.account_id,
        account_label: financeAccount.label,
        name: financeDepotSecurity.name,
        isin: financeDepotSecurity.isin,
        wkn: financeDepotSecurity.wkn,
        status: financeDepotSecurity.status,
      })
      .from(financeDepotSecurity)
      .leftJoin(financeAccount, eq(financeAccount.id, financeDepotSecurity.account_id))
      .where(inArray(financeDepotSecurity.id, ctx.ids)),
  );

  // The bank's latest snapshot per depot says how many are held.
  const holdings = new Map<string, { amount: number | null; as_of: string; currency: string | null }>();
  for (const accountId of [...new Set(rows.map((r) => r.account_id))]) {
    const [latest] = await dbAll<{ as_of: string }>(
      db
        .select({ as_of: financeAccountHolding.as_of })
        .from(financeAccountHolding)
        .where(eq(financeAccountHolding.account_id, accountId))
        .orderBy(desc(financeAccountHolding.as_of))
        .limit(1),
    );
    if (!latest) continue;
    const held = await dbAll<{ isin: string | null; wkn: string | null; amount: string | null; currency: string | null }>(
      db
        .select({
          isin: financeAccountHolding.isin,
          wkn: financeAccountHolding.wkn,
          amount: financeAccountHolding.amount,
          currency: financeAccountHolding.currency,
        })
        .from(financeAccountHolding)
        .where(and(eq(financeAccountHolding.account_id, accountId), eq(financeAccountHolding.as_of, latest.as_of))),
    );
    for (const h of held) {
      const value = { amount: h.amount === null ? null : Number(h.amount), as_of: dayOf(latest.as_of) ?? latest.as_of, currency: h.currency };
      if (h.isin) holdings.set(`${accountId}:${h.isin}`, value);
      if (h.wkn) holdings.set(`${accountId}:${h.wkn}`, value);
    }
  }
  const keyOf = (r: { isin: string | null; wkn: string | null; name: string | null }) => r.isin || r.wkn || r.name || "";
  const quotes = await latestQuotes([...new Set(rows.map(keyOf).filter(Boolean))]);

  const STATUS: Record<string, string> = { confirmed: "bestätigt", proposed: "zu prüfen", ignored: "ausgeblendet" };
  const table: Cell[][] = rows.map((r) => {
    const held = holdings.get(`${r.account_id}:${r.isin}`) ?? holdings.get(`${r.account_id}:${r.wkn}`) ?? null;
    const quote = quotes.get(keyOf(r));
    const value = held?.amount != null && quote ? Math.round(held.amount * quote.price * 100) / 100 : null;
    return [
      r.name ?? r.isin ?? r.wkn ?? `#${r.id}`,
      r.isin,
      r.wkn,
      r.account_label,
      STATUS[r.status] ?? r.status,
      held?.amount ?? null,
      held?.as_of ?? null,
      quote ? quote.price : null,
      quote ? dayOf(quote.at) : null,
      value,
      quote?.currency ?? held?.currency ?? null,
    ];
  });
  const doc: TableDocument = {
    title: `${ctx.collectionName}: Wertpapiere`,
    note: "Bestand laut letztem Depotauszug der Bank, Kurs aus dem Kurs-Cache; der Wert ist Bestand mal Kurs.",
    columns: [
      { label: "Wertpapier", kind: "text", weight: 2.5 },
      { label: "ISIN", kind: "text", weight: 1.3 },
      { label: "WKN", kind: "text", weight: 0.9 },
      { label: "Depot", kind: "text", weight: 1.5 },
      { label: "Status", kind: "text", weight: 0.9 },
      { label: "Bestand", kind: "number" },
      { label: "Stand", kind: "date" },
      { label: "Kurs", kind: "money" },
      { label: "Kurs vom", kind: "date" },
      { label: "Wert", kind: "money" },
      { label: "Währung", kind: "text", weight: 0.6 },
    ],
    sections: [{ title: "Wertpapiere", rows: table }],
  };
  const file = await tableFile(ctx, "Wertpapiere", doc, ctx.options.security.format);
  out.files.push(file);
  for (const r of rows) out.index.push(indexFor(ctx, "security", Number(r.id), file.name));
  return out;
};

// ─── Meters and readings ────────────────────────────────────────────────────

interface ReadingRow {
  id: number;
  meter_id: number;
  device_id: number;
  serial_number: string | null;
  value: string;
  taken_at: string;
  source: string;
}

const READING_COLUMNS: TableColumn[] = [
  { label: "Abgelesen", kind: "date" },
  { label: "Zählerstand", kind: "number" },
  { label: "Verbrauch seit letzter Ablesung", kind: "number" },
  { label: "Einheit", kind: "text", weight: 0.6 },
  { label: "Gerät", kind: "text" },
  { label: "Quelle", kind: "text", weight: 0.8 },
];

function readingCells(rows: ReadingRow[], unit: string): Cell[][] {
  const lastByDevice = new Map<number, number>();
  return rows.map((r) => {
    const value = Number(r.value);
    const previous = lastByDevice.get(r.device_id);
    lastByDevice.set(r.device_id, value);
    const consumption = previous === undefined ? null : Math.round((value - previous) * 1000) / 1000;
    return [dayOf(r.taken_at), value, consumption, unit, r.serial_number, r.source];
  });
}

/**
 * Meters with their readings in the chosen period, consumption between two
 * readings of the same device; single readings that are members on their own
 * (as evidence) follow in a section of their own.
 */
async function exportMeters(ctx: ExportContext, meterIds: number[], readingIds: number[]): Promise<TypeExport> {
  const out: TypeExport = { files: [], skipped: [], index: [] };
  const { from, to } = ctx.options.meter;
  const readingSelect = {
    id: meterReadings.id,
    meter_id: meterDevices.meter_id,
    device_id: meterReadings.device_id,
    serial_number: meterDevices.serial_number,
    value: meterReadings.value,
    taken_at: meterReadings.taken_at,
    source: meterReadings.source,
  };
  const singles =
    readingIds.length === 0
      ? []
      : await dbAll<ReadingRow>(
          db
            .select(readingSelect)
            .from(meterReadings)
            .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
            .where(inArray(meterReadings.id, readingIds))
            .orderBy(asc(meterReadings.taken_at)),
        );
  const allMeterIds = [...new Set([...meterIds, ...singles.map((r) => Number(r.meter_id))])];
  const meterRows =
    allMeterIds.length === 0
      ? []
      : await dbAll<{ id: number; name: string; unit: string; location: string | null }>(
          db
            .select({ id: meters.id, name: meters.name, unit: meters.unit, location: meters.location })
            .from(meters)
            .where(inArray(meters.id, allMeterIds)),
        );
  const meterById = new Map(meterRows.map((m) => [Number(m.id), m]));

  const sections: TableSection[] = [];
  for (const meterId of meterIds) {
    const meter = meterById.get(meterId);
    if (!meter) continue;
    const conditions: SQL[] = [eq(meterDevices.meter_id, meterId)];
    if (from) conditions.push(gte(meterReadings.taken_at, `${from}T00:00:00`));
    if (to) conditions.push(sql`${meterReadings.taken_at} < (${to}::date + interval '1 day')`);
    const readings = await dbAll<ReadingRow>(
      db
        .select(readingSelect)
        .from(meterReadings)
        .innerJoin(meterDevices, eq(meterDevices.id, meterReadings.device_id))
        .where(and(...conditions))
        .orderBy(asc(meterReadings.taken_at), asc(meterReadings.id)),
    );
    const cells = readingCells(readings, meter.unit);
    const total = cells.reduce((sum, row) => sum + (typeof row[2] === "number" ? row[2] : 0), 0);
    sections.push({
      title: meter.location ? `${meter.name} (${meter.location})` : meter.name,
      rows: cells,
      footer: readings.length > 1 ? ["Verbrauch", null, Math.round(total * 1000) / 1000, meter.unit, null, null] : undefined,
    });
  }
  if (singles.length > 0) {
    sections.push({
      title: "Einzelne Ablesungen",
      rows: singles.map((r) => {
        const meter = meterById.get(Number(r.meter_id));
        return [dayOf(r.taken_at), Number(r.value), null, meter?.unit ?? "", meter ? `${meter.name}${r.serial_number ? ` · ${r.serial_number}` : ""}` : r.serial_number, r.source];
      }),
    });
  }
  if (sections.length === 0) return out;

  const period = from || to ? `Zeitraum ${from ?? "Anfang"} bis ${to ?? "heute"}.` : "Alle Ablesungen.";
  const file = await tableFile(
    ctx,
    "Zaehler",
    {
      title: `${ctx.collectionName}: Zählerstände`,
      note: `${period} Der Verbrauch ist die Differenz zur vorigen Ablesung desselben Geräts; nach einem Gerätewechsel beginnt er neu.`,
      columns: READING_COLUMNS,
      sections,
    },
    ctx.options.meter.format,
  );
  out.files.push(file);
  for (const id of meterIds) out.index.push(indexFor(ctx, "meter", id, meterById.has(id) ? file.name : null));
  return out;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export const EXPORTERS: Record<Exclude<CollectionEntityType, "meter" | "meter_reading">, Exporter> = {
  document: exportDocuments,
  photo: exportPhotos,
  album: exportAlbums,
  transaction: exportTransactions,
  security: exportSecurities,
};

/** Meters and single readings go into one table. */
export async function exportMeterMembers(ctx: ExportContext, readingIds: number[], readingDisplay: Map<number, { title: string; date: string | null }>): Promise<TypeExport> {
  const result = await exportMeters(ctx, ctx.ids, readingIds);
  const name = result.files[0]?.name ?? null;
  for (const id of readingIds) {
    const shown = readingDisplay.get(id);
    result.index.push({ type: "meter_reading", id, title: shown?.title ?? `#${id}`, date: shown?.date ?? null, file: name });
  }
  return result;
}

