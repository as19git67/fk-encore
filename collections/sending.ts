/**
 * Sending a collection's export (#1548, stage 7).
 *
 * Interactive sending happens on the device: the web app hands the finished
 * file — or, for up to ten items, the single files inside the ZIP — to the
 * system's share sheet, which reaches every messenger and mail app installed.
 * This file serves those single files, and does what needs the server: mail
 * through the app's SMTP account (with `Reply-To` set to the sender), and a
 * download link for people without an account when a file is too large to
 * attach. Every mail is logged with the collection.
 */

import crypto from "crypto";
import fs from "fs";
import JSZip from "jszip";
import type { ServerResponse } from "http";
import { and, desc, eq } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import { collectionExports, collectionSends, users } from "../db/schema";
import { loadReadableCollection } from "../documents/collection-access";
import { appUrl, mailConfigured, sendCollectionExportEmail } from "../user/mail";
import { assertMayUseCollections, caller, isAdmin } from "./collections";
import { contentDisposition, exportPath, loadOwnRun, type ExportRow } from "./exports";

/** Above this, a mail carries a link instead of attachments. */
export const MAIL_ATTACHMENT_LIMIT = Number(process.env.COLLECTION_MAIL_MAX_BYTES || 15 * 1024 * 1024);

/** At most this many single files, as attachments or in the share sheet. */
export const MAX_SINGLE_FILES = 10;

const MAX_RECIPIENTS = 10;

/** The table of contents is for the ZIP; as single files it would be noise. */
const INDEX_FILES = new Set(["Inhalt.csv", "Inhalt.pdf"]);

// ─── Single files ───────────────────────────────────────────────────────────

export interface ExportEntry {
  name: string;
  size: number;
}

function isZip(row: ExportRow): boolean {
  return row.mime_type === "application/zip";
}

function assertReady(row: ExportRow): void {
  if (row.status !== "done" || !row.filename) throw APIError.failedPrecondition("the export is not ready");
  if (!fs.existsSync(exportPath(row.id))) throw APIError.notFound("the export file has expired");
}

async function openZip(row: ExportRow): Promise<JSZip> {
  return await JSZip.loadAsync(await fs.promises.readFile(exportPath(row.id)));
}

/** The files of an export one by one: the ZIP's content, or the file itself. */
export async function exportEntries(row: ExportRow): Promise<ExportEntry[]> {
  assertReady(row);
  if (!isZip(row)) return [{ name: row.filename!, size: Number(row.size_bytes ?? 0) }];
  const zip = await openZip(row);
  const out: ExportEntry[] = [];
  for (const file of Object.values(zip.files)) {
    if (file.dir || INDEX_FILES.has(file.name)) continue;
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    out.push({ name: file.name, size });
  }
  return out;
}

/** The last path segment: what a single file is called on its own. */
function baseName(name: string): string {
  return name.split("/").pop() || name;
}

export const listExportEntries = api(
  { expose: true, method: "GET", path: "/collections/exports/:exportId/entries", auth: true },
  async ({ exportId }: { exportId: number }): Promise<{ items: ExportEntry[]; single_files_allowed: boolean }> => {
    const { row } = await loadOwnRun(exportId);
    const items = await exportEntries(row);
    return { items, single_files_allowed: items.length <= MAX_SINGLE_FILES };
  },
);

/** One file out of the ZIP, for the share sheet. */
export const downloadExportEntry = api.raw(
  { expose: true, method: "GET", path: "/collections/exports/:exportId/entry", auth: true },
  async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://local");
      const id = Number(url.pathname.split("/").slice(-2, -1)[0]);
      const name = url.searchParams.get("name") ?? "";
      const { row } = await loadOwnRun(id);
      assertReady(row);
      if (!isZip(row)) throw APIError.invalidArgument("the export is a single file");
      const file = (await openZip(row)).file(name);
      if (!file || INDEX_FILES.has(name)) throw APIError.notFound("no such file in the export");
      const bytes = await file.async("nodebuffer");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", contentDisposition(baseName(name)));
      res.end(bytes);
    } catch (err) {
      sendError(res, err);
    }
  },
);

