/**
 * Utility meters — electricity tariff management.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  createElectricityTariff,
  deleteElectricityTariff,
  importTariffEntries,
  listElectricityTariffs,
  updateElectricityTariff,
  type ElectricityTariff,
  type TariffImportEntry,
  type TariffImportResult,
  type UpsertElectricityTariffInput,
} from "./tariffs.service";
import { resolveSettingsScope } from "./household.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

interface ListTariffsResponse {
  tariffs: ElectricityTariff[];
  /** Whose tariffs these are: the household's (#1647) or the caller's own. */
  scope: { kind: "personal" | "household"; householdName: string | null };
}

export const listTariffs = api(
  { expose: true, method: "GET", path: "/meters/tariffs/electricity", auth: true },
  async (): Promise<ListTariffsResponse> => {
    const userId = requireUser("meters.view");
    const scope = await resolveSettingsScope(userId);
    return {
      tariffs: await listElectricityTariffs(userId),
      scope: {
        kind: scope.kind,
        householdName: scope.kind === "household" ? scope.groupName : null,
      },
    };
  },
);

export const createTariff = api(
  { expose: true, method: "POST", path: "/meters/tariffs/electricity", auth: true },
  async (req: UpsertElectricityTariffInput): Promise<ElectricityTariff> => {
    const userId = requireUser("meters.manage");
    return await createElectricityTariff(userId, req);
  },
);

interface UpdateTariffRequest extends UpsertElectricityTariffInput {
  id: number;
}

export const updateTariff = api(
  { expose: true, method: "PUT", path: "/meters/tariffs/electricity/:id", auth: true },
  async ({ id, ...req }: UpdateTariffRequest): Promise<ElectricityTariff> => {
    const userId = requireUser("meters.manage");
    return await updateElectricityTariff(userId, id, req);
  },
);

export const deleteTariff = api(
  { expose: true, method: "DELETE", path: "/meters/tariffs/electricity/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const userId = requireUser("meters.manage");
    await deleteElectricityTariff(userId, id);
    return { deleted: true };
  },
);

interface ImportTariffsRequest {
  entries: TariffImportEntry[];
}

/**
 * Bulk import of tariffs and assumptions from a file, for historical series
 * (petrol prices, gas prices, …) that are impractical to type row by row.
 */
export const importTariffs = api(
  { expose: true, method: "POST", path: "/meters/tariffs/import", auth: true },
  async (req: ImportTariffsRequest): Promise<TariffImportResult> => {
    const userId = requireUser("meters.manage");
    return await importTariffEntries(userId, req.entries);
  },
);
