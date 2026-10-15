/**
 * What an export of a collection looks like (#1548, stage 6).
 *
 * One options object for the whole collection, with a part per type: a mixed
 * collection is exported as one ZIP with a folder per type, each in its own
 * format, plus an index of every item. When only one type is present and its
 * format is a single file (a PDF, a CSV, an Excel workbook), that file is the
 * export itself.
 *
 * The same object is what an export profile stores, so this file is also the
 * one place that turns whatever a client sends — or an old profile holds —
 * into options the exporters can rely on.
 */

import type { CollectionEntityType } from "../db/schema";

export type TableFormat = "csv" | "xlsx" | "pdf";

/**
 * Columns a transaction export can carry. Spelled out as a union, not derived
 * from the array: Encore's parser reads the API types and does not resolve
 * `(typeof X)[number]`.
 */
export type TransactionColumn =
  | "booking_date"
  | "value_date"
  | "account"
  | "counterparty"
  | "counterparty_iban"
  | "purpose"
  | "amount"
  | "currency"
  | "tags"
  | "notice";

/** The same columns, in the order they appear. */
export const TRANSACTION_COLUMNS: readonly TransactionColumn[] = [
  "booking_date",
  "value_date",
  "account",
  "counterparty",
  "counterparty_iban",
  "purpose",
  "amount",
  "currency",
  "tags",
  "notice",
];

export const DEFAULT_TRANSACTION_COLUMNS: TransactionColumn[] = [
  "booking_date",
  "account",
  "counterparty",
  "purpose",
  "amount",
  "currency",
  "tags",
];

export interface DocumentExportOptions {
  /** One PDF of all documents in order, or a ZIP of the original files. */
  format: "pdf" | "zip";
}

export interface TransactionExportOptions {
  format: TableFormat;
  columns: TransactionColumn[];
  /** One section (sheet, PDF block) per account, with its sum. */
  group_by_account: boolean;
  /** Account ids in the order the user wants them; the rest follow by name. */
  account_order: number[];
}

export interface PhotoExportOptions {
  /** The file as stored, or a JPEG no longer than 2560 px on its long edge. */
  size: "original" | "large";
  /** Drop EXIF/XMP (GPS, camera) by re-encoding the image. */
  strip_metadata: boolean;
}

export interface SecurityExportOptions {
  format: TableFormat;
}

export interface MeterExportOptions {
  format: TableFormat;
  /** Readings from this day on (YYYY-MM-DD); absent: from the first. */
  from: string | null;
  /** Readings up to this day; absent: up to the last. */
  to: string | null;
}

export interface ExportOptions {
  document: DocumentExportOptions;
  transaction: TransactionExportOptions;
  photo: PhotoExportOptions;
  /** Albums are photos in a folder per album, with the photo options. */
  album: PhotoExportOptions;
  security: SecurityExportOptions;
  /** Meters and single readings. */
  meter: MeterExportOptions;
  /** Always a ZIP, even when one file would do. */
  always_zip: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  document: { format: "pdf" },
  transaction: { format: "pdf", columns: DEFAULT_TRANSACTION_COLUMNS, group_by_account: true, account_order: [] },
  photo: { size: "original", strip_metadata: false },
  album: { size: "original", strip_metadata: false },
  security: { format: "pdf" },
  meter: { format: "pdf", from: null, to: null },
  always_zip: false,
};

/** Which part of the options a member type is exported with. */
export function optionsKeyOf(type: CollectionEntityType): Exclude<keyof ExportOptions, "always_zip"> {
  return type === "meter_reading" ? "meter" : type;
}

export class ExportOptionsError extends Error {}

type Loose = Record<string, unknown>;

function obj(value: unknown): Loose {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : {};
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ExportOptionsError(`${field} must be one of ${allowed.join(", ")}`);
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function day(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new ExportOptionsError(`${field} must be YYYY-MM-DD`);
}

function photoOptions(raw: unknown, field: string): PhotoExportOptions {
  const o = obj(raw);
  return {
    size: pick(o.size, ["original", "large"] as const, "original", `${field}.size`),
    strip_metadata: flag(o.strip_metadata, false),
  };
}

const TABLE_FORMATS = ["csv", "xlsx", "pdf"] as const;

/**
 * Whatever came in, as complete options: missing parts take the defaults,
 * unknown columns are dropped, a value of the wrong kind is refused.
 */
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const o = obj(raw);
  const doc = obj(o.document);
  const tx = obj(o.transaction);
  const sec = obj(o.security);
  const meter = obj(o.meter);

  const columns = Array.isArray(tx.columns)
    ? TRANSACTION_COLUMNS.filter((c) => (tx.columns as unknown[]).includes(c))
    : DEFAULT_TRANSACTION_COLUMNS;
  if (columns.length === 0) throw new ExportOptionsError("transaction.columns must name at least one column");
  const order = Array.isArray(tx.account_order)
    ? [...new Set((tx.account_order as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];

  const from = day(meter.from, "meter.from");
  const to = day(meter.to, "meter.to");
  if (from && to && from > to) throw new ExportOptionsError("meter.from must not be after meter.to");

  return {
    document: { format: pick(doc.format, ["pdf", "zip"] as const, "pdf", "document.format") },
    transaction: {
      format: pick(tx.format, TABLE_FORMATS, "pdf", "transaction.format"),
      columns,
      group_by_account: flag(tx.group_by_account, true),
      account_order: order,
    },
    photo: photoOptions(o.photo, "photo"),
    album: photoOptions(o.album, "album"),
    security: { format: pick(sec.format, TABLE_FORMATS, "pdf", "security.format") },
    meter: { format: pick(meter.format, TABLE_FORMATS, "pdf", "meter.format"), from, to },
    always_zip: flag(o.always_zip, false),
  };
}

/** True when the type's export is one file rather than a folder of files. */
export function isSingleFile(type: CollectionEntityType, options: ExportOptions): boolean {
  switch (type) {
    case "document":
      return options.document.format === "pdf";
    case "photo":
    case "album":
      return false;
    default:
      return true;
  }
}

/** Folder names inside the ZIP, one per type. */
export const TYPE_FOLDERS: Record<Exclude<CollectionEntityType, "meter_reading">, string> = {
  document: "Dokumente",
  photo: "Fotos",
  album: "Alben",
  transaction: "Buchungen",
  security: "Wertpapiere",
  meter: "Zaehler",
};

/**
 * A name safe in a ZIP and on every file system: no path separators, no
 * control characters, at most 80 characters, never empty.
 */
export function safeFileName(raw: string, fallback = "datei"): string {
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const short = cleaned.slice(0, 80).trim();
  return short || fallback;
}

/** `name`, or `name (2)`, `name (3)` … when the folder already holds it. */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
