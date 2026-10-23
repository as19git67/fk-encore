/**
 * Utility meters shared with the household (#1647).
 *
 *   GET  /meters/household          household, candidate groups, private meters (meters.view)
 *   PUT  /meters/household          mark a group as household, or null to stop (meters.manage)
 *   POST /meters/household/share    share all of the caller's private meters (meters.manage)
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  getHouseholdState,
  setHousehold,
  shareMetersWithHousehold,
  type HouseholdState,
} from "./household.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

export const getMeterHousehold = api(
  { expose: true, method: "GET", path: "/meters/household", auth: true },
  async (): Promise<HouseholdState> => {
    const userId = requireUser("meters.view");
    return await getHouseholdState(userId);
  },
);

interface SetHouseholdRequest {
  groupId: number | null;
}

export const putMeterHousehold = api(
  { expose: true, method: "PUT", path: "/meters/household", auth: true },
  async ({ groupId }: SetHouseholdRequest): Promise<HouseholdState> => {
    const userId = requireUser("meters.manage");
    return await setHousehold(userId, groupId);
  },
);

export const shareMetersWithMyHousehold = api(
  { expose: true, method: "POST", path: "/meters/household/share", auth: true },
  async (): Promise<{ shared: number }> => {
    const userId = requireUser("meters.manage");
    return await shareMetersWithHousehold(userId);
  },
);
