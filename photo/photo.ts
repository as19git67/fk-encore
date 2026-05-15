import fs from "fs";
import path from "path";
import crypto from "crypto";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { writeMaintenanceResponseIfActive } from "../backup/maintenance";
import * as service from "./photo.service";
import { UPLOAD_DIR, THUMBNAIL_DIR, thumbnailShardPath } from "./photo.service";
import { PHOTO_LIBRARIES_ROOT } from "./libraries.service";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { photos as photosTable } from "../db/schema";
import type {
  Album,
  AlbumWithPhotos,
  AlbumUserSettings,
  UpdateAlbumUserSettingsRequest,
  CreateAlbumRequest,
  UpdateAlbumRequest,
  AddPhotoToAlbumRequest,
  BatchAlbumPhotosRequest,
  ListPhotoAlbumsResponse,
  ShareAlbumRequest,
  GetAlbumSharesResponse,
  RemoveAlbumShareRequest,
  ListAlbumsResponse,
  ListPhotosResponse,
  PhotoDetailsBatchResponse,
  DeleteResponse,
  Person,
  Face,
  ListPersonsResponse,
  PersonDetails,
  MergePersonsRequest,
  AssignFaceRequest,
  CurationStatus,
  UpdateCurationRequest,
  PhotoWithCuration,
  AlbumPublicLink,
  PublicAlbumResponse,
  PhotoLocationsResponse,
} from "../db/types";
import { Query } from "encore.dev/api";
import { parsePhotoFilterQuery, type PhotoFilterQuery } from "./photo.filters";

type PhotoFilterQueryParams = {
  showHidden?: Query<boolean>;
  hiddenMode?: Query<string>;
  favorite?: Query<boolean>;
  albumHighlight?: Query<boolean>;
  groupHighlight?: Query<boolean>;
  inGroup?: Query<boolean>;
  othersFavorited?: Query<boolean>;
  othersHidden?: Query<boolean>;
  qualityMin?: Query<number>;
  qualityMax?: Query<number>;
  notInAnyAlbum?: Query<boolean>;
  albumIds?: Query<string>;
  albumMode?: Query<string>;
  personIds?: Query<string>;
  personMode?: Query<string>;
  mediaTypes?: Query<string>;
  hasGps?: Query<boolean>;
  hasFaces?: Query<boolean>;
  hasAssignedPerson?: Query<boolean>;
  dateFrom?: Query<string>;
  dateTo?: Query<string>;
  importedDaysAgo?: Query<number>;
  sizeMin?: Query<number>;
  sizeMax?: Query<number>;
  showAiHidden?: Query<boolean>;
  aiHiddenMode?: Query<string>;
  /** Maximum number of rows to return. Omit for "all". */
  limit?: Query<number>;
  /** Number of rows to skip before returning `limit` rows. */
  offset?: Query<number>;
};

function toFilterQuery(p: PhotoFilterQueryParams): PhotoFilterQuery {
  return {
    showHidden: p.showHidden,
    hiddenMode: p.hiddenMode,
    favorite: p.favorite,
    albumHighlight: p.albumHighlight,
    groupHighlight: p.groupHighlight,
    inGroup: p.inGroup,
    othersFavorited: p.othersFavorited,
    othersHidden: p.othersHidden,
    qualityMin: p.qualityMin,
    qualityMax: p.qualityMax,
    notInAnyAlbum: p.notInAnyAlbum,
    albumIds: p.albumIds,
    albumMode: p.albumMode,
    personIds: p.personIds,
    personMode: p.personMode,
    mediaTypes: p.mediaTypes,
    hasGps: p.hasGps,
    hasFaces: p.hasFaces,
    hasAssignedPerson: p.hasAssignedPerson,
    dateFrom: p.dateFrom,
    dateTo: p.dateTo,
    importedDaysAgo: p.importedDaysAgo,
    sizeMin: p.sizeMin,
    sizeMax: p.sizeMax,
    showAiHidden: p.showAiHidden,
    aiHiddenMode: p.aiHiddenMode,
  };
}

// Helper to get userId as number
function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID);
}

// Check module permission
function checkModule() {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.photos");
}

/**
 * Upload a photo.
 * Expects the raw image data in the request body.
 * Filename should be provided in X-File-Name header.
 */
export const uploadPhoto = api.raw(
  { expose: true, method: "POST", path: "/photos", auth: true, bodyLimit: null },
  async (req, res) => {
    if (writeMaintenanceResponseIfActive(res)) return;
    try {
      checkModule();
    } catch (err: any) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const userId = getUserId();
    const authData = getAuthData()!;
    try {
      requirePermission(authData, "photos.upload");
    } catch (err: any) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Missing permission: photos.upload" }));
      return;
    }

    const rawFileName = (req.headers["x-file-name"] as string) || "photo.jpg";
    // Client percent-encodes the filename to stay within ISO-8859-1 header limits.
    let fileName = rawFileName;
    try {
      fileName = decodeURIComponent(rawFileName);
    } catch {
      fileName = rawFileName;
    }
    const mimeType = (req.headers["content-type"] as string) || "image/jpeg";
    const isFavorite = req.headers["x-is-favorite"] === "true";
    // Optional fallback when the file's EXIF carries no DateTimeOriginal —
    // the iOS client forwards PHAsset.creationDate here.
    const capturedAtHeader = req.headers["x-captured-at"];
    const clientCapturedAt = typeof capturedAtHeader === "string" ? capturedAtHeader : null;

    try {
      const photo = await service.uploadPhotoStream(userId, req, fileName, mimeType, isFavorite, clientCapturedAt);

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(photo));
    } catch (err: any) {
      if (err instanceof service.PhotoAlreadyExistsError || err?.message === "PHOTO_ALREADY_EXISTS") {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          error: "Duplicate photo",
          message: "Foto wurde bereits hochgeladen.",
          // Returned so the client can still operate on the existing record
          // (e.g. add to a target album when the upload was meant to do both).
          photoId: err instanceof service.PhotoAlreadyExistsError ? err.existingPhotoId : undefined,
        }));
        return;
      }
      if (err.message === "UNSUPPORTED_FILE_TYPE") {
        res.statusCode = 415;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Unsupported file type", message: "Dateiformat wird nicht unterstützt." }));
        return;
      }
      console.error("Upload error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message || "Internal Server Error", message: err.message || "Interner Server-Fehler" }));
    }
  }
);

