/**
 * Anonymous share links of a collection (#1548, stage 8).
 *
 * A link is live: whoever holds it sees the collection as it is now — its
 * photos, albums and documents — as far as the person who made the link may
 * see them at this moment. Everything else the collection holds (bookings,
 * securities, meters) never goes out; the page only says how many entries of
 * each kind are not shared.
 *
 * What a photo reveals is kept small, as on the album links: photos the
 * creator hid, photos opted out of links, and — unless opted in — photos
 * carrying a face the creator named stay out; the image itself is always
 * re-encoded, so no GPS, camera or capture data leaves with it. A document
 * goes out as its original file only when the collection shows it whole:
 * one with redactions or pages taken out exists only in the collection's
 * PDF, and stays out here.
 *
 * Only the collection's owner makes and ends links; the basket has none.
 */

import crypto from "crypto";
import fs from "fs";
import sharp from "sharp";
import type { ServerResponse } from "http";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  albumPhotos,
  albums,
  collectionPublicLinks,
  documentCollectionItems,
  documentCollections,
  documents,
  photoCuration,
  photos,
} from "../db/schema";
import { assertCollectionAdministrable, loadReadableCollection, type CollectionRow } from "../documents/collection-access";
import { exportSourcePath } from "../documents/collection-export";
import { accessiblePhotoCondition } from "../photo/photo-file-access";
import { linkVisiblePhotoSql } from "../photo/link-visibility.service";
import { getPhotoDiskPath } from "../photo/photo.service";
import { getPermissionsForUser } from "../user/user.service";
import { assertMayUseCollections, caller, isAdmin, loadStoredMembers, resolveVisible } from "./collections";
import { contentDisposition } from "./exports";

// ─── Managing links ─────────────────────────────────────────────────────────

export type LinkExpiry = "7d" | "30d" | "90d" | "never";

const EXPIRES_IN_MS: Record<Exclude<LinkExpiry, "never">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export interface CollectionPublicLink {
  id: number;
  collection_id: number;
  token: string;
  created_at: string;
  expires_at: string | null;
}

type LinkRow = typeof collectionPublicLinks.$inferSelect;

