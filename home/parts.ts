/**
 * Haus › Ersatzteile endpoints (documentation/plans/haus-anlagen.md, stage 3).
 *
 *   GET    /home/parts                 catalog (q, empty, systemId)          home.view
 *   POST   /home/parts                 new part                               home.manage
 *   GET    /home/parts/:id             detail with systems, items, photos     home.view
 *   PATCH  /home/parts/:id             data, stock, sharing                   home.manage
 *   POST   /home/parts/:id/stock       take out / put back (delta)            home.manage
 *   DELETE /home/parts/:id                                                    home.manage
 *   PUT    /home/systems/:id/parts     which parts fit a system               home.manage
 *
 * The photo upload of a part is in media.ts. Who may change what is decided
 * in parts.service.ts.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  adjustStock,
  createPart,
  deletePart,
  getPartDetail,
  listParts,
  updatePart,
  type HomePartDetail,
  type HomePartListItem,
} from "./parts.service";
import { setSystemParts } from "./systems.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

interface ListPartsRequest {
  q?: Query<string>;
  /** Only parts with none left. */
  empty?: Query<boolean>;
  systemId?: Query<number>;
}

export const listHomeParts = api(
  { expose: true, method: "GET", path: "/home/parts", auth: true },
  async (req: ListPartsRequest): Promise<{ parts: HomePartListItem[] }> => {
    const userId = requireUser("home.view");
    return { parts: await listParts(userId, { q: req.q, empty: req.empty ?? false, systemId: req.systemId }) };
  },
);

interface PartFields {
  name: string;
  manufacturer?: string | null;
  partNumber?: string | null;
  ean?: string | null;
  specification?: string | null;
  supplierUrl?: string | null;
  storageLocation?: string | null;
  /** null = not counted. */
  stock?: number | null;
  notes?: string | null;
  /** Omitted: the caller's household; null: private. */
  groupId?: number | null;
}

export const createHomePart = api(
  { expose: true, method: "POST", path: "/home/parts", auth: true },
  async (req: PartFields): Promise<{ id: number }> => {
    const userId = requireUser("home.manage");
    return await createPart(userId, req);
  },
);

export const getHomePart = api(
  { expose: true, method: "GET", path: "/home/parts/:id", auth: true },
  async ({ id }: { id: number }): Promise<HomePartDetail> => {
    const userId = requireUser("home.view");
    return await getPartDetail(userId, id);
  },
);

interface UpdatePartRequest {
  id: number;
  name?: string;
  manufacturer?: string | null;
  partNumber?: string | null;
  ean?: string | null;
  specification?: string | null;
  supplierUrl?: string | null;
  storageLocation?: string | null;
  stock?: number | null;
  notes?: string | null;
  groupId?: number | null;
}

export const updateHomePart = api(
  { expose: true, method: "PATCH", path: "/home/parts/:id", auth: true },
  async ({ id, ...patch }: UpdatePartRequest): Promise<HomePartDetail> => {
    const userId = requireUser("home.manage");
    await updatePart(userId, id, patch);
    return await getPartDetail(userId, id);
  },
);

interface StockRequest {
  id: number;
  /** -1 = one taken out, +5 = five put back. */
  delta: number;
}

export const adjustHomePartStock = api(
  { expose: true, method: "POST", path: "/home/parts/:id/stock", auth: true },
  async ({ id, delta }: StockRequest): Promise<{ stock: number }> => {
    const userId = requireUser("home.manage");
    return { stock: await adjustStock(userId, id, delta) };
  },
);

export const deleteHomePart = api(
  { expose: true, method: "DELETE", path: "/home/parts/:id", auth: true },
  async ({ id }: { id: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deletePart(userId, id);
  },
);

interface SystemPartsRequest {
  id: number;
  partIds: number[];
}

export const setHomeSystemParts = api(
  { expose: true, method: "PUT", path: "/home/systems/:id/parts", auth: true },
  async ({ id, partIds }: SystemPartsRequest): Promise<void> => {
    const userId = requireUser("home.manage");
    await setSystemParts(userId, id, partIds);
  },
);