/**
 * Check whether a photo with the given SHA-256 hash already exists for the
 * current user. Used by the client to avoid uploading duplicates and save
 * bandwidth (especially on mobile data connections).
 */
export const checkPhotoHash = api(
  { expose: true, method: "GET", path: "/photos/check-hash/:hash", auth: true },
  async ({ hash }: { hash: string }): Promise<{ exists: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.upload");

    const normalized = (hash ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) {
      throw APIError.invalidArgument("hash must be a SHA-256 hex string (64 chars)");
    }

    return await service.checkPhotoHashLogic(userId, normalized);
  }
);

/**
 * List all photos owned by the user.
 */
export const listPhotos = api(
  { expose: true, method: "GET", path: "/photos", auth: true },
  async (params: PhotoFilterQueryParams): Promise<ListPhotosResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");

    const filter = parsePhotoFilterQuery(toFilterQuery(params));
    return await service.listPhotosLogic(userId, filter);
  }
);

/**
 * Lightweight gallery index. Returns only the columns needed to render the
 * photo grid (id, filename, dates, curation_status, auto_crop). The frontend
 * then progressively loads the full details via /photos/details.
 *
 * Substantially faster than /photos for large libraries because the JSON
 * payload per row is reduced from ~20 columns to ~10 small columns and
 * the SQL query no longer materializes the heavy JSONB columns
 * (ai_quality_details, location_*, description, hash, GPS).
 *
 * Implemented as a raw endpoint so it can emit an ETag and short-circuit
 * with 304 Not Modified when the client's cached copy is still current.
 * The ETag is derived from a cheap user-scoped fingerprint:
 *   md5(userId | MAX(photos.updated_at) | COUNT(photos) | serializedFilter)
 * Both MAX and COUNT are served by the (user_id, updated_at DESC) index
 * added in migration 0034, so the fingerprint query runs in single-digit
 * ms even on large libraries. When the fingerprint and filter match the
 * value the client supplied via If-None-Match we skip the full SELECT and
 * JSON serialization entirely.
 */
function parsePhotoIndexQuery(url: URL): PhotoFilterQueryParams {
  const sp = url.searchParams;
  const readBool = (k: string): boolean | undefined => {
    const v = sp.get(k);
    if (v === null) return undefined;
    return v === "true" || v === "1";
  };
  const readNum = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const readStr = (k: string): string | undefined => sp.get(k) ?? undefined;
  return {
    showHidden: readBool("showHidden"),
    hiddenMode: readStr("hiddenMode"),
    favorite: readBool("favorite"),
    albumHighlight: readBool("albumHighlight"),
    groupHighlight: readBool("groupHighlight"),
    inGroup: readBool("inGroup"),
    othersFavorited: readBool("othersFavorited"),
    othersHidden: readBool("othersHidden"),
    qualityMin: readNum("qualityMin"),
    qualityMax: readNum("qualityMax"),
    notInAnyAlbum: readBool("notInAnyAlbum"),
    albumIds: readStr("albumIds"),
    albumMode: readStr("albumMode"),
    personIds: readStr("personIds"),
    personMode: readStr("personMode"),
    mediaTypes: readStr("mediaTypes"),
    hasGps: readBool("hasGps"),
    hasFaces: readBool("hasFaces"),
    hasAssignedPerson: readBool("hasAssignedPerson"),
    dateFrom: readStr("dateFrom"),
    dateTo: readStr("dateTo"),
    importedDaysAgo: readNum("importedDaysAgo"),
    sizeMin: readNum("sizeMin"),
    sizeMax: readNum("sizeMax"),
    showAiHidden: readBool("showAiHidden"),
    aiHiddenMode: readStr("aiHiddenMode"),
    limit: readNum("limit"),
    offset: readNum("offset"),
  };
}

/**
 * Canonical serialization of the filter + pagination pair used both for
 * ETag hashing and for cache-key logging. Keys are sorted so that URLs
 * with the same effective filter but different parameter order produce
 * identical ETags.
 */
function serializePhotoIndexKey(params: PhotoFilterQueryParams): string {
  const entries: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    entries.push([k, String(v)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

export const listPhotoIndex = api.raw(
  { expose: true, method: "GET", path: "/photos/index", auth: true },
  async (req, res) => {
    if (writeMaintenanceResponseIfActive(res)) return;
    try {
      checkModule();
    } catch (err: any) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ code: "permission_denied", message: "Forbidden" }));
      return;
    }

    const userId = getUserId();
    const authData = getAuthData()!;
    try {
      requirePermission(authData, "photos.view");
    } catch {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ code: "permission_denied", message: "Missing permission: photos.view" }));
      return;
    }

    const url = new URL(req.url || "", `http://${req.headers.host ?? "localhost"}`);
    const params = parsePhotoIndexQuery(url);
    const filter = parsePhotoFilterQuery(toFilterQuery(params));

    // Same cap as before: 5000 rows per page.
    const MAX_LIMIT = 5000;
    const limit = typeof params.limit === "number" && params.limit > 0
      ? Math.min(params.limit, MAX_LIMIT)
      : undefined;
    const offset = typeof params.offset === "number" && params.offset > 0
      ? params.offset
      : 0;

    const normalizedKey = serializePhotoIndexKey({
      ...params,
      limit,
      offset: offset || undefined,
    });

    // Fingerprint query – cheap aggregated SELECT on the photos table.
    // Runs on every request but is served by an index.
    const fp = await service.getPhotoIndexFingerprint(userId);
    const etag = service.photoIndexEtag(userId, fp, normalizedKey);

    // Per-user data must not be cached by shared proxies. `private` +
    // `no-cache` tells the browser it MAY store the response but MUST
    // revalidate with If-None-Match on every subsequent fetch, which is
    // exactly what the ETag flow relies on.
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("ETag", etag);
    // Authorization varies the response, so proxies that ignore
    // Cache-Control must at least key on the auth header.
    res.setHeader("Vary", "Authorization");

    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    const payload = await service.listPhotoIndexLogic(userId, filter, { limit, offset });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  },
);

/**
 * Batch fetch full photo details for a set of IDs (comma-separated query
 * parameter). Used to progressively hydrate the lightweight /photos/index
 * response with the heavy fields (location, GPS, ai_quality_*, description).
 */