function toLink(row: LinkRow): CollectionPublicLink {
  return {
    id: row.id,
    collection_id: row.collection_id,
    token: row.token,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** The collection, when the caller may share it: its owner (or an admin), never the basket. */
async function ownedCollection(collectionId: number): Promise<{ userId: number; row: CollectionRow }> {
  const c = caller();
  assertMayUseCollections(c);
  const row = await loadReadableCollection(c.userId, collectionId, isAdmin(c));
  if (row.kind === "basket") throw APIError.failedPrecondition("the basket cannot be shared; save it as a collection first");
  // Who may change the collection may share it: its owner, an owner of its group, an admin.
  await assertCollectionAdministrable(row, c.userId, isAdmin(c));
  return { userId: c.userId, row };
}

export const listCollectionPublicLinks = api(
  { expose: true, method: "GET", path: "/collections/:id/public-links", auth: true },
  async ({ id }: { id: number }): Promise<{ items: CollectionPublicLink[] }> => {
    const { row } = await ownedCollection(id);
    const rows = await dbAll<LinkRow>(
      db
        .select()
        .from(collectionPublicLinks)
        .where(and(eq(collectionPublicLinks.collection_id, row.id), isNull(collectionPublicLinks.disabled_at)))
        .orderBy(desc(collectionPublicLinks.created_at)),
    );
    const now = Date.now();
    return { items: rows.filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now).map(toLink) };
  },
);

export const createCollectionPublicLink = api(
  { expose: true, method: "POST", path: "/collections/:id/public-links", auth: true },
  async ({ id, expires_in }: { id: number; expires_in?: LinkExpiry }): Promise<CollectionPublicLink> => {
    const { userId, row } = await ownedCollection(id);
    const expiry = expires_in ?? "30d";
    if (expiry !== "never" && !(expiry in EXPIRES_IN_MS)) {
      throw APIError.invalidArgument("expires_in must be 7d, 30d, 90d or never");
    }
    const created = await dbInsertReturning<LinkRow>(
      db
        .insert(collectionPublicLinks)
        .values({
          collection_id: row.id,
          token: crypto.randomBytes(24).toString("base64url"),
          created_by_user_id: userId,
          expires_at: expiry === "never" ? null : new Date(Date.now() + EXPIRES_IN_MS[expiry]).toISOString(),
        })
        .returning(),
    );
    if (!created) throw APIError.internal("link not saved");
    return toLink(created);
  },
);

export const disableCollectionPublicLink = api(
  { expose: true, method: "DELETE", path: "/collections/public-links/:linkId", auth: true },
  async ({ linkId }: { linkId: number }): Promise<{ ok: boolean }> => {
    const link = await dbFirst<LinkRow>(db.select().from(collectionPublicLinks).where(eq(collectionPublicLinks.id, linkId)));
    if (!link) throw APIError.notFound("link not found");
    await ownedCollection(link.collection_id);
    await dbExec(
      db.update(collectionPublicLinks).set({ disabled_at: new Date().toISOString() }).where(eq(collectionPublicLinks.id, linkId)),
    );
    resolvedCache.delete(link.token);
    return { ok: true };
  },
);

// ─── What a link shows ──────────────────────────────────────────────────────

export interface PublicPhoto {
  id: number;
  /** The day it was taken, without the time. */
  taken_on: string | null;
}

export interface PublicAlbum {
  id: number;
  title: string;
  photo_ids: number[];
}

export interface PublicDocument {
  id: number;
  title: string;
  date: string | null;
  mime_type: string;
}

export interface PublicCollection {
  title: string;
  description: string | null;
  expires_at: string | null;
  photos: PublicPhoto[];
  albums: PublicAlbum[];
  documents: PublicDocument[];
  /** Entries the link does not show, per kind: bookings, documents only in the PDF, … */
  withheld: Array<{ kind: string; count: number }>;
}

interface Resolved {
  view: PublicCollection;
  photoIds: Set<number>;
  documentIds: Set<number>;
}

/** Thumbnails come in dozens per page; the set behind them is computed once a minute. */
const RESOLVE_TTL_MS = 60_000;
const resolvedCache = new Map<string, { at: number; value: Resolved }>();

async function liveLink(token: string): Promise<LinkRow> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw APIError.notFound("link not found");
  const link = await dbFirst<LinkRow>(db.select().from(collectionPublicLinks).where(eq(collectionPublicLinks.token, token)));
  // An expired or ended link reads like one that never existed.
  if (!link || link.disabled_at || (link.expires_at && new Date(link.expires_at).getTime() <= Date.now())) {
    throw APIError.notFound("link not found");
  }
  return link;
}

/** The photos among `ids` a link of `creatorId` may show: visible to them, not hidden, not opted out. */
async function linkablePhotos(creatorId: number, ids: number[]): Promise<Map<number, PublicPhoto>> {
  if (ids.length === 0) return new Map();
  const rows = await dbAll<{ id: number; taken_at: string | null }>(
    db
      .select({ id: photos.id, taken_at: photos.taken_at })
      .from(photos)
      .where(
        and(
          inArray(photos.id, ids),
          accessiblePhotoCondition(creatorId),
          linkVisiblePhotoSql("photos", [creatorId]),
          sql`NOT EXISTS (
            SELECT 1 FROM ${photoCuration} pc
            WHERE pc.photo_id = ${photos.id} AND pc.user_id = ${creatorId} AND pc.status = 'hidden'
          )`,
        ),
      ),
  );
  return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), taken_on: r.taken_at ? String(r.taken_at).slice(0, 10) : null }]));
}

const KIND_LABELS: Record<string, string> = {
  transaction: "Buchungen",
  security: "Wertpapiere",
  meter: "Zähler",
  meter_reading: "Zählerstände",
  document_partial: "Dokumente mit Schwärzungen oder ausgelassenen Seiten",
  hidden_photo: "Fotos, die nicht geteilt werden",
};

