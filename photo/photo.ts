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
  ListPhotoIndexResponse,
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

    const fileName = (req.headers["x-file-name"] as string) || "photo.jpg";
    const mimeType = (req.headers["content-type"] as string) || "image/jpeg";

    try {
      const photo = await service.uploadPhotoStream(userId, req, fileName, mimeType);

      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(photo));
    } catch (err: any) {
      if (err.message === "PHOTO_ALREADY_EXISTS") {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Duplicate photo", message: "Foto wurde bereits hochgeladen." }));
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
  async ({ showHidden }: { showHidden?: Query<boolean> }): Promise<ListPhotosResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");

    return await service.listPhotosLogic(userId, showHidden ?? false);
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
 */
export const listPhotoIndex = api(
  { expose: true, method: "GET", path: "/photos/index", auth: true },
  async ({ showHidden }: { showHidden?: Query<boolean> }): Promise<ListPhotoIndexResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");

    return await service.listPhotoIndexLogic(userId, showHidden ?? false);
  }
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
    return fs.existsSync(abs) ? abs : null;
  }

  const filePath = path.resolve(UPLOAD_DIR, filename);
  const uploadDirWithSep = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (filePath !== UPLOAD_DIR && !filePath.startsWith(uploadDirWithSep)) {
    return null;
  }
  return fs.existsSync(filePath) ? filePath : null;
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

              if (fs.existsSync(cachePath)) {
                  res.setHeader("Content-Type", "image/jpeg");
                  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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
              res.end(buffer);
              return;
          } catch (err) {
              console.error("Error processing image:", err);
              // Fallback to original below
          }
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      fs.createReadStream(filePath).pipe(res);
    } catch (err: any) {
      console.error("Error serving photo file:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
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
  async (): Promise<ListPersonsResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "people.view");
    return await service.listPersonsLogic(userId);
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
