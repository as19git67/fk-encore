/**
 * External photo library API endpoints (issue #75).
 *
 * All endpoints require the `photos.libraries.manage` permission. The user who
 * registers a library becomes the owner of every photo imported from it.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as libs from "./libraries.service";
import type {
  PhotoLibrary,
  CreateLibraryRequest,
  UpdateLibraryRequest,
  ScanReport,
  AvailableDirectory,
} from "./libraries.service";
import { startWatcher, stopWatcher } from "./library-watcher";

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID);
}

function checkPermission(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "photos.libraries.manage");
}

function toApiError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  throw APIError.invalidArgument(msg);
}

export const createLibrary = api(
  { expose: true, method: "POST", path: "/libraries", auth: true },
  async (req: CreateLibraryRequest): Promise<PhotoLibrary> => {
    checkPermission();
    const userId = getUserId();
    try {
      const lib = await libs.createLibrary(userId, req);
      if (lib.auto_import) await startWatcher(lib);
      return lib;
    } catch (err) {
      toApiError(err);
    }
  }
);

export const listLibraries = api(
  { expose: true, method: "GET", path: "/libraries", auth: true },
  async (): Promise<{ libraries: PhotoLibrary[] }> => {
    checkPermission();
    return { libraries: await libs.listLibraries() };
  }
);

export const listAvailablePaths = api(
  { expose: true, method: "GET", path: "/libraries/available-paths", auth: true },
  async (): Promise<{ root: string; directories: AvailableDirectory[] }> => {
    checkPermission();
    return {
      root: libs.PHOTO_LIBRARIES_ROOT,
      directories: await libs.listAvailableDirectories(),
    };
  }
);

export const getLibrary = api(
  { expose: true, method: "GET", path: "/libraries/:id", auth: true },
  async ({ id }: { id: number }): Promise<PhotoLibrary> => {
    checkPermission();
    const lib = await libs.getLibrary(id);
    if (!lib) throw APIError.notFound(`library ${id} not found`);
    return lib;
  }
);

export const updateLibrary = api(
  { expose: true, method: "PATCH", path: "/libraries/:id", auth: true },
  async (req: UpdateLibraryRequest): Promise<PhotoLibrary> => {
    checkPermission();
    try {
      const lib = await libs.updateLibrary(req);
      // Re-sync the watcher to reflect the new auto_import setting.
      await stopWatcher(lib.id);
      if (lib.auto_import) await startWatcher(lib);
      return lib;
    } catch (err) {
      toApiError(err);
    }
  }
);

export const deleteLibrary = api(
  { expose: true, method: "DELETE", path: "/libraries/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkPermission();
    await stopWatcher(id);
    await libs.deleteLibrary(id);
    return { success: true };
  }
);

export const scanLibrary = api(
  { expose: true, method: "POST", path: "/libraries/:id/scan", auth: true },
  async ({ id }: { id: number }): Promise<ScanReport> => {
    checkPermission();
    try {
      return await libs.scanLibrary(id);
    } catch (err) {
      toApiError(err);
    }
  }
);

export const reconcileLibrary = api(
  { expose: true, method: "POST", path: "/libraries/:id/reconcile", auth: true },
  async ({ id }: { id: number }): Promise<{ removed: number }> => {
    checkPermission();
    try {
      return await libs.reconcileLibrary(id);
    } catch (err) {
      toApiError(err);
    }
  }
);
