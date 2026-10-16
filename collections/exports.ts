/**
 * Exports of a collection (#1548, stage 6).
 *
 * A reader starts an export with options — or a profile saved with the
 * collection — and gets a file: a PDF, CSV or workbook when the collection
 * holds one kind that fits in one file, a ZIP with a folder per type and an
 * index of every item otherwise. The run happens in the background, like the
 * document folder's PDF (documents/collection-export.ts); the file stays on
 * disk for a week and can be filed into the documents module as a document.
 *
 * Every export is per reader: a group collection leaves out what the reader
 * may not open, and an item that could not go in is named in the index with
 * the reason, never dropped silently.
 */

import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import log from "encore.dev/log";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  collectionExportProfiles,
  collectionExports,
  financeAccount,
  financeTransaction,
  type CollectionEntityType,
} from "../db/schema";
import { loadReadableCollection, type CollectionRow } from "../documents/collection-access";
import { DOCUMENTS_DIR } from "../documents/documents.service";
import { DuplicateDocumentError, importDocumentFromPath } from "../documents/import";
import {
  assertMayUseCollections,
  caller,
  isAdmin,
  loadStoredMembers,
  resolveVisible,
  type CollectionMember,
} from "./collections";
import type { Caller } from "./members";
import {
  DEFAULT_EXPORT_OPTIONS,
  ExportOptionsError,
  TYPE_FOLDERS,
  isSingleFile,
  normalizeExportOptions,
  safeFileName,
  type ExportOptions,
} from "./export-options";
import {
  EXPORTERS,
  exportMeterMembers,
  type ExportContext,
  type ExportFile,
  type ExportSkip,
  type IndexLine,
  type TypeExport,
} from "./exporters";
import { renderTable, type TableDocument } from "./export-tables";

/** Files live here, named by the export's id. */
export const COLLECTION_EXPORTS_DIR = path.resolve(
  process.env.COLLECTION_EXPORTS_DIR || path.join(DOCUMENTS_DIR, "_collection_exports"),
);

/** How long a finished file is kept. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Readers keep their last few runs per collection; older ones go. */
const KEEP_PER_READER = 5;

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface ExportProfile {
  id: number;
  name: string;
  options: ExportOptions;
  updated_at: string;
}

export interface ExportRun {
  id: number;
  collection_id: number;
  status: "running" | "done" | "failed";
  profile_id: number | null;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  item_count: number;
  skipped: ExportSkip[];
  error: string | null;
  document_id: number | null;
  started_at: string;
  finished_at: string | null;
  expires_at: string;
}

/**
 * The groups an export is made of: meters and single readings are one.
 * Spelled out, because Encore's parser reads it as part of an API type.
 */
export type ExportGroup = "document" | "photo" | "album" | "transaction" | "security" | "meter";

export interface ExportSetup {
  /** Visible members per export group. */
  groups: Partial<Record<ExportGroup, number>>;
  defaults: ExportOptions;
  profiles: ExportProfile[];
  /** Accounts of the transactions in it, for the account order. */
  accounts: Array<{ id: number; label: string }>;
}

export type ExportRow = typeof collectionExports.$inferSelect;

export function toRun(row: ExportRow): ExportRun {
  return {
    id: row.id,
    collection_id: row.collection_id,
    status: row.status,
    profile_id: row.profile_id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    item_count: row.item_count,
    skipped: row.skipped as ExportSkip[],
    error: row.error,
    document_id: row.document_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    expires_at: row.expires_at,
  };
}

function toProfile(row: typeof collectionExportProfiles.$inferSelect): ExportProfile {
  return { id: row.id, name: row.name, options: normalizeExportOptions(row.options), updated_at: row.updated_at };
}

function groupOf(type: CollectionEntityType): ExportGroup {
  return type === "meter_reading" ? "meter" : type;
}

function parseOptions(raw: unknown): ExportOptions {
  try {
    return normalizeExportOptions(raw);
  } catch (err) {
    if (err instanceof ExportOptionsError) throw APIError.invalidArgument(err.message);
    throw err;
  }
}

