/**
 * Utility meters module — HTTP endpoints (Issue #792, Etappe 1).
 *
 *   GET /meters → list all meters visible to the caller, with the active
 *                 device, latest reading and the absolute total.
 *
 * Requires `meters.view`. CRUD (`meters.manage`), readings, OCR, API
 * ingestion, reports and the finance link follow in later stages — see
 * docs/utility-meters.md.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import * as svc from "./meter.service";

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
