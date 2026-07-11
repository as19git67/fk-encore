/**
 * Utility meters — quick reading-entry configuration.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as quickEntry from "./quick-entry.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export const getQuickEntry = api(
  { expose: true, method: "GET", path: "/meters/quick-entry", auth: true },
  async (): Promise<quickEntry.QuickEntryConfig> => {
    const userId = requireUser("meters.read_entry");
    return await quickEntry.getQuickEntryConfig(userId);
  },
);

export const saveQuickEntry = api(
  { expose: true, method: "PUT", path: "/meters/quick-entry", auth: true },
  async ({ meterIds }: { meterIds: number[] }): Promise<quickEntry.QuickEntryConfig> => {
    const userId = requireUser("meters.read_entry");
    return await quickEntry.saveQuickEntryConfig(userId, Array.isArray(meterIds) ? meterIds : []);
  },
);