async function readable(id: number): Promise<{ c: Caller; row: CollectionRow }> {
  const c = caller();
  assertMayUseCollections(c);
  const row = await loadReadableCollection(c.userId, id, isAdmin(c));
  return { c, row };
}

function collectionName(row: CollectionRow): string {
  return row.kind === "basket" ? "Basket" : row.title;
}

// ─── Setup and profiles ─────────────────────────────────────────────────────

export async function loadProfiles(collectionId: number): Promise<ExportProfile[]> {
  const rows = await dbAll<typeof collectionExportProfiles.$inferSelect>(
    db
      .select()
      .from(collectionExportProfiles)
      .where(eq(collectionExportProfiles.collection_id, collectionId))
      .orderBy(collectionExportProfiles.name),
  );
  return rows.map(toProfile);
}

/** What the export dialog needs: the types present, the profiles, the defaults. */
export const getExportSetup = api(
  { expose: true, method: "GET", path: "/collections/:id/export-setup", auth: true },
  async ({ id }: { id: number }): Promise<ExportSetup> => {
    const { c, row } = await readable(id);
    const members = await resolveVisible(await loadStoredMembers(row.id), c);
    const groups: Partial<Record<ExportGroup, number>> = {};
    for (const m of members) groups[groupOf(m.entity_type)] = (groups[groupOf(m.entity_type)] ?? 0) + 1;
    const txIds = members.filter((m) => m.entity_type === "transaction").map((m) => m.entity_id);
    const accounts =
      txIds.length === 0
        ? []
        : await dbAll<{ id: number; label: string }>(
            db
              .selectDistinct({ id: financeAccount.id, label: financeAccount.label })
              .from(financeTransaction)
              .innerJoin(financeAccount, eq(financeAccount.id, financeTransaction.account_id))
              .where(inArray(financeTransaction.id, txIds))
              .orderBy(financeAccount.label),
          );
    return { groups, defaults: DEFAULT_EXPORT_OPTIONS, profiles: await loadProfiles(row.id), accounts };
  },
);

export interface SaveProfileRequest {
  id: number;
  name: string;
  options: Record<string, unknown>;
}

/**
 * Save the options under a name. A name already used in this collection is
 * overwritten, so "save" after changing a profile's options does what it says.
 */
export const saveExportProfile = api(
  { expose: true, method: "POST", path: "/collections/:id/export-profiles", auth: true },
  async (req: SaveProfileRequest): Promise<ExportProfile> => {
    const { c, row } = await readable(req.id);
    const name = (req.name ?? "").trim().slice(0, 80);
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const options = parseOptions(req.options);
    const existing = await dbFirst<{ id: number }>(
      db
        .select({ id: collectionExportProfiles.id })
        .from(collectionExportProfiles)
        .where(and(eq(collectionExportProfiles.collection_id, row.id), sql`lower(${collectionExportProfiles.name}) = lower(${name})`)),
    );
    if (existing) {
      await dbExec(
        db
          .update(collectionExportProfiles)
          .set({ name, options: options as unknown as Record<string, unknown>, updated_at: sql`now()` })
          .where(eq(collectionExportProfiles.id, existing.id)),
      );
    } else {
      await dbInsertReturning(
        db
          .insert(collectionExportProfiles)
          .values({ collection_id: row.id, name, options: options as unknown as Record<string, unknown>, created_by: c.userId })
          .returning({ id: collectionExportProfiles.id }),
      );
    }
    const saved = (await loadProfiles(row.id)).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!saved) throw APIError.internal("profile not saved");
    return saved;
  },
);

export const deleteExportProfile = api(
  { expose: true, method: "DELETE", path: "/collections/:id/export-profiles/:profileId", auth: true },
  async ({ id, profileId }: { id: number; profileId: number }): Promise<{ ok: boolean }> => {
    const { row } = await readable(id);
    await dbExec(
      db
        .delete(collectionExportProfiles)
        .where(and(eq(collectionExportProfiles.id, profileId), eq(collectionExportProfiles.collection_id, row.id))),
    );
    return { ok: true };
  },
);

// ─── Building ───────────────────────────────────────────────────────────────

