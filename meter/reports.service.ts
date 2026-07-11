import { APIError } from "encore.dev/api";
import { asc, eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { meterDevices, meterReadings } from "../db/schema";
import { listMeters, loadVisibleMeter, type MeterListItem } from "./meter.service";
import {
  EnergyTariffTimeline,
  loadEnergyTariffTimeline,
  type EnergyTariffCostResult,
} from "./tariffs.service";

export type ReportGranularity = "month" | "year";

export interface AbsoluteReadingPoint {
  takenAt: string;
  value: number;
}

export interface MeterReportBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  startReadingAt: string;
  endReadingAt: string;
  startValue: number;
  endValue: number;
  consumption: number;
  intervals: number;
}

export interface MeterReport {
  meterId: number;
  name: string;
  unit: string;
  decimals: number;
  granularity: ReportGranularity;
  from: string | null;
  to: string | null;
  buckets: MeterReportBucket[];
  totalConsumption: number;
}

export type EnergyReportRole =
  | "grid_import"
  | "grid_export"
  | "pv_production"
  | "heat_pump_total"
  | "heat_heating_total"
  | "heat_heating_pv"
  | "hot_water_total"
  | "hot_water_pv"
  | "ev_charger_total"
  | "ev_charger_pv";

export interface EnergyReportMeterRef {
  role: EnergyReportRole;
  meterId: number;
  name: string;
}

export interface EnergyReportBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  gridImport: number | null;
  gridExport: number | null;
  production: number | null;
  selfConsumption: number | null;
  totalConsumption: number | null;
  consumptionWithoutHeatPumpAndEv: number | null;
  autarky: number | null;
  selfConsumptionRate: number | null;
  heatPumpTotal: number | null;
  heatHeatingTotal: number | null;
  heatHeatingPv: number | null;
  heatHeatingGrid: number | null;
  heatHeatingPvShare: number | null;
  hotWaterTotal: number | null;
  hotWaterPv: number | null;
  hotWaterGrid: number | null;
  hotWaterPvShare: number | null;
  evChargerTotal: number | null;
  evChargerPv: number | null;
  evChargerPvShare: number | null;
  costs: EnergyTariffCostResult | null;
}

export interface EnergyReport {
  unit: string;
  decimals: number;
  granularity: ReportGranularity;
  from: string | null;
  to: string | null;
  meters: EnergyReportMeterRef[];
  missingRoles: EnergyReportRole[];
  buckets: EnergyReportBucket[];
  totals: Omit<EnergyReportBucket, "key" | "label" | "periodStart" | "periodEnd">;
  hasTariffs: boolean;
}

const ENERGY_REPORT_ROLES: EnergyReportRole[] = [
  "grid_import",
  "grid_export",
  "pv_production",
  "heat_pump_total",
  "heat_heating_total",
  "heat_heating_pv",
  "hot_water_total",
  "hot_water_pv",
  "ev_charger_total",
  "ev_charger_pv",
];

const REQUIRED_ENERGY_REPORT_ROLES: EnergyReportRole[] = [
  "grid_import",
  "grid_export",
  "pv_production",
];

export function parseReportBoundary(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw APIError.invalidArgument(`${field} is not a valid date`);
  }
  return date;
}