async function resolveLink(link: LinkRow): Promise<Resolved> {
  const cached = resolvedCache.get(link.token);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value;

  // The covering note is what the collection says about itself on its PDF cover.
  const collection = await dbFirst<{ title: string; description: string | null }>(
    db
      .select({ title: documentCollections.title, description: documentCollections.notes })
      .from(documentCollections)
      .where(eq(documentCollections.id, link.collection_id)),
  );
  if (!collection) throw APIError.notFound("link not found");

  // As the creator sees it now, with their rights now.
  const creator = { userId: link.created_by_user_id, permissions: await getPermissionsForUser(link.created_by_user_id) };
  const members = await resolveVisible(await loadStoredMembers(link.collection_id), creator);
  const withheld = new Map<string, number>();
  const holdBack = (kind: string, n = 1) => withheld.set(kind, (withheld.get(kind) ?? 0) + n);

  const photoMemberIds = members.filter((m) => m.entity_type === "photo").map((m) => m.entity_id);
  const albumIds = members.filter((m) => m.entity_type === "album").map((m) => m.entity_id);
  const documentIds = members.filter((m) => m.entity_type === "document").map((m) => m.entity_id);
  for (const m of members) {
    if (!["photo", "album", "document"].includes(m.entity_type)) holdBack(m.entity_type);
  }

  const albumPhotoRows = albumIds.length
    ? await dbAll<{ album_id: number; photo_id: number }>(
        db
          .select({ album_id: albumPhotos.album_id, photo_id: albumPhotos.photo_id })
          .from(albumPhotos)
          .where(inArray(albumPhotos.album_id, albumIds))
          .orderBy(albumPhotos.added_at),
      )
    : [];
  const shown = await linkablePhotos(creator.userId, [...new Set([...photoMemberIds, ...albumPhotoRows.map((r) => Number(r.photo_id))])]);
  const hidden = photoMemberIds.filter((id) => !shown.has(id)).length;
  if (hidden > 0) holdBack("hidden_photo", hidden);

  const albumNames = albumIds.length
    ? new Map((await dbAll<{ id: number; name: string }>(db.select({ id: albums.id, name: albums.name }).from(albums).where(inArray(albums.id, albumIds)))).map((a) => [Number(a.id), a.name]))
    : new Map<number, string>();
  const publicAlbums: PublicAlbum[] = albumIds.map((albumId) => ({
    id: albumId,
    title: albumNames.get(albumId) ?? "Album",
    photo_ids: albumPhotoRows.filter((r) => Number(r.album_id) === albumId && shown.has(Number(r.photo_id))).map((r) => Number(r.photo_id)),
  }));

  // A document goes out whole or not at all.
  const docRows = documentIds.length
    ? await dbAll<{
        id: number;
        title: string | null;
        original_filename: string;
        mime_type: string;
        doc_date: string | null;
        included: boolean;
        excluded_pages: number[];
        redactions: unknown[];
      }>(
        db
          .select({
            id: documents.id,
            title: documents.title,
            original_filename: documents.original_filename,
            mime_type: documents.mime_type,
            doc_date: documents.doc_date,
            included: documentCollectionItems.included,
            excluded_pages: documentCollectionItems.excluded_pages,
            redactions: documentCollectionItems.redactions,
          })
          .from(documentCollectionItems)
          .innerJoin(documents, eq(documents.id, documentCollectionItems.document_id))
          .where(and(eq(documentCollectionItems.collection_id, link.collection_id), inArray(documents.id, documentIds)))
          .orderBy(documentCollectionItems.position),
      )
    : [];
  const publicDocuments: PublicDocument[] = [];
  for (const d of docRows) {
    if (!d.included) continue;
    if ((d.redactions ?? []).length > 0 || (d.excluded_pages ?? []).length > 0) {
      holdBack("document_partial");
      continue;
    }
    publicDocuments.push({
      id: Number(d.id),
      title: d.title?.trim() || d.original_filename,
      date: d.doc_date,
      mime_type: d.mime_type,
    });
  }

  const albumPhotoIds = new Set(publicAlbums.flatMap((a) => a.photo_ids));
  const view: PublicCollection = {
    title: collection.title,
    description: collection.description,
    expires_at: link.expires_at,
    // Photos of the collection itself, then those only in its albums.
    photos: [
      ...photoMemberIds.filter((id) => shown.has(id)).map((id) => shown.get(id)!),
      ...[...albumPhotoIds].filter((id) => !photoMemberIds.includes(id)).map((id) => shown.get(id)!),
    ],
    albums: publicAlbums,
    documents: publicDocuments,
    withheld: [...withheld.entries()].map(([kind, count]) => ({ kind: KIND_LABELS[kind] ?? kind, count })),
  };
  const value: Resolved = { view, photoIds: new Set(view.photos.map((p) => p.id)), documentIds: new Set(publicDocuments.map((d) => d.id)) };
  resolvedCache.set(link.token, { at: Date.now(), value });
  return value;
}