const REASONS: Record<string, string> = {
  switched_off: "in der Mappe ausgeschaltet",
  file_missing: "Datei fehlt",
  redacted: "hat Schwärzungen, nur im PDF enthalten",
  unreadable: "nicht lesbar",
  not_visible: "nicht sichtbar",
  no_pages_selected: "keine Seite ausgewählt",
  unsupported_type: "Dateityp nicht unterstützt",
};

const TYPE_LABELS: Record<CollectionEntityType, string> = {
  document: "Dokument",
  photo: "Foto",
  album: "Album",
  transaction: "Buchung",
  security: "Wertpapier",
  meter: "Zähler",
  meter_reading: "Zählerstand",
};

export function reasonLabel(reason: string): string {
  return REASONS[reason] ?? reason;
}

function indexTable(name: string, lines: IndexLine[], skipped: ExportSkip[]): TableDocument {
  const why = new Map(skipped.map((s) => [`${s.entity_type}:${s.entity_id}`, reasonLabel(s.reason)]));
  return {
    title: `${name}: Inhalt`,
    note: `${lines.length} Einträge. Was nicht in der Datei steht, nennt die letzte Spalte mit dem Grund.`,
    columns: [
      { label: "Art", kind: "text", weight: 0.8 },
      { label: "Titel", kind: "text", weight: 3 },
      { label: "Datum", kind: "date" },
      { label: "Datei", kind: "text", weight: 2.5 },
      { label: "Hinweis", kind: "text", weight: 1.6 },
    ],
    sections: [
      {
        title: "Inhalt",
        rows: lines.map((l) => [
          TYPE_LABELS[l.type],
          l.title,
          l.date ? l.date.slice(0, 10) : null,
          l.file,
          l.file ? null : (why.get(`${l.type}:${l.id}`) ?? "nicht enthalten"),
        ]),
      },
    ],
  };
}

export interface BuiltExport {
  filename: string;
  mime: string;
  /** Bytes of a single file, or the files of a ZIP. */
  single?: ExportFile;
  zip?: ExportFile[];
  skipped: ExportSkip[];
  item_count: number;
}

/** Turn visible members into the export, without touching disk or tables. */
export async function buildExport(
  userId: number,
  collection: { id: number; name: string },
  members: CollectionMember[],
  options: ExportOptions,
): Promise<BuiltExport> {
  const byGroup = new Map<ExportGroup, CollectionMember[]>();
  for (const m of members) byGroup.set(groupOf(m.entity_type), [...(byGroup.get(groupOf(m.entity_type)) ?? []), m]);
  if (byGroup.size === 0) throw APIError.failedPrecondition("the collection holds nothing you can export");

  const groups = [...byGroup.keys()];
  const only = groups.length === 1 ? groups[0]! : null;
  const asZip = options.always_zip || only === null || !isSingleFile(only, options);

  const results: TypeExport[] = [];
  for (const group of groups) {
    const list = byGroup.get(group)!;
    const display = new Map(list.map((m) => [m.entity_id, { title: m.title, date: m.date }]));
    const ctx: ExportContext = {
      userId,
      collectionId: collection.id,
      collectionName: collection.name,
      ids: list.filter((m) => m.entity_type === group).map((m) => m.entity_id),
      display,
      options,
      folder: asZip ? TYPE_FOLDERS[group] : "",
    };
    if (group === "meter") {
      const readings = list.filter((m) => m.entity_type === "meter_reading");
      results.push(
        await exportMeterMembers(
          ctx,
          readings.map((m) => m.entity_id),
          new Map(readings.map((m) => [m.entity_id, { title: m.title, date: m.date }])),
        ),
      );
    } else {
      results.push(await EXPORTERS[group](ctx));
    }
  }

  const files = results.flatMap((r) => r.files);
  const skipped = results.flatMap((r) => r.skipped);
  const index = results.flatMap((r) => r.index);
  const itemCount = index.filter((l) => l.file !== null).length;
  if (files.length === 0) throw APIError.failedPrecondition("nothing in the collection could be exported");

  const base = safeFileName(collection.name, "Sammelmappe");
  if (!asZip) {
    const single = files[0]!;
    return { filename: single.name, mime: single.mime, single, skipped, item_count: itemCount };
  }
  const listing = indexTable(collection.name, index, skipped);
  const [csv, pdf] = await Promise.all([renderTable(listing, "csv"), renderTable(listing, "pdf")]);
  files.push({ name: "Inhalt.csv", mime: csv.mime, bytes: csv.bytes });
  files.push({ name: "Inhalt.pdf", mime: pdf.mime, bytes: pdf.bytes });
  return { filename: `${base}.zip`, mime: "application/zip", zip: files, skipped, item_count: itemCount };
}

