/**
 * One-off import endpoints for historical meter data (Issue #792).
 *
 *   POST /meters/import/water-history        → "Wasser" meter (4 devices, 222 readings)
 *   POST /meters/import/electricity-history   → 17 meters (electricity + operating hours, ~2 000 readings)
 *
 * Both require `meters.manage` and are idempotent.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { importWaterMeterHistory, type WaterImportResult } from "./import-water-history";
import { waterHistoryData } from "./import/water-history-data";
import { importElectricityHistory, type ElecImportResult } from "./import-electricity-history";
import { electricityHistoryData } from "./import/electricity-history-data";

function requireManageUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "meters.manage");
  return parseInt(auth.userID, 10);
}

export const importWaterHistory = api(
  { expose: true, method: "POST", path: "/meters/import/water-history", auth: true },
  async (): Promise<WaterImportResult> => {
    const userId = requireManageUser();
    return await importWaterMeterHistory(userId, waterHistoryData);
  },
);

export const importElecHistory = api(
  { expose: true, method: "POST", path: "/meters/import/electricity-history", auth: true },
  async (): Promise<ElecImportResult> => {
    const userId = requireManageUser();
    return await importElectricityHistory(userId, electricityHistoryData);
  },
);
