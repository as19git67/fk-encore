/**
 * Utility meters — reading endpoints (Issue #792, Etappe 3).
 *
 *   GET    /meters/:id/readings        history + absolute column (meters.view)
 *   POST   /meters/:id/readings        manual entry            (meters.read_entry)
 *   PUT    /meters/readings/:readingId edit                    (read_entry own / manage foreign)
 *   DELETE /meters/readings/:readingId delete                  (read_entry own / manage foreign)
 */

import { api, APIError } from "encore.dev/api";
import type { Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as readings from "./readings.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

/** For edit/delete: caller id plus whether they hold meters.manage. */
function requireEntryUser(): { userId: number; hasManage: boolean } {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "meters.read_entry");
  return {
    userId: parseInt(auth.userID, 10),
    hasManage: auth.permissions.includes("meters.manage"),
  };
}

interface ListReadingsRequest {
  id: number;
  limit?: Query<number>;
  offset?: Query<number>;
}

interface ListReadingsResponse {
  readings: readings.ReadingDto[];
  total: number;
}

export const listReadings = api(
  { expose: true, method: "GET", path: "/meters/:id/readings", auth: true },
  async ({ id, limit, offset }: ListReadingsRequest): Promise<ListReadingsResponse> => {
    const userId = requireUser("meters.view");
    return await readings.listReadings(userId, id, limit ?? 100, offset ?? 0);
  },
);

interface AddReadingRequest {
  id: number;
  value: number;
  takenAt?: string;
  notes?: string;
}

export const addReading = api(
  { expose: true, method: "POST", path: "/meters/:id/readings", auth: true },
  async ({ id, value, takenAt, notes }: AddReadingRequest): Promise<{ id: number }> => {
    const userId = requireUser("meters.read_entry");
    return await readings.addReading(userId, id, { value, takenAt, notes });
  },
);

interface UpdateReadingRequest {
  readingId: number;
  value: number;
  takenAt: string;
  notes?: string;
}

export const updateReading = api(
  { expose: true, method: "PUT", path: "/meters/readings/:readingId", auth: true },
  async ({ readingId, value, takenAt, notes }: UpdateReadingRequest): Promise<{ updated: boolean }> => {
    const { userId, hasManage } = requireEntryUser();
    await readings.updateReading(userId, hasManage, readingId, { value, takenAt, notes });
    return { updated: true };
  },
);

export const deleteReading = api(
  { expose: true, method: "DELETE", path: "/meters/readings/:readingId", auth: true },
  async ({ readingId }: { readingId: number }): Promise<{ deleted: boolean }> => {
    const { userId, hasManage } = requireEntryUser();
    await readings.deleteReading(userId, hasManage, readingId);
    return { deleted: true };
  },
);