export function exportPath(id: number): string {
  return path.join(COLLECTION_EXPORTS_DIR, String(id));
}

/** Write the export to its slot, through a temp file so a reader never sees half. */
async function writeExport(id: number, built: BuiltExport): Promise<number> {
  await fs.promises.mkdir(COLLECTION_EXPORTS_DIR, { recursive: true });
  const target = exportPath(id);
  const tmp = `${target}.part`;
  if (built.single) {
    const file = built.single;
    if (file.bytes) await fs.promises.writeFile(tmp, file.bytes);
    else await fs.promises.copyFile(file.source!, tmp);
  } else {
    const zip = new JSZip();
    for (const file of built.zip ?? []) {
      zip.file(file.name, file.bytes ?? fs.createReadStream(file.source!), { binary: true });
    }
    await new Promise<void>((resolve, reject) => {
      zip
        .generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } })
        .pipe(fs.createWriteStream(tmp))
        .on("finish", () => resolve())
        .on("error", reject);
    });
  }
  await fs.promises.rename(tmp, target);
  return (await fs.promises.stat(target)).size;
}

const runs = new Map<number, Promise<void>>();

/** For tests: wait until the run in the background has finished. */
export async function awaitExportRun(id: number): Promise<void> {
  await runs.get(id);
}

async function runExport(
  exportId: number,
  c: Caller,
  row: CollectionRow,
  options: ExportOptions,
  keep?: (m: CollectionMember) => boolean,
): Promise<void> {
  try {
    const visible = await resolveVisible(await loadStoredMembers(row.id), c);
    const members = keep ? visible.filter(keep) : visible;
    const built = await buildExport(c.userId, { id: row.id, name: collectionName(row) }, members, options);
    const size = await writeExport(exportId, built);
    await dbExec(
      db
        .update(collectionExports)
        .set({
          status: "done",
          filename: built.filename,
          mime_type: built.mime,
          size_bytes: size,
          item_count: built.item_count,
          skipped: built.skipped,
          finished_at: sql`now()`,
        })
        .where(eq(collectionExports.id, exportId)),
    );
  } catch (err) {
    const message = err instanceof APIError ? err.message : (err as Error)?.message ?? String(err);
    log.warn("collection export failed", { export_id: exportId, collection_id: row.id, error: message });
    await dbExec(
      db
        .update(collectionExports)
        .set({ status: "failed", error: message.slice(0, 500), finished_at: sql`now()` })
        .where(eq(collectionExports.id, exportId)),
    );
    await fs.promises.rm(`${exportPath(exportId)}.part`, { force: true });
  }
}

async function insertRun(collectionId: number, userId: number, profileId: number | null, options: ExportOptions): Promise<ExportRow> {
  const created = await dbInsertReturning<ExportRow>(
    db
      .insert(collectionExports)
      .values({
        collection_id: collectionId,
        user_id: userId,
        profile_id: profileId,
        options: options as unknown as Record<string, unknown>,
        status: "running",
        expires_at: new Date(Date.now() + EXPORT_TTL_MS).toISOString(),
      })
      .returning(),
  );
  if (!created) throw APIError.internal("export not started");
  return created;
}

/**
 * Run an export to the end and return its row — for the scheduled exports,
 * which have no dialog to poll. `keep` narrows the members (e.g. to a period).
 */
export async function runExportNow(
  c: Caller,
  row: CollectionRow,
  options: ExportOptions,
  profileId: number | null,
  keep?: (m: CollectionMember) => boolean,
): Promise<ExportRow> {
  const created = await insertRun(row.id, c.userId, profileId, options);
  await runExport(created.id, c, row, options, keep);
  void pruneOldRuns(row.id, c.userId);
  const done = await dbFirst<ExportRow>(db.select().from(collectionExports).where(eq(collectionExports.id, created.id)));
  return done ?? created;
}