function sendError(res: ServerResponse, err: unknown): void {
  const codes: Record<string, number> = { not_found: 404, failed_precondition: 409, invalid_argument: 400, unauthenticated: 401 };
  res.statusCode = err instanceof APIError ? codes[err.code] ?? 400 : 500;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(err instanceof Error ? err.message : "failed");
}

// ─── Download link ──────────────────────────────────────────────────────────

export interface DownloadLink {
  url: string;
  expires_at: string;
}

function linkFor(token: string): string {
  return `${appUrl().replace(/\/+$/, "")}/collections/download/${token}`;
}

/** The run's link for people without an account; made once, valid as long as the file. */
async function ensureDownloadLink(row: ExportRow): Promise<DownloadLink> {
  assertReady(row);
  let token = row.download_token;
  if (!token) {
    token = crypto.randomBytes(24).toString("base64url");
    await dbExec(db.update(collectionExports).set({ download_token: token }).where(eq(collectionExports.id, row.id)));
  }
  return { url: linkFor(token), expires_at: row.expires_at };
}

export const createExportLink = api(
  { expose: true, method: "POST", path: "/collections/exports/:exportId/link", auth: true },
  async ({ exportId }: { exportId: number }): Promise<DownloadLink> => {
    const { row } = await loadOwnRun(exportId);
    return await ensureDownloadLink(row);
  },
);

/** The file behind a link, for anyone holding it, until the file expires. */
export const downloadByLink = api.raw(
  { expose: true, method: "GET", path: "/collections/download/:token", auth: false },
  async (req, res) => {
    try {
      const token = decodeURIComponent((req.url ?? "").split("?")[0]!.split("/").pop() ?? "");
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw APIError.notFound("link not found");
      const row = await dbFirst<ExportRow>(
        db.select().from(collectionExports).where(eq(collectionExports.download_token, token)),
      );
      // An expired link reads like a missing one: nothing to learn from the difference.
      if (!row || row.status !== "done" || !row.filename || new Date(row.expires_at).getTime() < Date.now()) {
        throw APIError.notFound("link not found");
      }
      const file = exportPath(row.id);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat) throw APIError.notFound("link not found");
      res.statusCode = 200;
      res.setHeader("Content-Type", row.mime_type ?? "application/octet-stream");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      res.setHeader("Content-Disposition", contentDisposition(row.filename));
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      sendError(res, err);
    }
  },
);

// ─── Mail ───────────────────────────────────────────────────────────────────

export interface SendExportRequest {
  exportId: number;
  to: string[];
  message?: string | null;
  /** The single files instead of the ZIP (up to ten). */
  single_files?: boolean;
}

