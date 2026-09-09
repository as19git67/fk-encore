import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import type { ClimateNormal } from "./weather-client";
import { climateNormalFor } from "./weather-service";

export interface ClimateNormalRequest {
  anchor: { lat: number; lon: number };
  month: number;
}

export const climateNormal = api(
  { expose: true, method: "POST", path: "/trip-planner/climate-normal", auth: true },
  async (req: ClimateNormalRequest): Promise<ClimateNormal> => {
    requireUser();
    if (!req.anchor || !Number.isFinite(req.anchor.lat) || !Number.isFinite(req.anchor.lon)
      || req.anchor.lat < -90 || req.anchor.lat > 90 || req.anchor.lon < -180 || req.anchor.lon > 180) {
      throw APIError.invalidArgument("anchor is outside the valid coordinate range");
    }
    if (!Number.isInteger(req.month) || req.month < 1 || req.month > 12) {
      throw APIError.invalidArgument("month must be between 1 and 12");
    }
    try {
      return await climateNormalFor(req.anchor, req.month);
    } catch (error) {
      throw APIError.unavailable(error instanceof Error ? error.message : "climate normal unavailable");
    }
  },
);

function requireUser(): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, "photos.view");
  return parseInt(auth.userID, 10);
}