export interface StartExportRequest {
  id: number;
  /** Options to use; ignored when a profile is given. */
  options?: Record<string, unknown>;
  profile_id?: number | null;
}

/** Start an export in the background and return its row at once. */
export const startExport = api(
  { expose: true, method: "POST", path: "/collections/:id/exports", auth: true },
  async (req: StartExportRequest): Promise<ExportRun> => {
    const { c, row } = await readable(req.id);
    let options: ExportOptions;
    let profileId: number | null = null;
    if (req.profile_id) {
      const profile = (await loadProfiles(row.id)).find((p) => p.id === req.profile_id);
      if (!profile) throw APIError.notFound("profile not found");
      options = profile.options;
      profileId = profile.id;
    } else {
      options = parseOptions(req.options ?? {});
    }
    const created = await insertRun(row.id, c.userId, profileId, options);
    const run = runExport(created.id, c, row, options).finally(() => runs.delete(created.id));
    runs.set(created.id, run);
    void pruneOldRuns(row.id, c.userId);
    return toRun(created);
  },
);

/** The caller's recent runs of this collection, newest first. */
export const listExports = api(
  { expose: true, method: "GET", path: "/collections/:id/exports", auth: true },
  async ({ id }: { id: number }): Promise<{ items: ExportRun[] }> => {
    const { c, row } = await readable(id);
    const rows = await dbAll<ExportRow>(
      db
        .select()
        .from(collectionExports)
        .where(and(eq(collectionExports.collection_id, row.id), eq(collectionExports.user_id, c.userId)))
        .orderBy(desc(collectionExports.started_at), desc(collectionExports.id))
        .limit(KEEP_PER_READER),
    );
    return { items: rows.map(markInterrupted).map(toRun) };
  },
);

/** A run that says "running" with nothing behind it was cut off by a restart. */
function markInterrupted(row: ExportRow): ExportRow {
  if (row.status === "running" && !runs.has(row.id)) {
    return { ...row, status: "failed", error: "Der Export wurde unterbrochen. Bitte neu starten." };
  }
  return row;
}

export async function loadOwnRun(exportId: number): Promise<{ c: Caller; row: ExportRow }> {
  const c = caller();
  const row = await dbFirst<ExportRow>(db.select().from(collectionExports).where(eq(collectionExports.id, exportId)));
  // Someone else's run reads as missing, not as forbidden.
  if (!row || row.user_id !== c.userId) throw APIError.notFound("export not found");
  return { c, row: markInterrupted(row) };
}

export const getExport = api(
  { expose: true, method: "GET", path: "/collections/exports/:exportId", auth: true },
  async ({ exportId }: { exportId: number }): Promise<ExportRun> => {
    return toRun((await loadOwnRun(exportId)).row);
  },
);

export const deleteExport = api(
  { expose: true, method: "DELETE", path: "/collections/exports/:exportId", auth: true },
  async ({ exportId }: { exportId: number }): Promise<{ ok: boolean }> => {
    const { row } = await loadOwnRun(exportId);
    if (row.status === "running") throw APIError.failedPrecondition("the export is still running");
    await dbExec(db.delete(collectionExports).where(eq(collectionExports.id, row.id)));
    await fs.promises.rm(exportPath(row.id), { force: true });
    return { ok: true };
  },
);

/** RFC 5987 so umlauts survive in the download name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const downloadExport = api.raw(
  { expose: true, method: "GET", path: "/collections/exports/:exportId/file", auth: true },
  async (req, res) => {
    try {
      const id = Number((req.url ?? "").split("?")[0]!.split("/").slice(-2, -1)[0]);
      const { row } = await loadOwnRun(id);
      if (row.status !== "done" || !row.filename) throw APIError.failedPrecondition("the export is not ready");
      const file = exportPath(row.id);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) throw APIError.notFound("the export file has expired");
      res.statusCode = 200;
      res.setHeader("Content-Type", row.mime_type ?? "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", contentDisposition(row.filename));
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      const status = err instanceof APIError ? ({ not_found: 404, failed_precondition: 409, unauthenticated: 401 } as Record<string, number>)[err.code] ?? 400 : 500;
      res.statusCode = status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err instanceof Error ? err.message : "export download failed");
    }
  },
);

/**
 * File a finished PDF into the documents module, where it is classified and
 * found like any other document. Only PDFs: a ZIP or a table is not a document.
 */