export const getPhotoDetailsBatch = api(
  { expose: true, method: "GET", path: "/photos/details", auth: true },
  async ({ ids }: { ids: Query<string> }): Promise<PhotoDetailsBatchResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");

    const parsedIds = (ids ?? "")
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    return await service.getPhotoDetailsBatchLogic(userId, parsedIds);
  }
);

/**
 * Delete a photo.
 */
export const deletePhoto = api(
  { expose: true, method: "DELETE", path: "/photos/:id", auth: true },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");

    return await service.deletePhotoLogic(userId, id);
  }
);

/**
 * Permanently delete a photo (file + DB record).
 */
export const hardDeletePhoto = api(
  { expose: true, method: "DELETE", path: "/photos/:id/hard", auth: true },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.hardDeletePhotoLogic(userId, id);
  }
);

/**
 * Permanently delete multiple photos. Skips photos the caller does not own
 * and photos imported via library link (external_path set). Returns the IDs
 * that were deleted and the IDs that were skipped with the reason.
 */
export const batchDeletePhotos = api(
  { expose: true, method: "POST", path: "/photos/batch-delete", auth: true },
  async ({ photoIds }: { photoIds: number[] }): Promise<service.BatchDeleteResult> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.batchDeletePhotosLogic(userId, photoIds);
  }
);

/**
 * Update curation status for a photo (visible/hidden/favorite).
 */
export const updatePhotoCuration = api(
  { expose: true, method: "PATCH", path: "/photos/:id/curation", auth: true },
  async ({ id, status }: UpdateCurationRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    // Hiding/curation is a view-level action — require view permission, not delete.
    requirePermission(authData, "photos.view");
    try {
      return await service.updatePhotoCurationLogic(userId, id, status);
    } catch (err: any) {
      // Map service-layer unauthorized errors to a structured 403 API error
      if (err && (err.message === "Photo not found or unauthorized" || err.message === "Photo not found or unauthorized")) {
        throw APIError.permissionDenied('Nicht berechtigt, Foto-Ausblendung vorzunehmen');
      }
      throw err;
    }
  }
);

/**
 * Batch-favorite multiple photos within an album.
 * Used by the "others' favorites" view to favorite all visible photos at once.
 */
export const batchFavoritePhotos = api(
  { expose: true, method: "POST", path: "/albums/:albumId/batch-favorite", auth: true },
  async ({ albumId, photoIds }: { albumId: number; photoIds: number[] }): Promise<{ success: boolean; favorited: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.batchFavoritePhotosLogic(userId, albumId, photoIds);
  }
);

/**
 * Get all photo IDs for metadata refresh.
 */
export const getPhotosToRefreshMetadata = api(
  { expose: true, method: "GET", path: "/photos/refresh-metadata", auth: true },
  async (): Promise<{ ids: number[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.refresh_metadata");

    return await service.getPhotosToRefreshMetadataLogic(userId);
  }
);

/**
 * Refresh metadata for a specific photo.
 */
export const refreshPhotoMetadata = api(
  { expose: true, method: "POST", path: "/photos/:id/refresh-metadata", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean; taken_at?: string }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.refresh_metadata");

    return await service.refreshPhotoMetadataLogic(userId, id);
  }
);

/**
 * Update the "taken at" date of a photo.
 */
export const updatePhotoDate = api(
  { expose: true, method: "PATCH", path: "/photos/:id/date", auth: true },
  async ({ id, taken_at }: { id: number; taken_at: string }): Promise<{ success: boolean; taken_at: string }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.upload");

    const parsed = new Date(taken_at);
    if (!taken_at || Number.isNaN(parsed.getTime())) {
      throw APIError.invalidArgument("taken_at must be a valid ISO datetime");
    }

    return await service.updatePhotoDateLogic(userId, id, taken_at);
  }
);

/**
 * Update the description/text of a photo. Also writes to EXIF data.
 */
export const updatePhotoDescription = api(
  { expose: true, method: "PATCH", path: "/photos/:id/description", auth: true },
  async ({ id, description }: { id: number; description: string | null }): Promise<{ success: boolean; description: string | null }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.upload");

    return await service.updatePhotoDescriptionLogic(userId, id, description);
  }
);

/**
 * Serve a photo file.
 */
/**
 * Resolve a public `/photos/file/*filename` URL to a real on-disk path.
 *
 * Two layouts are supported:
 *   - Uploaded photos: filename is `YYYY/YYYY-MM/<name>.<ext>` and the file
 *     lives under UPLOAD_DIR.
 *   - Library photos in `link` mode: filename is `__library/<id>/<basename>`
 *     and the actual file lives under PHOTO_LIBRARIES_ROOT (looked up via
 *     the photos.external_path column).
 *
 * Returns null when the path is invalid or refers to nothing on disk; in
 * that case the caller should respond with 404.
 */
