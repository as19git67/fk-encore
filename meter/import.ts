/**
 * One-off import endpoint for the historical water meter (Issue #792).
 *
 *   POST /meters/import/water-history  → create the "Wasser" meter with its
 *   four devices (three swaps) and 222 readings from the embedded spreadsheet
 *   export. Requires `meters.manage`. Idempotent — a second call returns the
 *   existing meter without writing anything.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { importWaterMeterHistory, type WaterImportResult } from "./import-water-history";
import { waterHistoryData } from "./import/water-history-data";

export const importWaterHistory = api(
  { expose: true, method: "POST", path: "/meters/import/water-history", auth: true },
  async (): Promise<WaterImportResult> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "meters.manage");
    const userId = parseInt(auth.userID, 10);

    return await importWaterMeterHistory(userId, waterHistoryData);
  },
);
