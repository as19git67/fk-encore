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
} from "../db/types";

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
      console.error("Upload error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message || "Internal Server Error" }));
    }
  }
);

/**
 * List all photos owned by the user.
 */
export const listPhotos = api(
  { expose: true, method: "GET", path: "/photos", auth: true },
  async (): Promise<ListPhotosResponse> => {
    checkModule();
    const userId = getUserId();
    const authData = getAuthData()!;
    requirePermission(authData, "photos.view");
    
    return service.listPhotosLogic(userId);
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
    return service.deletePhotoLogic(userId, id);
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

      res.setHeader("Content-Type", mimeType);
      fs.createReadStream(filePath).pipe(res);
    } catch (err: any) {
      console.error("Error serving photo file:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
);

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
    
    return service.createAlbumLogic(userId, req);
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
    return service.listAlbumsLogic(userId);
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
    return service.getAlbumLogic(userId, id);
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
    return service.updateAlbumLogic(userId, req);
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
    return service.deleteAlbumLogic(userId, id);
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
    return service.addPhotoToAlbumLogic(userId, req);
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
    return service.shareAlbumLogic(userId, req);
  }
);