async function resolvePhotoFilePath(filename: string): Promise<string | null> {
  const topSegment = filename.split("/")[0];
  if (topSegment === "_tmp" || topSegment.startsWith(".")) {
    return null;
  }

  if (topSegment === "__library") {
    const row = await dbFirst<{ external_path: string | null }>(
      db.select({ external_path: photosTable.external_path })
        .from(photosTable)
        .where(eq(photosTable.filename, filename))
    );
    if (!row?.external_path) return null;
    const abs = path.resolve(row.external_path);
    const rootWithSep = PHOTO_LIBRARIES_ROOT.endsWith(path.sep)
      ? PHOTO_LIBRARIES_ROOT
      : PHOTO_LIBRARIES_ROOT + path.sep;
    if (abs !== PHOTO_LIBRARIES_ROOT && !abs.startsWith(rootWithSep)) {
      console.error("Rejected library path outside PHOTO_LIBRARIES_ROOT:", abs);
      return null;
    }
    try {
      await fs.promises.access(abs);
      return abs;
    } catch {
      return null;
    }
  }

  const filePath = path.resolve(UPLOAD_DIR, filename);
  const uploadDirWithSep = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (filePath !== UPLOAD_DIR && !filePath.startsWith(uploadDirWithSep)) {
    return null;
  }
  try {
    await fs.promises.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

export const getPhotoFile = api.raw(
  { expose: true, method: "GET", path: "/photos/file/*filename", auth: false },
  async (req, res) => {
    if (writeMaintenanceResponseIfActive(res)) return;
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      // Strip the fixed route prefix to retrieve the (possibly multi-segment)
      // filename, which is now of the form `YYYY/YYYY-MM/<name>.<ext>`.
      const rawPath = decodeURIComponent(url.pathname.replace(/^\/photos\/file\//, ""));
      const filename = rawPath.replace(/^\/+/, "");
      console.log("Serving photo file:", filename);

      const filePath = await resolvePhotoFilePath(filename);
      if (!filePath) {
        res.statusCode = 404;
        res.end("File not found");
        return;
      }

      const ext = path.extname(filename).toLowerCase();
      let mimeType = "application/octet-stream";
      if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
      else if (ext === ".png") mimeType = "image/png";
      else if (ext === ".gif") mimeType = "image/gif";
      else if (ext === ".webp") mimeType = "image/webp";
      else if (ext === ".heic") mimeType = "image/heic";
      else if (ext === ".heif") mimeType = "image/heif";

      const widthStr = url.searchParams.get("w");
      const shouldConvert = url.searchParams.get("convert") === "true";
      const targetWidth = widthStr ? parseInt(widthStr, 10) : null;

      const isHeicFile = ext === ".heic" || ext === ".heif";
      const needsConvert = isHeicFile && shouldConvert;
      const needsResize = targetWidth !== null && !isNaN(targetWidth) && targetWidth > 0;

      // The thumbnail cache and the originals on disk are both immutable for
      // the duration of a photo's lifetime — filenames are content-addressed
      // (upload timestamp or external library path) and we never overwrite
      // existing files. So we can emit a strong ETag derived purely from the
      // filename + its transform parameters, without hashing the file bytes.
      // If-None-Match with the same value gets a cheap 304 and the browser
      // uses its local copy, saving both the transfer and the sharp() call
      // for cache-miss regeneration.
      const etagSource = `${filename}|w=${targetWidth ?? ""}|c=${shouldConvert ? "1" : "0"}`;
      const etag = `"${crypto.createHash("md5").update(etagSource).digest("hex")}"`;
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
        // Must still send cache-related headers on 304 per RFC 9111 § 4.3.4.
        res.statusCode = 304;
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end();
        return;
      }

      if (needsConvert || needsResize) {
          try {
              // Build a deterministic cache path: <THUMBNAIL_DIR>/<shard>/<basename>_<key>.jpg
              // For uploaded photos `filename` is timestamp-based so basename is
              // unique. For library photos basenames can collide across libraries —
              // disambiguate by hashing the full filename and prefixing it.
              const baseName = path.basename(filename, path.extname(filename));
              const isLibrary = filename.startsWith("__library/");
              const cacheBase = isLibrary
                ? `${baseName}_${crypto.createHash("md5").update(filename).digest("hex").slice(0, 8)}`
                : baseName;
              const cacheFile = needsResize
                ? `${cacheBase}_${targetWidth}w.jpg`
                : `${cacheBase}_converted.jpg`;
              const shardPath = thumbnailShardPath(cacheBase);
              const cachePath = path.join(shardPath, cacheFile);

              let cacheHit = false;
              try {
                  await fs.promises.access(cachePath);
                  cacheHit = true;
              } catch {
                  // cache miss — fall through to regeneration below
              }
              if (cacheHit) {
                  res.setHeader("Content-Type", "image/jpeg");
                  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
                  res.setHeader("ETag", etag);
                  fs.createReadStream(cachePath).pipe(res);
                  return;
              }

              let buffer: Buffer;

              if (isHeicFile) {
                  buffer = await service.convertHeicToJpeg(filePath);
              } else {
                  buffer = await fs.promises.readFile(filePath);
              }

              if (needsResize) {
                  buffer = await service.resizeImage(buffer, targetWidth!);
              }

              // Persist to thumbnail cache (fire-and-forget, don't block the response)
              fs.promises.mkdir(shardPath, { recursive: true })
                .then(() => fs.promises.writeFile(cachePath, buffer))
                .catch(err => console.error("Failed to write thumbnail cache:", err));

              res.setHeader("Content-Type", "image/jpeg");
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              res.setHeader("ETag", etag);
              res.end(buffer);
              return;
          } catch (err) {
              console.error("Error processing image:", err);
              // Fallback to original below
          }
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", etag);
      fs.createReadStream(filePath).pipe(res);
    } catch (err: any) {
      console.error("Error serving photo file:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
);

// ---------- AI photo transformations ----------

import { renderSuggestedAndCache } from "./photo-transforms-render.service";
import type { PhotoTransformAspectRatio } from "../db/schema";

const VALID_RATIOS: ReadonlySet<PhotoTransformAspectRatio> = new Set([
  "1:1",
  "4:5",
  "5:4",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
]);

/**
 * Server-render a photo with an AI-suggested or user recipe applied.
 *
 * Query params:
 *   v=suggested  — apply the AI suggestion (requires ratio=)
 *   v=original   — passthrough; equivalent to /photos/file/* without transforms
 *   v=user       — apply the requesting user's recipe (not yet implemented;
 *                  returns 501 until the transforms-CRUD API lands)
 *   ratio=…      — one of 1:1, 4:5, 5:4, 3:4, 4:3, 16:9, 9:16 (required for v=suggested)
 *   w=…          — target width in pixels; omit for full resolution
 *
 * `auth: false`: mirrors /photos/file/* — addressability via numeric photo
 * IDs is on par with the existing public file endpoint, and no information
 * is leaked beyond what that endpoint already exposes.
 */
export const renderPhotoTransformed = api.raw(
  { expose: true, method: "GET", path: "/photos/:id/render", auth: false },
  async (req, res) => {
    if (writeMaintenanceResponseIfActive(res)) return;
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      // The path captured `id` segment lives in the URL; api.raw doesn't
      // surface path params to the handler, so we parse it ourselves.
      const match = url.pathname.match(/\/photos\/(\d+)\/render$/);
      if (!match) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      const photoId = parseInt(match[1], 10);
      if (!Number.isFinite(photoId)) {
        res.statusCode = 400;
        res.end("Invalid photo id");
        return;
      }

      const variant = (url.searchParams.get("v") ?? "suggested").toLowerCase();
      if (variant === "user") {
        res.statusCode = 501;
        res.end("v=user not implemented yet");
        return;
      }
      if (variant !== "suggested" && variant !== "original") {
        res.statusCode = 400;
        res.end("v must be one of: suggested, original, user");
        return;
      }
      if (variant === "original") {
        // Defer to the standard file serving — clients should just use
        // /photos/file/* for this case. Send a hint so the misuse is loud.
        res.statusCode = 400;
        res.end("v=original — use /photos/file/* instead");
        return;
      }

      const ratio = url.searchParams.get("ratio");
      if (!ratio || !VALID_RATIOS.has(ratio as PhotoTransformAspectRatio)) {
        res.statusCode = 400;
        res.end(
          `ratio must be one of: ${Array.from(VALID_RATIOS).join(", ")}`,
        );
        return;
      }

      const widthStr = url.searchParams.get("w");
      const targetWidth = widthStr ? parseInt(widthStr, 10) : null;
      if (widthStr != null && (!Number.isFinite(targetWidth!) || targetWidth! <= 0)) {
        res.statusCode = 400;
        res.end("w must be a positive integer");
        return;
      }

      const result = await renderSuggestedAndCache(
        photoId,
        ratio as PhotoTransformAspectRatio,
        targetWidth,
      );
      if (!result) {
        res.statusCode = 404;
        res.end("No suggestion available for this photo+ratio");
        return;
      }

      // Cheap conditional GET — every change to the recipe / model version
      // flips the etag because it's derived from the same key as the cache.
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatch === result.etag) {
        res.statusCode = 304;
        res.setHeader("ETag", result.etag);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end();
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("ETag", result.etag);
      res.setHeader("X-Cache", result.cacheHit ? "HIT" : "MISS");
      res.end(result.buffer);
    } catch (err: any) {
      console.error("Error rendering transformed photo:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  },
);

const ENABLE_LOCAL_FACES = process.env.ENABLE_LOCAL_FACES === "true";

// ---------- Albums ----------

/**
 * Create a new album.
 */
export const createAlbum = api(
  { expose: true, method: "POST", path: "/albums", auth: true },
  async (req: CreateAlbumRequest): Promise<Album> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "albums.manage");
    
    return await service.createAlbumLogic(userId, req);
  }
);

/**
 * List all albums accessible to the user.
 */
export const listAlbums = api(
  { expose: true, method: "GET", path: "/albums", auth: true },
  async (): Promise<ListAlbumsResponse> => {
    checkModule();
    const userId = getUserId();
    return await service.listAlbumsLogic(userId);
  }
);

/**
 * Get an album with its photos.
 */
export const getAlbum = api(
  { expose: true, method: "GET", path: "/albums/:id", auth: true },
  async ({ id }: { id: number }): Promise<AlbumWithPhotos> => {
    checkModule();
    const userId = getUserId();
    return await service.getAlbumLogic(userId, id);
  }
);

/**
 * Update an album (rename).
 */
export const updateAlbum = api(
  { expose: true, method: "PATCH", path: "/albums", auth: true },
  async (req: UpdateAlbumRequest): Promise<Album> => {
    checkModule();
    const userId = getUserId();
    return await service.updateAlbumLogic(userId, req);
  }
);

/**
 * Delete an album.
 */
export const deleteAlbum = api(
  { expose: true, method: "DELETE", path: "/albums/:id", auth: true },
  async ({ id }: { id: number }): Promise<DeleteResponse> => {
    checkModule();
    const userId = getUserId();
    return await service.deleteAlbumLogic(userId, id);
  }
);

/**
 * Add a photo to an album.
 */
export const addPhotoToAlbum = api(
  { expose: true, method: "POST", path: "/albums/photos", auth: true },
  async (req: AddPhotoToAlbumRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.addPhotoToAlbumLogic(userId, req);
  }
);

/**
 * Get album IDs for a list of photos.
 */
export const getPhotosAlbums = api(
  { expose: true, method: "GET", path: "/photos/albums", auth: true },
  async ({ ids }: { ids: Query<string> }): Promise<ListPhotoAlbumsResponse> => {
    checkModule();
    const userId = getUserId();
    const photoIds = ids.split(",").map(id => parseInt(id)).filter(id => !isNaN(id));
    return await service.getPhotoAlbumsLogic(userId, photoIds);
  }
);

/**
 * Get jump destinations for a photo: list of albums containing the photo,
 * list of named persons tagged in it and whether it has GPS coordinates.
 * Used by the "Show photo in…" menu in the web UI.
 */
export const getPhotoLocations = api(
  { expose: true, method: "GET", path: "/photos/:id/locations", auth: true },
  async ({ id }: { id: number }): Promise<PhotoLocationsResponse> => {
    checkModule();
    const userId = getUserId();
    return await service.getPhotoLocationsLogic(userId, id);
  }
);

/**
 * Batch add/remove photos to/from albums.
 */
export const batchUpdateAlbumPhotos = api(
  { expose: true, method: "POST", path: "/albums/photos/batch", auth: true },
  async (req: BatchAlbumPhotosRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.batchUpdateAlbumPhotosLogic(userId, req);
  }
);

/**
 * Share an album with another user.
 */
export const shareAlbum = api(
  { expose: true, method: "POST", path: "/albums/share", auth: true },
  async (req: ShareAlbumRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.shareAlbumLogic(userId, req);
  }
);

/**
 * Get all shares for an album (owner only).
 */
export const getAlbumShares = api(
  { expose: true, method: "GET", path: "/albums/:id/shares", auth: true },
  async ({ id }: { id: number }): Promise<GetAlbumSharesResponse> => {
    checkModule();
    const userId = getUserId();
    return await service.getAlbumSharesLogic(userId, id);
  }
);

/**
 * Remove a share from an album (owner only).
 */
export const removeAlbumShare = api(
  { expose: true, method: "DELETE", path: "/albums/:albumId/shares/:userId", auth: true },
  async ({ albumId, userId: sharedUserId }: { albumId: number; userId: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.removeAlbumShareLogic(userId, { albumId, userId: sharedUserId });
  }
);

/**
 * Leave an album share. A non-owner participant removes themselves.
 */
export const leaveAlbum = api(
  { expose: true, method: "DELETE", path: "/albums/:id/leave", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.leaveAlbumLogic(userId, id);
  }
);

/**
 * Create a public share link for an album (owner only).
 */
export const createAlbumPublicLink = api(
  { expose: true, method: "POST", path: "/albums/:id/public-link", auth: true },
  async ({ id, expiresIn }: { id: number; expiresIn?: string }): Promise<AlbumPublicLink> => {
    checkModule();
    const userId = getUserId();
    return await service.createAlbumPublicLinkLogic(userId, id, expiresIn);
  }
);

/**
 * Delete the public share link for an album (owner only).
 */
export const deleteAlbumPublicLink = api(
  { expose: true, method: "DELETE", path: "/albums/:id/public-link", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    return await service.deleteAlbumPublicLinkLogic(userId, id);
  }
);

/**
 * Get an album by public share token (no authentication required).
 */
export const getPublicAlbum = api(
  { expose: true, method: "GET", path: "/albums/public/:token", auth: false },
  async ({ token }: { token: string }): Promise<PublicAlbumResponse> => {
    return await service.getPublicAlbumLogic(token);
  }
);

/**
 * Update personal settings/preferences for an album.
 */
export const updateAlbumUserSettings = api(
  { expose: true, method: "PATCH", path: "/albums/:id/settings", auth: true },
  async ({ id, ...req }: { id: number } & Omit<UpdateAlbumUserSettingsRequest, "albumId">): Promise<AlbumUserSettings> => {
    checkModule();
    const userId = getUserId();
    return await service.updateAlbumUserSettingsLogic(userId, { ...req, albumId: id });
  }
);

// ---------- People & Faces ----------

/**
 * List all persons owned by the user.
 */
export const listPersons = api(
  { expose: true, method: "GET", path: "/persons", auth: true },
  async ({ limit }: { limit?: Query<number> }): Promise<ListPersonsResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.view");
    return await service.listPersonsLogic(userId, limit);
  }
);

/**
 * Get person details with their faces.
 */
export const getPersonDetails = api(
  { expose: true, method: "GET", path: "/persons/:id", auth: true },
  async ({ id }: { id: number }): Promise<PersonDetails> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.view");
    return await service.getPersonDetailsLogic(userId, id);
  }
);

/**
 * Update person (rename).
 */
export const updatePerson = api(
  { expose: true, method: "PATCH", path: "/persons/:id", auth: true },
  async ({ id, name }: { id: number; name: string }): Promise<Person & { faceCount: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.edit");
    return await service.updatePersonLogic(userId, id, name);
  }
);

/**
 * Merge multiple persons into one.
 */
export const mergePersons = api(
  { expose: true, method: "POST", path: "/persons/merge", auth: true },
  async (req: MergePersonsRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.edit");
    return await service.mergePersonsLogic(userId, req);
  }
);

/**
 * Assign a face to a person.
 */
export const assignFaceToPerson = api(
  { expose: true, method: "POST", path: "/faces/:faceId/assign", auth: true },
  async ({ faceId, personId }: AssignFaceRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.edit");
    return await service.assignFaceToPersonLogic(userId, faceId, personId);
  }
);

/**
 * Ignore a face (manual removal).
 */
export const ignoreFace = api(
  { expose: true, method: "POST", path: "/faces/:faceId/ignore", auth: true },
  async ({ faceId }: { faceId: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.edit");
    return await service.ignoreFaceLogic(userId, faceId);
  }
);

/**
 * Ignore all faces of a person (manual removal).
 */
export const ignorePersonFaces = api(
  { expose: true, method: "POST", path: "/persons/:id/ignore", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.edit");
    return await service.ignorePersonFacesLogic(userId, id);
  }
);

/**
 * Reindex a single photo.
 */
export const reindexPhoto = api(
  { expose: true, method: "POST", path: "/photos/:id/reindex", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.refresh_metadata");
    return await service.reindexPhotoLogic(userId, id);
  }
);

/**
 * Get faces for a specific photo.
 */
export const getPhotoFaces = api(
  { expose: true, method: "GET", path: "/photos/:id/faces", auth: true },
  async ({ id }: { id: number }): Promise<{ faces: Face[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.view");
    return await service.getPhotoFacesLogic(userId, id);
  }
);


// ========== Service Health ==========

import { getAllServiceHealthStatuses, getServerPressureStatus, type ServiceHealthStatus, type ServerPressureStatus } from "./service-health";

export const getExternalServiceHealth = api(
  { expose: true, method: "GET", path: "/photos/service-health", auth: true },
  async (): Promise<{ services: ServiceHealthStatus[]; serverPressure: ServerPressureStatus }> => {
    checkModule();
    return {
      services: getAllServiceHealthStatuses(),
      serverPressure: getServerPressureStatus(),
    };
  }
);

// ========== Scan Queue ==========

import type { QueueStatus } from "./scan-queue";

export const getScanQueueStatus = api(
  { expose: true, method: "GET", path: "/photos/scan-queue/status", auth: true },
  async (): Promise<QueueStatus> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.getScanQueueStatusLogic(userId);
  }
);

export const getPhotosNeedingGpsRescan = api(
  { expose: true, method: "GET", path: "/photos/needs-gps-rescan", auth: true },
  async (): Promise<{ ids: number[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.getPhotosNeedingGpsRescanLogic(userId);
  }
);

export const rescanPhotoGps = api(
  { expose: true, method: "POST", path: "/photos/:id/rescan-gps", auth: true },
  async ({ id }: { id: number }): Promise<{ gpsFound: boolean; geocoded: boolean; scansQueued: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.rescanPhotoGpsLogic(userId, id);
  }
);

export const rescanPhotos = api(
  { expose: true, method: "POST", path: "/photos/rescan", auth: true },
  async ({ force }: { force: boolean }): Promise<{ queued: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.rescanPhotosLogic(userId, force);
  }
);

export const retryFailedScans = api(
  { expose: true, method: "POST", path: "/photos/scan-queue/retry-failed", auth: true },
  async (): Promise<{ retried: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.retryFailedScansLogic(userId);
  }
);

export const cancelPendingScans = api(
  { expose: true, method: "POST", path: "/photos/scan-queue/cancel", auth: true },
  async (): Promise<{ cancelled: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.cancelPendingScansLogic(userId);
  }
);

/**
 * Recompute auto-crop focus points for all photos based on existing face/landmark data.
 */
export const recomputeAutoCrops = api(
  { expose: true, method: "POST", path: "/photos/recompute-auto-crops", auth: true },
  async (): Promise<{ updated: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.recomputeAllAutoCropsLogic(userId);
  }
);

// ========== Photo Groups ==========

import type {
  PhotoGroup,
  ListGroupsResponse,
  FindGroupsResponse,
} from "../db/types";
import {
  acceptAiPickLogic,
  acceptPeerConsensusLogic,
  bulkAcceptHighConfidencePicksLogic,
  exportCalibrationDatasetLogic,
  listReviewQueueLogic,
  recomputeAiPicksForAllUsers,
  type BulkAcceptResult,
  type CalibrationEntry,
  type PeerConsensusResult,
  type RecomputeResult,
  type ReviewQueueResponse,
} from "./group-auto-pick.service";

/**
 * Find similar photo groups using DINOv2 embeddings.
 */
export const findPhotoGroups = api(
  { expose: true, method: "POST", path: "/photos/find-groups", auth: true },
  async (): Promise<FindGroupsResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    // Serialize with any in-flight background regroup (e.g. triggered by a
    // recently added shared-album photo) so the manual call doesn't race
    // against it. The scheduler awaits the full pass (including any queued
    // follow-up) before resolving.
    await service.scheduleRegroup(userId);
    return await service.countUserGroupStats(userId);
  }
);

/**
 * List all photo groups for the current user.
 */
export const listPhotoGroups = api(
  { expose: true, method: "GET", path: "/photos/groups", auth: true },
  async (): Promise<ListGroupsResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.listPhotoGroupsLogic(userId);
  }
);

/**
 * Get the next unreviewed photo group.
 */
export const getNextUnreviewedGroup = api(
  { expose: true, method: "GET", path: "/photos/groups/next-unreviewed", auth: true },
  async (): Promise<{ group: PhotoGroup | null }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return { group: await service.getNextUnreviewedGroupLogic(userId) };
  }
);

/**
 * Mark a photo group as reviewed.
 */
export const reviewPhotoGroup = api(
  { expose: true, method: "POST", path: "/photos/groups/:id/review", auth: true },
  async ({ id, photoIds }: { id: number; photoIds?: number[] }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");
    return await service.reviewPhotoGroupLogic(userId, id, photoIds);
  }
);

/**
 * Backfill width/height on every photo on the server that does not
 * yet have them. Dimensions are a property of the file, not of the
 * owner — `data.manage` already gates this so admin scope is fine.
 * Needed once on existing libraries so the AI auto-pick orientation-
 * diversity rule can classify portrait/landscape; new photos get
 * dimensions for free via the face-scan path.
 */
export const backfillPhotoDimensions = api(
  { expose: true, method: "POST", path: "/photos/backfill-dimensions", auth: true },
  async (): Promise<{ scanned: number; updated: number; failed: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.backfillPhotoDimensionsLogic();
  }
);

// ========== AI Auto-Pick (Track I) ==========

/**
 * Force-recompute the AI suggested "best of group" pick for every
 * unreviewed group across all users. Normally this runs automatically
 * after `/photos/find-groups`; this endpoint exists so the maintenance
 * UI can re-trigger scoring server-wide without each user having to
 * click their own re-compute (e.g. after a backfill that newly
 * populated width/height for the orientation-diversity rule).
 */
export const recomputeAiPicks = api(
  { expose: true, method: "POST", path: "/photos/groups/recompute-ai-picks", auth: true },
  async (): Promise<RecomputeResult> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await recomputeAiPicksForAllUsers();
  }
);

/**
 * "Accept the KI suggestion for this group" — turns the AI pick into a
 * concrete user review. Non-picked members are hidden via the existing
 * photo_curation mechanism (skipping favorites). The group's
 * `reviewed_at` is set, removing it from the AI-hidden filter going
 * forward.
 */
export const acceptAiPick = api(
  { expose: true, method: "POST", path: "/photos/groups/:id/accept-ai-pick", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean; hidden_count: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");
    return await acceptAiPickLogic(userId, id);
  }
);

/**
 * Manual "keep these photos, hide the rest" review action. Used by the
 * One-Click-Pick UI in the review queue (Stufe C) when the user wants
 * to overrule the AI suggestion in a 2- or 3-photo group: a single tap
 * on a photo marks it as "the one I want to keep" and the rest get
 * hidden in the same atomic step that the regular accept-AI path uses.
 *
 * Behaves identically to /accept-ai-pick otherwise (favorites are
 * preserved; group is marked reviewed). Requires every supplied
 * photo_id to actually belong to the group — protects against UI
 * bugs that would otherwise hide every group member.
 */
export const pickPhotosInGroup = api(
  { expose: true, method: "POST", path: "/photos/groups/:id/pick-photos", auth: true },
  async ({ id, photoIds }: { id: number; photoIds: number[] }): Promise<{ success: boolean; hidden_count: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      throw APIError.invalidArgument("photoIds must be a non-empty array");
    }
    return await acceptAiPickLogic(userId, id, photoIds);
  }
);

/**
 * "Konsens übernehmen" — let the requester adopt the majority of their
 * album-peers' curation decisions for one similar-photo group. See
 * acceptPeerConsensusLogic for the consensus rule + privacy boundary.
 *
 * Same `photos.delete` permission as the AI-pick path: hiding a photo
 * is a destructive-feeling action even though the underlying file
 * stays on disk.
 */
export const acceptPeerConsensus = api(
  { expose: true, method: "POST", path: "/photos/groups/:id/accept-peer-consensus", auth: true },
  async ({ id }: { id: number }): Promise<PeerConsensusResult> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");
    return await acceptPeerConsensusLogic(userId, id);
  }
);

/**
 * Bulk-accept every unreviewed high-confidence AI pick. Used by the
 * "Alle hochkonfidenten KI-Picks bestätigen" admin button to make the
 * initial rollout against thousands of groups practical without manual
 * per-group clicks.
 */
export const bulkAcceptHighConfidenceAiPicks = api(
  { expose: true, method: "POST", path: "/photos/groups/bulk-accept-ai-picks", auth: true },
  async (): Promise<BulkAcceptResult> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await bulkAcceptHighConfidencePicksLogic(userId);
  }
);

