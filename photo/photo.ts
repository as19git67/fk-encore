import fs from "fs";
import path from "path";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as service from "./photo.service";
import { UPLOAD_DIR, THUMBNAIL_DIR, thumbnailShardPath } from "./photo.service";
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
 * Serve a photo file.
 */
export const getPhotoFile = api.raw(
  { expose: true, method: "GET", path: "/photos/file/:filename", auth: false },
  async (req, res) => {
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const filename = path.basename(url.pathname);
      console.log("Serving photo file:", filename);
      
      const filePath = path.resolve(UPLOAD_DIR, filename);

      if (!fs.existsSync(filePath)) {
        console.error("File not found:", filePath);
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
              const baseName = path.basename(filename, path.extname(filename));
              const cacheFile = needsResize
                ? `${baseName}_${targetWidth}w.jpg`
                : `${baseName}_converted.jpg`;
              const shardPath = thumbnailShardPath(baseName);
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
  async ({ id }: { id: number }): Promise<AlbumPublicLink> => {
    checkModule();
    const userId = getUserId();
    return await service.createAlbumPublicLinkLogic(userId, id);
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

import { getAllServiceHealthStatuses, type ServiceHealthStatus } from "./service-health";

export const getExternalServiceHealth = api(
  { expose: true, method: "GET", path: "/photos/service-health", auth: true },
  async (): Promise<{ services: ServiceHealthStatus[] }> => {
    checkModule();
    return { services: getAllServiceHealthStatuses() };
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
    return await service.findPhotoGroupsLogic(userId);
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
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.delete");
    return await service.reviewPhotoGroupLogic(userId, id);
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
  }): Promise<{ results: service.PhotoSearchResult[] }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    return await service.searchPhotosLogic(userId, query, limit ?? 20, threshold ?? 0.20);
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
    return await service.searchByLandmarkLogic(userId, query, limit ?? 50);
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
    await service.indexPhotoLandmarks(userId, id);
    return { success: true };
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
    return await service.searchPhotosNaturalLogic(userId, query, limit ?? 30, threshold ?? 0.18);
  }
);
