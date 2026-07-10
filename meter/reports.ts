/**
 * Utility meters — report endpoints (Issue #792, Etappe 6).
 */

import { api, APIError } from "encore.dev/api";
import type { Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import {
  getEnergyReportForUser,
  getMeterReportForUser,
  parseReportBoundary,
  type EnergyReport,
  type MeterReport,
  type ReportGranularity,
} from "./reports.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

interface GetMeterReportRequest {
  id: number;
  granularity?: Query<ReportGranularity>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getMeterReport = api(
  { expose: true, method: "GET", path: "/meters/:id/report", auth: true },
  async ({ id, granularity, from, to }: GetMeterReportRequest): Promise<MeterReport> => {
    const userId = requireUser("meters.view");
    const resolvedGranularity = granularity ?? "month";
    if (resolvedGranularity !== "month" && resolvedGranularity !== "year") {
      throw APIError.invalidArgument("granularity must be 'month' or 'year'");
    }

    return await getMeterReportForUser(
      userId,
      id,
      resolvedGranularity,
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

interface GetEnergyReportRequest {
  granularity?: Query<ReportGranularity>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getEnergyReport = api(
  { expose: true, method: "GET", path: "/meters/reports/energy", auth: true },
  async ({ granularity, from, to }: GetEnergyReportRequest): Promise<EnergyReport> => {
    const userId = requireUser("meters.view");
    const resolvedGranularity = granularity ?? "month";
    if (resolvedGranularity !== "month" && resolvedGranularity !== "year") {
      throw APIError.invalidArgument("granularity must be 'month' or 'year'");
    }

    return await getEnergyReportForUser(
      userId,
      resolvedGranularity,
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);
