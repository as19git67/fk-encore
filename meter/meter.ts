/**
 * Utility meters module — HTTP endpoints (Issue #792, Etappe 1–2).
 *
 *   GET    /meters                     list (meters.view)
 *   GET    /meters/:id                 detail + device history (meters.view)
 *   POST   /meters                     create meter + initial device (meters.manage)
 *   PUT    /meters/:id                 update master data (meters.manage)
 *   DELETE /meters/:id                 delete meter (meters.manage)
 *   POST   /meters/:id/replace-device  atomic device swap (meters.manage)
 *
 * Readings, OCR, API ingestion, reports and the finance link follow in
 * later stages — see docs/utility-meters.md.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./meter.service";
import type { MeterType } from "../db/schema";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

interface ListMetersResponse {
  meters: svc.MeterListItem[];
}

export const listMeters = api(
  { expose: true, method: "GET", path: "/meters", auth: true },
  async (): Promise<ListMetersResponse> => {
    const userId = requireUser("meters.view");
    return { meters: await svc.listMeters(userId) };
  },
);

export const getMeter = api(
  { expose: true, method: "GET", path: "/meters/:id", auth: true },
  async ({ id }: { id: number }): Promise<svc.MeterDetail> => {
    const userId = requireUser("meters.view");
    return await svc.getMeterDetail(userId, id);
  },
);

interface CreateMeterRequest {
  name: string;
  type: MeterType;
  unit: string;
  location?: string;
  notes?: string;
  decimals?: number;
  groupId?: number | null;
  device: svc.InitialDeviceInput;
}

interface CreateMeterResponse {
  id: number;
}

export const createMeter = api(
  { expose: true, method: "POST", path: "/meters", auth: true },
  async (req: CreateMeterRequest): Promise<CreateMeterResponse> => {
    const userId = requireUser("meters.manage");
    return await svc.createMeter(userId, req);
  },
);

interface UpdateMeterRequest {
  id: number;
  name: string;
  type: MeterType;
  unit: string;
  location?: string;
  notes?: string;
  decimals?: number;
  groupId?: number | null;
}

export const updateMeter = api(
  { expose: true, method: "PUT", path: "/meters/:id", auth: true },
  async ({ id, ...rest }: UpdateMeterRequest): Promise<svc.MeterDetail> => {
    const userId = requireUser("meters.manage");
    await svc.updateMeter(userId, id, rest);
    return await svc.getMeterDetail(userId, id);
  },
);

interface DeleteMeterResponse {
  deleted: boolean;
}

export const deleteMeter = api(
  { expose: true, method: "DELETE", path: "/meters/:id", auth: true },
  async ({ id }: { id: number }): Promise<DeleteMeterResponse> => {
    const userId = requireUser("meters.manage");
    await svc.deleteMeter(userId, id);
    return { deleted: true };
  },
);

interface ReplaceDeviceRequest {
  id: number;
  swapAt: string;
  finalValue: number;
  newSerialNumber?: string;
  newStartValue?: number;
}

interface ReplaceDeviceResponse {
  newDeviceId: number;
}

export const replaceDevice = api(
  { expose: true, method: "POST", path: "/meters/:id/replace-device", auth: true },
  async ({ id, ...rest }: ReplaceDeviceRequest): Promise<ReplaceDeviceResponse> => {
    const userId = requireUser("meters.manage");
    return await svc.replaceDevice(userId, id, rest);
  },
);