/**
 * Calibration export. Returns every reviewed group's members alongside
 * the AI's pick, the user's keep/hide decision, and the per-photo
 * sub-signals — the dataset used to regress weights in Stufe D.
 */
export const exportAiPickCalibration = api(
  { expose: true, method: "GET", path: "/photos/groups/ai-pick-calibration", auth: true },
  async (): Promise<{ entries: CalibrationEntry[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await exportCalibrationDatasetLogic(userId);
  }
);

/**
 * Fit per-user scoring weights from the user's reviewed groups
 * (pairwise logistic regression — see
 * group-auto-pick.calibration.ts). Persists the result on
 * `ai_pick_user_weights`; next `recomputeAiPicks` pass will pick it
 * up automatically. Returns diagnostics so the UI can surface
 * "X % Übereinstimmung mit deinen Reviews".
 *
 * Requires at least `MIN_PAIRS_FOR_FIT` (10) kept-vs-hidden pairs in
 * each branch the user wants to calibrate; below that, defaults are
 * kept for the under-sampled branch.
 */
export const calibrateAiPickWeights = api(
  { expose: true, method: "POST", path: "/photos/groups/calibrate-ai-pick-weights", auth: true },
  async (): Promise<{
    weights: { face: number[]; non_face: number[] };
    metadata: {
      pair_count_face: number;
      pair_count_non_face: number;
      pair_count_skipped_mixed: number;
      top1_accuracy_face: number;
      top1_accuracy_non_face: number;
      top1_accuracy_face_baseline: number;
      top1_accuracy_non_face_baseline: number;
    };
  }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    const { calibrateAndPersist } = await import("./group-auto-pick.calibration");
    return await calibrateAndPersist(userId);
  }
);

