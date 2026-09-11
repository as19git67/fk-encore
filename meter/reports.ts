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
  REPORT_GRANULARITIES,
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
import {
  getSeasonProfileForUser,
  type SeasonProfileReport,
} from "./season-profile.service";
import {
  getHeatingWeatherReportForUser,
  type HeatingWeatherReport,
} from "./heating-weather.service";
import {
  getAdvancePaymentsReportForUser,
  type AdvancePaymentsReport,
} from "./advance-payments.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

function parseGranularity(value: ReportGranularity | undefined): ReportGranularity {
  const granularity = value ?? "month";
  if (!REPORT_GRANULARITIES.includes(granularity)) {
    throw APIError.invalidArgument("granularity must be 'day', 'week', 'month' or 'year'");
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

interface ReportRangeRequest {
  from?: Query<string>;
  to?: Query<string>;
}

/** Report A3 (#1022): heatmap year × month of autarky and self-consumption rate. */
export const getSeasonProfile = api(
  { expose: true, method: "GET", path: "/meters/reports/season-profile", auth: true },
  async ({ from, to }: ReportRangeRequest): Promise<SeasonProfileReport> => {
    const userId = requireUser("meters.view");
    return await getSeasonProfileForUser(
      userId,
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

/** Report C3 (#1023): heating consumption per degree day / against the household's typical month. */
export const getHeatingWeatherReport = api(
  { expose: true, method: "GET", path: "/meters/reports/heating-weather", auth: true },
  async ({ from, to }: ReportRangeRequest): Promise<HeatingWeatherReport> => {
    const userId = requireUser("meters.view");
    return await getHeatingWeatherReportForUser(
      userId,
      parseReportBoundary(from, "from"),
      parseReportBoundary(to, "to"),
    );
  },
);

/** Report E3 (#1018): advance payments linked to readings against the calculated actual cost. */
export const getAdvancePaymentsReport = api(
  { expose: true, method: "GET", path: "/meters/reports/advance-payments", auth: true },
  async (): Promise<AdvancePaymentsReport> => {
    const auth = getAuthData();
    if (!auth) throw APIError.unauthenticated("Unauthorized");
    requirePermission(auth, "meters.view");
    requirePermission(auth, "finance.view");
    return await getAdvancePaymentsReportForUser({
      userId: parseInt(auth.userID, 10),
      permissions: auth.permissions,
    });
  },
);
