/**
 * Utility meters — API key management endpoints (Etappe 5).
 *
 *   GET    /meters/:id/api-keys      list keys for a meter (meters.manage)
 *   POST   /meters/:id/api-keys      create key (meters.manage) — token shown once
 *   DELETE /meters/api-keys/:keyId   delete key  (meters.manage)
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./api-keys.service";

function requireManageUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "meters.manage");
  return parseInt(auth.userID, 10);
}

interface ListApiKeysResponse {
  keys: svc.ApiKeyDto[];
}

export const listApiKeys = api(
  { expose: true, method: "GET", path: "/meters/:id/api-keys", auth: true },
  async ({ id }: { id: number }): Promise<ListApiKeysResponse> => {
    const userId = requireManageUser();
    return { keys: await svc.listApiKeys(userId, id) };
  },
);

interface CreateApiKeyRequest {
  id: number;
  name: string;
}

export const createApiKey = api(
  { expose: true, method: "POST", path: "/meters/:id/api-keys", auth: true },
  async ({ id, name }: CreateApiKeyRequest): Promise<svc.CreateApiKeyResult> => {
    const userId = requireManageUser();
    return await svc.createApiKey(userId, id, name);
  },
);

export const deleteApiKey = api(
  { expose: true, method: "DELETE", path: "/meters/api-keys/:keyId", auth: true },
  async ({ keyId }: { keyId: number }): Promise<{ deleted: boolean }> => {
    const userId = requireManageUser();
    await svc.deleteApiKey(userId, keyId);
    return { deleted: true };
  },
);