/**
 * Paginated stream of the user's unreviewed similar-photo groups,
 * enriched with thumbnail filenames + per-photo AI-pick flags. Drives
 * the "Rapid Review" view (Track I Stufe A). Sorted high → medium →
 * low → no-pick so the user can blast through the easy decisions
 * first and tackle ambiguous ones at the end.
 */
export const listReviewQueue = api(
  { expose: true, method: "GET", path: "/photos/groups/review-queue", auth: true },
  async ({
    offset,
    limit,
    confidence,
  }: {
    offset?: Query<number>;
    limit?: Query<number>;
    confidence?: Query<string>;
  }): Promise<ReviewQueueResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    const conf =
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? (confidence as "high" | "medium" | "low")
        : undefined;
    return await listReviewQueueLogic(userId, {
      offset: typeof offset === "number" ? offset : undefined,
      limit: typeof limit === "number" ? limit : undefined,
      confidence: conf,
    });
  },
);

/**
 * Semantic photo search using natural language query via CLIP text embeddings.
 */
export const searchPhotos = api(
  { expose: true, method: "POST", path: "/photos/search", auth: true },
  async ({
    query,
    limit,
    threshold,
  }: {
    query: string;
    limit?: number;
    threshold?: number;
  }): Promise<{ photos: PhotoWithCuration[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchPhotosLogic(userId, query, limit ?? 500, threshold ?? 0.20);
  }
);

/**
 * Get a year/month timeline summary with counts and cover photos.
 * Used by the iOS app for hierarchical year → month → photos navigation.
 */
export const getPhotoTimeline = api(
  { expose: true, method: "GET", path: "/photos/timeline", auth: true },
  async (): Promise<service.PhotoTimelineResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.getPhotoTimelineLogic(userId);
  }
);