function bucketKey(date: Date, granularity: ReportGranularity): string {
  const year = date.getUTCFullYear();
  if (granularity === "year") return String(year);
  return `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function bucketLabel(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") return key;
  const [year, month] = key.split("-");
  return `${month}.${year}`;
}

function bucketStartIso(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") return `${key}-01-01T00:00:00.000Z`;
  return `${key}-01T00:00:00.000Z`;
}

function bucketEndIso(key: string, granularity: ReportGranularity): string {
  if (granularity === "year") {
    return `${Number(key) + 1}-01-01T00:00:00.000Z`;
  }
  const [yearRaw, monthRaw] = key.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const next = month === 12 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, month, 1));
  return next.toISOString();
}

export function roundReportValue(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(value * factor) / factor;
}

function roundRatio(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

export function buildMeterReportBuckets(
  readings: AbsoluteReadingPoint[],
  granularity: ReportGranularity,
  options: { from?: Date | null; to?: Date | null; decimals?: number } = {},
): MeterReportBucket[] {
  const sorted = [...readings].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const from = options.from ?? null;
  const to = options.to ?? null;
  const decimals = options.decimals ?? 3;
  const buckets = new Map<string, MeterReportBucket>();

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const startDate = new Date(start.takenAt);
    const endDate = new Date(end.takenAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) continue;
    if (from && startDate < from) continue;
    if (to && startDate >= to) continue;

    const consumption = end.value - start.value;
    if (!Number.isFinite(consumption) || consumption < 0) continue;

    const key = bucketKey(startDate, granularity);
    const existing = buckets.get(key);
    if (existing) {
      existing.endReadingAt = end.takenAt;
      existing.endValue = end.value;
      existing.consumption = roundReportValue(existing.consumption + consumption, decimals);
      existing.intervals += 1;
    } else {
      buckets.set(key, {
        key,
        label: bucketLabel(key, granularity),
        periodStart: bucketStartIso(key, granularity),
        periodEnd: bucketEndIso(key, granularity),
        startReadingAt: start.takenAt,
        endReadingAt: end.takenAt,
        startValue: start.value,
        endValue: end.value,
        consumption: roundReportValue(consumption, decimals),
        intervals: 1,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function loadAbsoluteReadingSeries(
  userId: number,
  meterId: number,
): Promise<AbsoluteReadingPoint[]> {
  await loadVisibleMeter(userId, meterId);

  const devices = await dbAll<typeof meterDevices.$inferSelect>(
    db
      .select()
      .from(meterDevices)
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(asc(meterDevices.installed_at), asc(meterDevices.id)),
  );
  if (devices.length === 0) return [];

  const baseByDevice = new Map<number, { base: number; start: number }>();
  let running = 0;
  for (const device of devices) {
    const start = parseFloat(device.start_value);
    baseByDevice.set(device.id, { base: running, start });
    if (device.end_value !== null) {
      running += parseFloat(device.end_value) - start;
    }
  }

  const readings = await dbAll<{ device_id: number; value: string; taken_at: string }>(
    db
      .select({
        device_id: meterReadings.device_id,
        value: meterReadings.value,
        taken_at: meterReadings.taken_at,
      })
      .from(meterReadings)
      .innerJoin(meterDevices, eq(meterReadings.device_id, meterDevices.id))
      .where(eq(meterDevices.meter_id, meterId))
      .orderBy(asc(meterReadings.taken_at), asc(meterReadings.id)),
  );

  return readings.map((reading) => {
    const base = baseByDevice.get(reading.device_id);
    const rawValue = parseFloat(reading.value);
    return {
      takenAt: reading.taken_at,
      value: base ? base.base + rawValue - base.start : rawValue,
    };
  });
}

export async function getMeterReportForUser(
  userId: number,
  meterId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<MeterReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const meter = await loadVisibleMeter(userId, meterId);
  const readings = await loadAbsoluteReadingSeries(userId, meterId);
  const buckets = buildMeterReportBuckets(readings, granularity, {
    from: fromDate,
    to: toDate,
    decimals: meter.decimals,
  });

  return {
    meterId: meter.id,
    name: meter.name,
    unit: meter.unit,
    decimals: meter.decimals,
    granularity,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    buckets,
    totalConsumption: roundReportValue(
      buckets.reduce((sum, bucket) => sum + bucket.consumption, 0),
      meter.decimals,
    ),
  };
}

export function buildEnergyReportFromMeterReports(
  reports: Partial<Record<EnergyReportRole, MeterReport>>,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
  tariffTimeline?: EnergyTariffTimeline,
): Omit<EnergyReport, "meters" | "missingRoles"> {
  const decimals = Math.max(
    0,
    reports.grid_import?.decimals ?? 0,
    reports.grid_export?.decimals ?? 0,
    reports.pv_production?.decimals ?? 0,
    reports.heat_pump_total?.decimals ?? 0,
    reports.heat_heating_total?.decimals ?? 0,
    reports.heat_heating_pv?.decimals ?? 0,
    reports.hot_water_total?.decimals ?? 0,
    reports.hot_water_pv?.decimals ?? 0,
    reports.ev_charger_total?.decimals ?? 0,
    reports.ev_charger_pv?.decimals ?? 0,
  );
  const bucketKeys = new Set<string>();
  for (const report of Object.values(reports)) {
    for (const bucket of report?.buckets ?? []) bucketKeys.add(bucket.key);
  }

  const byRole = new Map<EnergyReportRole, Map<string, MeterReportBucket>>();
  for (const role of ENERGY_REPORT_ROLES) {
    byRole.set(role, new Map((reports[role]?.buckets ?? []).map((bucket) => [bucket.key, bucket])));
  }

  const buckets = [...bucketKeys].sort().map((key): EnergyReportBucket => {
    const source =
      byRole.get("grid_import")?.get(key) ??
      byRole.get("grid_export")?.get(key) ??
      byRole.get("pv_production")?.get(key) ??
      byRole.get("heat_pump_total")?.get(key) ??
      byRole.get("heat_heating_total")?.get(key) ??
      byRole.get("hot_water_total")?.get(key) ??
      byRole.get("ev_charger_total")?.get(key);
    const gridImport = byRole.get("grid_import")?.get(key)?.consumption ?? null;
    const gridExport = byRole.get("grid_export")?.get(key)?.consumption ?? null;
    const production = byRole.get("pv_production")?.get(key)?.consumption ?? null;
    const heatPumpTotal = byRole.get("heat_pump_total")?.get(key)?.consumption ?? null;
    const heatHeatingTotal = byRole.get("heat_heating_total")?.get(key)?.consumption ?? null;
    const heatHeatingPv = byRole.get("heat_heating_pv")?.get(key)?.consumption ?? null;
    const heatHeatingGrid =
      heatHeatingTotal !== null && heatHeatingPv !== null
        ? roundReportValue(Math.max(0, heatHeatingTotal - heatHeatingPv), decimals)
        : null;
    const heatHeatingPvShare =
      heatHeatingTotal !== null && heatHeatingTotal > 0 && heatHeatingPv !== null
        ? roundRatio(heatHeatingPv / heatHeatingTotal)
        : null;
    const hotWaterTotal = byRole.get("hot_water_total")?.get(key)?.consumption ?? null;
    const hotWaterPv = byRole.get("hot_water_pv")?.get(key)?.consumption ?? null;
    const hotWaterGrid =
      hotWaterTotal !== null && hotWaterPv !== null
        ? roundReportValue(Math.max(0, hotWaterTotal - hotWaterPv), decimals)
        : null;
    const hotWaterPvShare =
      hotWaterTotal !== null && hotWaterTotal > 0 && hotWaterPv !== null
        ? roundRatio(hotWaterPv / hotWaterTotal)
        : null;
    const evChargerTotal = byRole.get("ev_charger_total")?.get(key)?.consumption ?? null;
    const evChargerPv = byRole.get("ev_charger_pv")?.get(key)?.consumption ?? null;
    const evChargerPvShare =
      evChargerTotal !== null && evChargerTotal > 0 && evChargerPv !== null
        ? roundRatio(evChargerPv / evChargerTotal)
        : null;
    const selfConsumption =
      production !== null && gridExport !== null
        ? roundReportValue(Math.max(0, production - gridExport), decimals)
        : null;
    const totalConsumption =
      gridImport !== null && selfConsumption !== null
        ? roundReportValue(gridImport + selfConsumption, decimals)
        : null;
    const heatPumpExclusion =
      heatPumpTotal ??
      (heatHeatingTotal !== null && hotWaterTotal !== null
        ? roundReportValue(heatHeatingTotal + hotWaterTotal, decimals)
        : null);
    const consumptionWithoutHeatPumpAndEv =
      totalConsumption !== null
        ? roundReportValue(Math.max(0, totalConsumption - (heatPumpExclusion ?? 0) - (evChargerTotal ?? 0)), decimals)
        : null;

    const bucket: EnergyReportBucket = {
      key,
      label: source?.label ?? bucketLabel(key, granularity),
      periodStart: source?.periodStart ?? bucketStartIso(key, granularity),
      periodEnd: source?.periodEnd ?? bucketEndIso(key, granularity),
      gridImport,
      gridExport,
      production,
      selfConsumption,
      totalConsumption,
      consumptionWithoutHeatPumpAndEv,
      autarky:
        totalConsumption !== null && totalConsumption > 0 && gridImport !== null
          ? roundRatio(1 - gridImport / totalConsumption)
          : null,
      selfConsumptionRate:
        production !== null && production > 0 && selfConsumption !== null
          ? roundRatio(selfConsumption / production)
          : null,
      heatPumpTotal,
      heatHeatingTotal,
      heatHeatingPv,
      heatHeatingGrid,
      heatHeatingPvShare,
      hotWaterTotal,
      hotWaterPv,
      hotWaterGrid,
      hotWaterPvShare,
      evChargerTotal,
      evChargerPv,
      evChargerPvShare,
      costs: null,
    };
    bucket.costs = tariffTimeline?.hasCostTariffs()
      ? tariffTimeline.costsForBucket({
          periodStart: bucket.periodStart,
          periodEnd: bucket.periodEnd,
          gridImport: bucket.gridImport,
          gridExport: bucket.gridExport,
          selfConsumption: bucket.selfConsumption,
          totalConsumption: bucket.totalConsumption,
        })
      : null;
    return bucket;
  });
  const completeBuckets = buckets.filter(
    (bucket) =>
      bucket.gridImport !== null &&
      bucket.gridExport !== null &&
      bucket.production !== null &&
      bucket.selfConsumption !== null &&
      bucket.totalConsumption !== null &&
      bucket.autarky !== null &&
      bucket.selfConsumptionRate !== null,
  );

  const sum = (selector: (bucket: EnergyReportBucket) => number | null) => {
    const values = completeBuckets.map(selector).filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return roundReportValue(values.reduce((total, value) => total + value, 0), decimals);
  };

  const gridImport = sum((bucket) => bucket.gridImport);
  const gridExport = sum((bucket) => bucket.gridExport);
  const production = sum((bucket) => bucket.production);
  const heatPumpTotal = sum((bucket) => bucket.heatPumpTotal);
  const heatHeatingTotal = sum((bucket) => bucket.heatHeatingTotal);
  const heatHeatingPv = sum((bucket) => bucket.heatHeatingPv);
  const heatHeatingGrid = sum((bucket) => bucket.heatHeatingGrid);
  const hotWaterTotal = sum((bucket) => bucket.hotWaterTotal);
  const hotWaterPv = sum((bucket) => bucket.hotWaterPv);
  const hotWaterGrid = sum((bucket) => bucket.hotWaterGrid);
  const evChargerTotal = sum((bucket) => bucket.evChargerTotal);
  const evChargerPv = sum((bucket) => bucket.evChargerPv);
  const costSum = (selector: (bucket: EnergyReportBucket) => number | null | undefined) => {
    const values = completeBuckets
      .map(selector)
      .filter((value): value is number => value !== null && value !== undefined);
    if (values.length === 0) return null;
    return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  };
  const selfConsumption =
    production !== null && gridExport !== null
      ? roundReportValue(Math.max(0, production - gridExport), decimals)
      : null;
  const totalConsumption =
    gridImport !== null && selfConsumption !== null
      ? roundReportValue(gridImport + selfConsumption, decimals)
      : null;
  const heatPumpExclusion =
    heatPumpTotal ??
    (heatHeatingTotal !== null && hotWaterTotal !== null
      ? roundReportValue(heatHeatingTotal + hotWaterTotal, decimals)
      : null);
  const consumptionWithoutHeatPumpAndEv =
    totalConsumption !== null
      ? roundReportValue(Math.max(0, totalConsumption - (heatPumpExclusion ?? 0) - (evChargerTotal ?? 0)), decimals)
      : null;

  return {
    unit: "kWh",
    decimals,
    granularity,
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    buckets: completeBuckets,
    totals: {
      gridImport,
      gridExport,
      production,
      selfConsumption,
      totalConsumption,
      consumptionWithoutHeatPumpAndEv,
      autarky:
        totalConsumption !== null && totalConsumption > 0 && gridImport !== null
          ? roundRatio(1 - gridImport / totalConsumption)
          : null,
      selfConsumptionRate:
        production !== null && production > 0 && selfConsumption !== null
          ? roundRatio(selfConsumption / production)
          : null,
      heatPumpTotal,
      heatHeatingTotal,
      heatHeatingPv,
      heatHeatingGrid,
      heatHeatingPvShare:
        heatHeatingTotal !== null && heatHeatingTotal > 0 && heatHeatingPv !== null
          ? roundRatio(heatHeatingPv / heatHeatingTotal)
          : null,
      hotWaterTotal,
      hotWaterPv,
      hotWaterGrid,
      hotWaterPvShare:
        hotWaterTotal !== null && hotWaterTotal > 0 && hotWaterPv !== null
          ? roundRatio(hotWaterPv / hotWaterTotal)
          : null,
      evChargerTotal,
      evChargerPv,
      evChargerPvShare:
        evChargerTotal !== null && evChargerTotal > 0 && evChargerPv !== null
          ? roundRatio(evChargerPv / evChargerTotal)
          : null,
      costs: tariffTimeline?.hasCostTariffs()
        ? {
            gridImportCostEur: costSum((bucket) => bucket.costs?.gridImportCostEur),
            baseCostEur: costSum((bucket) => bucket.costs?.baseCostEur),
            feedInRevenueEur: costSum((bucket) => bucket.costs?.feedInRevenueEur),
            avoidedGridCostEur: costSum((bucket) => bucket.costs?.avoidedGridCostEur),
            pvBenefitEur: costSum((bucket) => bucket.costs?.pvBenefitEur),
            netElectricityCostEur: costSum((bucket) => bucket.costs?.netElectricityCostEur),
            noPvElectricityCostEur: costSum((bucket) => bucket.costs?.noPvElectricityCostEur),
          }
        : null,
    },
    hasTariffs: tariffTimeline?.hasCostTariffs() ?? false,
  };
}

export async function getEnergyReportForUser(
  userId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<EnergyReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const roleMeters = new Map<EnergyReportRole, MeterListItem>();
  for (const meter of await listMeters(userId)) {
    const role = meter.role;
    if (role && !roleMeters.has(role)) roleMeters.set(role, meter);
  }

  const reports: Partial<Record<EnergyReportRole, MeterReport>> = {};
  for (const [role, meter] of roleMeters) {
    reports[role] = await getMeterReportForUser(userId, meter.id, granularity, fromDate, toDate);
  }

  const tariffTimeline = await loadEnergyTariffTimeline(userId);
  const base = buildEnergyReportFromMeterReports(reports, granularity, fromDate, toDate, tariffTimeline);
  return {
    ...base,
    meters: [...roleMeters.entries()].map(([role, meter]) => ({
      role,
      meterId: meter.id,
      name: meter.name,
    })),
    missingRoles: REQUIRED_ENERGY_REPORT_ROLES.filter((role) => !roleMeters.has(role)),
  };
}
