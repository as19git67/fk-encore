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
  type BucketAllocation,
  type EnergyReport,
  type MeterReport,
  type ReportGranularity,
} from "./reports.service";
import {
  getConsumptionTrendsForUser,
  type ConsumptionTrendsReport,
} from "./trends.service";
import {
  getEconomicsReportForUser,
  type EconomicsReport,
} from "./economics.service";
import {
  getComparisonsReportForUser,
  type ComparisonsReport,
} from "./comparisons.service";
import {
  getEquipmentReportForUser,
  type EquipmentReport,
} from "./equipment.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

function parseGranularity(value: ReportGranularity | undefined): ReportGranularity {
  const granularity = value ?? "month";
  if (granularity !== "month" && granularity !== "year") {
    throw APIError.invalidArgument("granularity must be 'month' or 'year'");
  }
  return granularity;
}

function parseAllocation(value: BucketAllocation | undefined): BucketAllocation {
  const allocation = value ?? "interpolated";
  if (allocation !== "interpolated" && allocation !== "interval_start") {
    throw APIError.invalidArgument("allocation must be 'interpolated' or 'interval_start'");
  }
  return allocation;
}

interface GetMeterReportRequest {
  id: number;
  granularity?: Query<ReportGranularity>;
  allocation?: Query<BucketAllocation>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getMeterReport = api(
  { expose: true, method: "GET", path: "/meters/:id/report", auth: true },
  async ({ id, granularity, allocation, from, to }: GetMeterReportRequest): Promise<MeterReport> => {
    const userId = requireUser("meters.view");

    return await getMeterReportForUser(
      userId,
      id,
      parseGranularity(granularity),
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
      parseAllocation(allocation),
    );
  },
);

interface GetEquipmentReportRequest {
  granularity?: Query<ReportGranularity>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getEquipmentReport = api(
  { expose: true, method: "GET", path: "/meters/reports/equipment", auth: true },
  async ({ granularity, from, to }: GetEquipmentReportRequest): Promise<EquipmentReport> => {
    const userId = requireUser("meters.view");

    return await getEquipmentReportForUser(
      userId,
      parseGranularity(granularity),
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

interface GetComparisonsReportRequest {
  granularity?: Query<ReportGranularity>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getComparisonsReport = api(
  { expose: true, method: "GET", path: "/meters/reports/comparisons", auth: true },
  async ({ granularity, from, to }: GetComparisonsReportRequest): Promise<ComparisonsReport> => {
    const userId = requireUser("meters.view");

    return await getComparisonsReportForUser(
      userId,
      parseGranularity(granularity),
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

interface GetEconomicsReportRequest {
  granularity?: Query<ReportGranularity>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getEconomicsReport = api(
  { expose: true, method: "GET", path: "/meters/reports/economics", auth: true },
  async ({ granularity, from, to }: GetEconomicsReportRequest): Promise<EconomicsReport> => {
    const userId = requireUser("meters.view");

    return await getEconomicsReportForUser(
      userId,
      parseGranularity(granularity),
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

export const getConsumptionTrends = api(
  { expose: true, method: "GET", path: "/meters/reports/trends", auth: true },
  async (): Promise<ConsumptionTrendsReport> => {
    const userId = requireUser("meters.view");
    return await getConsumptionTrendsForUser(userId);
  },
);

interface GetEnergyReportRequest {
  granularity?: Query<ReportGranularity>;
  allocation?: Query<BucketAllocation>;
  from?: Query<string>;
  to?: Query<string>;
}

export const getEnergyReport = api(
  { expose: true, method: "GET", path: "/meters/reports/energy", auth: true },
  async ({ granularity, allocation, from, to }: GetEnergyReportRequest): Promise<EnergyReport> => {
    const userId = requireUser("meters.view");

    return await getEnergyReportForUser(
      userId,
      parseGranularity(granularity),
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
      parseAllocation(allocation),
    );
  },
);