/**
 * Search photos by date range, year, or year+month.
 * Parameters: from, to (ISO 8601 strings), year, month, limit
 */
export const searchPhotosByDate = api(
  { expose: true, method: "GET", path: "/photos/search/date", auth: true },
  async ({
    from,
    to,
    year,
    month,
    limit,
  }: {
    from?: Query<string>;
    to?: Query<string>;
    year?: Query<number>;
    month?: Query<number>;
    limit?: Query<number>;
  }): Promise<{ photos: PhotoWithCuration[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchByDateRangeLogic(userId, { from, to, year, month, limit });
  }
);

/**
 * Search photos by location: city/country name or GPS coordinates with radius (km).
 */
export const searchPhotosByLocation = api(
  { expose: true, method: "GET", path: "/photos/search/location", auth: true },
  async ({
    city,
    country,
    lat,
    lon,
    radius,
    limit,
  }: {
    city?: Query<string>;
    country?: Query<string>;
    lat?: Query<number>;
    lon?: Query<number>;
    radius?: Query<number>;
    limit?: Query<number>;
  }): Promise<{ photos: PhotoWithCuration[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchByLocationLogic(userId, { city, country, lat, lon, radius, limit });
  }
);

/**
 * Search photos by landmark label (e.g. "kirche", "brücke", "eiffel").
 */
export const searchPhotosByLandmark = api(
  { expose: true, method: "POST", path: "/photos/search/landmarks", auth: true },
  async ({ query, limit }: { query: string; limit?: number }): Promise<{ results: service.LandmarkSearchResult[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchByLandmarkLogic(userId, query, limit ?? 500);
  }
);

/**
 * Get all detected landmarks for a specific photo.
 */
export const getPhotoLandmarks = api(
  { expose: true, method: "GET", path: "/photos/:id/landmarks", auth: true },
  async ({ id }: { id: number }): Promise<{ landmarks: service.LandmarkItem[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.getLandmarksForPhotoLogic(userId, id);
  }
);

/**
 * Trigger landmark re-detection for a specific photo.
 */
export const reindexPhotoLandmarks = api(
  { expose: true, method: "POST", path: "/photos/:id/index-landmarks", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.edit");
    await service.indexPhotoLandmarks(id);
    return { success: true };
  }
);

// ========== Destructive: Purge All Photos ==========

/**
 * Purge ALL photo-related data across the installation. Intentionally
 * separate from `photos.delete` — requires the standalone `photos.purge`
 * permission that Admins do NOT receive by default.
 *
 * When `deleteFiles` is true, the original uploads and all cached thumbnails
 * are removed from disk as well. When false, only the database rows (including
 * embeddings, albums, faces, persons, scan queue, …) are cleared so the files
 * are kept but become orphaned.
 */
export const purgePhotos = api(
  { expose: true, method: "POST", path: "/photos/purge", auth: true },
  async ({ deleteFiles }: { deleteFiles: boolean }): Promise<service.PurgeResult> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "photos.purge");
    return await service.purgeAllPhotosLogic(!!deleteFiles);
  }
);

/**
 * Combined natural language photo search.
 * Parses German queries like "Kirchen in München von 2004 bis 2017" into:
 *   - a semantic CLIP query ("Kirchen")
 *   - a location filter ("München")
 *   - a date range filter (2004-01-01 – 2017-12-31)
 * Returns results and the parsed query components for transparency.
 */
export const searchPhotosNatural = api(
  { expose: true, method: "POST", path: "/photos/search/natural", auth: true },
  async ({
    query,
    limit,
    threshold,
  }: {
    query: string;
    limit?: number;
    threshold?: number;
  }): Promise<{ results: service.NaturalSearchResult[]; parsed: service.ParsedQuery }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchPhotosNaturalLogic(userId, query, limit ?? 500, threshold ?? 0.18);
  }
);