export interface CollectionSend {
  id: number;
  export_id: number | null;
  recipients: string[];
  mode: "attachment" | "items" | "link";
  filename: string | null;
  status: "sent" | "failed";
  error: string | null;
  sent_at: string;
  sent_by: string | null;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export function normalizeRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw APIError.invalidArgument("to must be a list of addresses");
  const out = [...new Set(raw.map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
  if (out.length === 0) throw APIError.invalidArgument("at least one recipient is needed");
  if (out.length > MAX_RECIPIENTS) throw APIError.invalidArgument(`at most ${MAX_RECIPIENTS} recipients`);
  const bad = out.filter((r) => !EMAIL.test(r));
  if (bad.length > 0) throw APIError.invalidArgument(`not an e-mail address: ${bad.join(", ")}`);
  return out;
}

async function logSend(
  row: ExportRow,
  userId: number,
  recipients: string[],
  mode: CollectionSend["mode"],
  status: CollectionSend["status"],
  error: string | null,
): Promise<number> {
  const inserted = await dbInsertReturning<{ id: number }>(
    db
      .insert(collectionSends)
      .values({
        collection_id: row.collection_id,
        export_id: row.id,
        user_id: userId,
        recipients,
        mode,
        filename: row.filename,
        status,
        error,
      })
      .returning({ id: collectionSends.id }),
  );
  return inserted?.id ?? 0;
}

/**
 * Mail the export. Attached when it fits, as a link when it does not; with
 * `single_files`, the files inside the ZIP go one by one (at most ten).
 */
export const sendExport = api(
  { expose: true, method: "POST", path: "/collections/exports/:exportId/send", auth: true },
  async (req: SendExportRequest): Promise<{ mode: CollectionSend["mode"]; send_id: number }> => {
    const { c, row } = await loadOwnRun(req.exportId);
    assertReady(row);
    const recipients = normalizeRecipients(req.to);
    if (!mailConfigured()) throw APIError.failedPrecondition("sending mail is not set up on this server");
    const message = (req.message ?? "").trim().slice(0, 4000) || null;

    const sender = await dbFirst<{ name: string; email: string }>(
      db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, c.userId)),
    );
    const collection = await loadReadableCollection(c.userId, row.collection_id, isAdmin(c));
    const collectionName = collection.kind === "basket" ? "Basket" : collection.title;

    let mode: CollectionSend["mode"] = "attachment";
    let attachments: Array<{ filename: string; path?: string; content?: Buffer }> = [];
    if (req.single_files && isZip(row)) {
      const entries = await exportEntries(row);
      if (entries.length > MAX_SINGLE_FILES) {
        throw APIError.invalidArgument(`single files only for up to ${MAX_SINGLE_FILES} items`);
      }
      const zip = await openZip(row);
      const taken = new Set<string>();
      for (const e of entries) {
        let name = baseName(e.name);
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
        taken.add(name.toLowerCase());
        attachments.push({ filename: name, content: await zip.file(e.name)!.async("nodebuffer") });
      }
      mode = "items";
    } else {
      attachments = [{ filename: row.filename!, path: exportPath(row.id) }];
    }
    const size = attachments.reduce(
      (sum, a) => sum + (a.content ? a.content.length : Number(row.size_bytes ?? 0)),
      0,
    );
    let link: { url: string; filename: string; expiresAt: string } | null = null;
    if (size > MAIL_ATTACHMENT_LIMIT) {
      const l = await ensureDownloadLink(row);
      link = { url: l.url, filename: row.filename!, expiresAt: l.expires_at };
      attachments = [];
      mode = "link";
    }

    try {
      await sendCollectionExportEmail({
        to: recipients,
        replyTo: sender?.email ?? null,
        senderName: sender?.name ?? "Jemand",
        collectionName,
        message,
        attachments,
        link,
      });
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      await logSend(row, c.userId, recipients, mode, "failed", reason.slice(0, 500));
      throw APIError.unavailable(`the mail could not be sent: ${reason}`);
    }
    return { mode, send_id: await logSend(row, c.userId, recipients, mode, "sent", null) };
  },
);

/** Every mail sent with this collection's exports, newest first. */
export const listCollectionSends = api(
  { expose: true, method: "GET", path: "/collections/:id/sends", auth: true },
  async ({ id }: { id: number }): Promise<{ items: CollectionSend[]; mail_configured: boolean }> => {
    const c = caller();
    assertMayUseCollections(c);
    const row = await loadReadableCollection(c.userId, id, isAdmin(c));
    const rows = await dbAll<Omit<CollectionSend, "sent_by">>(
      db
        .select({
          id: collectionSends.id,
          export_id: collectionSends.export_id,
          recipients: collectionSends.recipients,
          mode: collectionSends.mode,
          filename: collectionSends.filename,
          status: collectionSends.status,
          error: collectionSends.error,
          sent_at: collectionSends.sent_at,
          sent_by: users.name,
        })
        .from(collectionSends)
        .leftJoin(users, eq(users.id, collectionSends.user_id))
        .where(and(eq(collectionSends.collection_id, row.id)))
        .orderBy(desc(collectionSends.sent_at), desc(collectionSends.id))
        .limit(50),
    );
    return { items: rows as CollectionSend[], mail_configured: mailConfigured() };
  },
);
