/**
 * Utility meters — electricity tariff management.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  createElectricityTariff,
  deleteElectricityTariff,
  importElectricityPrices,
  listElectricityTariffs,
  updateElectricityTariff,
  type ElectricityPriceImportResult,
  type ElectricityTariff,
  type UpsertElectricityTariffInput,
} from "./tariffs.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

interface ListTariffsResponse {
  tariffs: ElectricityTariff[];
}

export const listTariffs = api(
  { expose: true, method: "GET", path: "/meters/tariffs/electricity", auth: true },
  async (): Promise<ListTariffsResponse> => {
    const userId = requireUser("meters.view");
    return { tariffs: await listElectricityTariffs(userId) };
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

export const importElecPrices = api(
  { expose: true, method: "POST", path: "/meters/import/electricity-prices", auth: true },
  async (): Promise<ElectricityPriceImportResult> => {
    const userId = requireUser("meters.manage");
    return await importElectricityPrices(userId);
  },
);