export const saveExportAsDocument = api(
  { expose: true, method: "POST", path: "/collections/exports/:exportId/document", auth: true },
  async ({ exportId }: { exportId: number }): Promise<{ document_id: number; already_existed: boolean }> => {
    const { c, row } = await loadOwnRun(exportId);
    if (!c.permissions.includes("documents.upload") && !c.permissions.includes("documents.edit")) {
      throw APIError.permissionDenied("missing permission: documents.upload");
    }
    return await fileExportAsDocument(row, c.userId);
  },
);

/** File a finished PDF export into the documents module, once. */
export async function fileExportAsDocument(
  row: ExportRow,
  userId: number,
): Promise<{ document_id: number; already_existed: boolean }> {
  if (row.status !== "done" || !row.filename) throw APIError.failedPrecondition("the export is not ready");
  if (row.mime_type !== "application/pdf") throw APIError.failedPrecondition("only a PDF can be saved as a document");
  if (row.document_id) return { document_id: row.document_id, already_existed: true };
  // The import moves its source, so it gets a copy.
  const tmp = path.join(os.tmpdir(), `collection-export-${row.id}-${Date.now()}.pdf`);
  await fs.promises.copyFile(exportPath(row.id), tmp);
  let documentId: number;
  let existed = false;
  try {
    documentId = (await importDocumentFromPath({ userId, sourcePath: tmp, originalFilename: row.filename, mimeType: "application/pdf" })).id;
  } catch (err) {
    if (!(err instanceof DuplicateDocumentError)) throw err;
    documentId = err.existingId;
    existed = true;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
  await dbExec(db.update(collectionExports).set({ document_id: documentId }).where(eq(collectionExports.id, row.id)));
  return { document_id: documentId, already_existed: existed };
}

// ─── Housekeeping ───────────────────────────────────────────────────────────

/** Keep the newest few runs of a reader per collection. */
async function pruneOldRuns(collectionId: number, userId: number): Promise<void> {
  try {
    const old = await dbAll<{ id: number }>(
      db
        .select({ id: collectionExports.id })
        .from(collectionExports)
        .where(
          and(
            eq(collectionExports.collection_id, collectionId),
            eq(collectionExports.user_id, userId),
            ne(collectionExports.status, "running"),
          ),
        )
        .orderBy(desc(collectionExports.started_at), desc(collectionExports.id))
        .offset(KEEP_PER_READER),
    );
    if (old.length === 0) return;
    await dbExec(db.delete(collectionExports).where(inArray(collectionExports.id, old.map((r) => r.id))));
    await Promise.all(old.map((r) => fs.promises.rm(exportPath(r.id), { force: true })));
  } catch (err) {
    log.warn("pruning collection exports failed", { error: (err as Error)?.message });
  }
}

/**
 * Drop expired runs and their files, and files whose run is gone (the
 * collection was deleted). Runs from the hourly collections job.
 */
export async function purgeExpiredExports(): Promise<number> {
  const expired = await dbAll<{ id: number }>(
    db
      .select({ id: collectionExports.id })
      .from(collectionExports)
      .where(and(lt(collectionExports.expires_at, sql`now()`), ne(collectionExports.status, "running"))),
  );
  if (expired.length > 0) {
    await dbExec(db.delete(collectionExports).where(inArray(collectionExports.id, expired.map((r) => r.id))));
  }
  let removed = 0;
  const names = await fs.promises.readdir(COLLECTION_EXPORTS_DIR).catch(() => [] as string[]);
  const ids = names.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length > 0) {
    const live = new Set(
      (await dbAll<{ id: number }>(db.select({ id: collectionExports.id }).from(collectionExports).where(inArray(collectionExports.id, ids)))).map(
        (r) => r.id,
      ),
    );
    for (const id of ids) {
      if (live.has(id)) continue;
      await fs.promises.rm(exportPath(id), { force: true });
      removed++;
    }
  }
  return removed;
}