/** Drop the cached view of every link; tests and mutations that must show at once. */
export function forgetResolvedLinks(): void {
  resolvedCache.clear();
}

export const getPublicCollection = api(
  { expose: true, method: "GET", path: "/collections/public/:token", auth: false },
  async ({ token }: { token: string }): Promise<PublicCollection> => {
    return (await resolveLink(await liveLink(token))).view;
  },
);

// ─── Files behind a link ────────────────────────────────────────────────────

function sendError(res: ServerResponse, err: unknown): void {
  const notFound = err instanceof APIError && (err.code === "not_found" || err.code === "invalid_argument");
  res.statusCode = notFound ? 404 : 500;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(notFound ? "not found" : "failed");
}

/** `/collections/public/:token/<kind>/:id` → token and id. */
function parsePath(url: string | undefined): { token: string; id: number } {
  const parts = (url ?? "").split("?")[0]!.split("/").filter(Boolean);
  const token = decodeURIComponent(parts[2] ?? "");
  const id = Number(parts[4]);
  if (!Number.isInteger(id) || id <= 0) throw APIError.notFound("not found");
  return { token, id };
}

const MAX_EDGE = 2560;

/**
 * A photo of the link, always re-encoded: rotated upright, at most
 * `w` (default 2048, at most 2560) pixels on its long edge, as JPEG without
 * any metadata — never the original file.
 */
export const getPublicCollectionPhoto = api.raw(
  { expose: true, method: "GET", path: "/collections/public/:token/photos/:photoId", auth: false },
  async (req, res) => {
    try {
      const { token, id } = parsePath(req.url);
      const resolved = await resolveLink(await liveLink(token));
      if (!resolved.photoIds.has(id)) throw APIError.notFound("not found");
      const row = await dbFirst<{ filename: string; external_path: string | null }>(
        db.select({ filename: photos.filename, external_path: photos.external_path }).from(photos).where(eq(photos.id, id)),
      );
      if (!row) throw APIError.notFound("not found");
      const w = Number(new URL(req.url ?? "", "http://local").searchParams.get("w"));
      const edge = Number.isFinite(w) && w > 0 ? Math.min(Math.round(w), MAX_EDGE) : 2048;
      const bytes = await sharp(getPhotoDiskPath(row), { failOn: "none" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("X-Robots-Tag", "noindex");
      res.end(bytes);
    } catch (err) {
      sendError(res, err);
    }
  },
);

/** A document of the link, as its file. */
export const getPublicCollectionDocument = api.raw(
  { expose: true, method: "GET", path: "/collections/public/:token/documents/:documentId", auth: false },
  async (req, res) => {
    try {
      const { token, id } = parsePath(req.url);
      const resolved = await resolveLink(await liveLink(token));
      if (!resolved.documentIds.has(id)) throw APIError.notFound("not found");
      const row = await dbFirst<{ id: number; disk_path: string; receipt_ocr_state: string | null; title: string | null; original_filename: string }>(
        db
          .select({
            id: documents.id,
            disk_path: documents.disk_path,
            receipt_ocr_state: documents.receipt_ocr_state,
            title: documents.title,
            original_filename: documents.original_filename,
          })
          .from(documents)
          .where(eq(documents.id, id)),
      );
      const source = row ? await exportSourcePath(row) : null;
      if (!row || !source) throw APIError.notFound("not found");
      const stat = await fs.promises.stat(source.path);
      res.statusCode = 200;
      res.setHeader("Content-Type", source.mime);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Robots-Tag", "noindex");
      res.setHeader("Content-Disposition", contentDisposition(row.original_filename));
      fs.createReadStream(source.path).pipe(res);
    } catch (err) {
      sendError(res, err);
    }
  },
);
