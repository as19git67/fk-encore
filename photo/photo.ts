import fs from "fs";
import path from "path";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as service from "./photo.service";
import { UPLOAD_DIR } from "./photo.service";
import type {
  Album,
  AlbumWithPhotos,
  CreateAlbumRequest,
  UpdateAlbumRequest,
  AddPhotoToAlbumRequest,
  ShareAlbumRequest,
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
    requirePermission(authData, "photos.delete");
    return await service.updatePhotoCurationLogic(userId, id, status);
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

      if ((ext === ".heic" || ext === ".heif") && shouldConvert) {
          try {
              const jpegBuffer = await service.convertHeicToJpeg(filePath);
              res.setHeader("Content-Type", "image/jpeg");
              res.end(jpegBuffer);
              return;
          } catch (err) {
              console.error("Error converting HEIC on-the-fly:", err);
              // Fallback to original
          }
      }

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      
      if (widthStr && ENABLE_LOCAL_FACES) {
          // Implement simple thumbnail resizing if canvas is available
          // For now just serve original to keep it simple, but we could add it here
      }
      
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

/**
 * Reindex all photos (background job).
 */
export const reindexAllPhotos = api(
  { expose: true, method: "POST", path: "/photos/reindex-all", auth: true },
  async (): Promise<{ count: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.reindexAllPhotosLogic(userId);
  }
);

/**
 * Get reindex progress for the current user.
 */
export const getReindexStatus = api(
  { expose: true, method: "GET", path: "/photos/reindex-status", auth: true },
  async (): Promise<{ inProgress: boolean; total: number; processed: number; errors: number }> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    return await service.getReindexStatusForUser(userId);
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
