/**
 * Utility meters — PV economics and cost per application (Issue #792, Etappe 6c).
 *
 * Two questions this answers that the kWh reports cannot:
 *   1. What has the PV system actually saved, and when does it pay for itself?
 *   2. What does heating / hot water / charging the car really cost?
 *
 * Both run on the figures the energy report already derives. Self-consumed
 * kWh are valued at the assumed self-consumption price, kWh drawn from the
 * grid at the grid price in force at the time — the same prices the bucket
 * costs are built from, so the numbers stay consistent with each other.
 */

import { APIError } from "encore.dev/api";
import { listMeters } from "./meter.service";
import {
  getEnergyReportForUser,
  getMeterReportForUser,
  type EnergyReport,
  type EnergyReportBucket,
  type MeterReportBucket,
  type ReportGranularity,
} from "./reports.service";
import { loadEnergyTariffTimeline, type EnergyTariffTimeline } from "./tariffs.service";

/** Days per year used to project the payoff date. */
const DAYS_PER_YEAR = 365.25;

function roundMoney(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export interface PvEconomicsBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Electricity cost as it actually was, with the PV system. */
  netElectricityCostEur: number | null;
  /** What the same consumption would have cost bought entirely from the grid. */
  noPvElectricityCostEur: number | null;
  /** Difference of the two — the saving in this period. */
  savingsEur: number | null;
  /** Avoided grid purchase plus feed-in revenue. */
  pvBenefitEur: number | null;
  cumulativeSavingsEur: number | null;
  cumulativePvBenefitEur: number | null;
}

export interface PvAmortization {
  investmentNetEur: number | null;
  investmentVatEur: number | null;
  investmentTotalEur: number | null;
  /** Return the money was expected to earn elsewhere, per year (0.05 = 5 %). */
  expectedReturnRate: number | null;
  /** Return forgone so far, compounded at that rate over `yearsElapsed`. */
  opportunityCostEur: number | null;
  /** PV benefit accumulated over the whole measured history. */
  cumulativePvBenefitEur: number;
  /** Investment still to be earned back. */
  remainingEur: number | null;
  /** Same, but counting the returns the invested money did not earn. */
  remainingWithOpportunityEur: number | null;
  /** Benefit of the last twelve fully measured months. */
  benefitLast12MonthsEur: number | null;
  yearsElapsed: number;
  payoffReached: boolean;
  /** Extrapolated from the last twelve months; null if not projectable. */
  projectedPayoffDate: string | null;
  projectedPayoffDateWithOpportunity: string | null;
}

export interface ApplicationCost {
  totalKwh: number | null;
  pvKwh: number | null;
  gridKwh: number | null;
  costEur: number | null;
}

export interface UsageCostBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  heating: ApplicationCost;
  hotWater: ApplicationCost;
  evCharger: ApplicationCost;
  household: ApplicationCost;
  /** Standing charge, which belongs to no single application. */
  baseCostEur: number | null;
  totalCostEur: number | null;
}

export interface WaterCostBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  volume: number;
  waterCostEur: number | null;
  sewageCostEur: number | null;
  baseCostEur: number | null;
  totalCostEur: number | null;
}

export interface WaterCostReport {
  meterId: number;
  name: string;
  unit: string;
  buckets: WaterCostBucket[];
  totalVolume: number;
  totalCostEur: number | null;
}

export interface EconomicsReport {
  granularity: ReportGranularity;
  currency: "EUR";
  from: string | null;
  to: string | null;
  hasTariffs: boolean;
  hasInvestmentData: boolean;
  pv: {
    buckets: PvEconomicsBucket[];
    totalSavingsEur: number | null;
    totalPvBenefitEur: number | null;
    totalNetElectricityCostEur: number | null;
    totalNoPvElectricityCostEur: number | null;
    amortization: PvAmortization | null;
  };
  usageCosts: {
    buckets: UsageCostBucket[];
    totals: Omit<UsageCostBucket, "key" | "label" | "periodStart" | "periodEnd">;
  };
  /** One entry per visible water meter; empty without water tariffs. */
  water: WaterCostReport[];
}

function emptyApplicationCost(): ApplicationCost {
  return { totalKwh: null, pvKwh: null, gridKwh: null, costEur: null };
}

function applicationCost(
  totalKwh: number | null,
  pvKwh: number | null,
  gridKwh: number | null,
  selfPrice: number | null,
  gridPrice: number | null,
): ApplicationCost {
  if (totalKwh === null) return emptyApplicationCost();
  // Without a measured PV share the whole amount is valued at the grid price:
  // that is the conservative reading, not a claim that no PV was involved.
  const pv = pvKwh ?? 0;
  const grid = gridKwh ?? Math.max(0, totalKwh - pv);
  const costEur =
    gridPrice === null
      ? null
      : pv * (selfPrice ?? gridPrice) + grid * gridPrice;
  return {
    totalKwh,
    pvKwh,
    gridKwh: gridKwh ?? (pvKwh === null ? null : grid),
    costEur: roundMoney(costEur),
  };
}

/**
 * The self-consumed kWh that no sub-meter accounts for. Heating, hot water and
 * the wallbox measure their own PV share; whatever is left of the total
 * self-consumption belongs to the rest of the household.
 */
function householdPvKwh(bucket: EnergyReportBucket, householdKwh: number): number | null {
  if (bucket.selfConsumption === null) return null;
  const claimed =
    (bucket.heatHeatingPv ?? 0) + (bucket.hotWaterPv ?? 0) + (bucket.evChargerPv ?? 0);
  const remaining = bucket.selfConsumption - claimed;
  // Clamp: rounding and overlapping sub-meters must not produce a PV share
  // larger than the household consumed, nor a negative one.
  return Math.min(Math.max(0, remaining), householdKwh);
}

export function buildUsageCostBucket(
  bucket: EnergyReportBucket,
  timeline: EnergyTariffTimeline,
): UsageCostBucket {
  const prices = timeline.pricesForPeriod(bucket.periodStart, bucket.periodEnd);
  const gridPrice = prices.gridImportPricePerKwh;
  const selfPrice = prices.selfConsumptionPricePerKwh;

  const heating = applicationCost(
    bucket.heatHeatingTotal,
    bucket.heatHeatingPv,
    bucket.heatHeatingGrid,
    selfPrice,
    gridPrice,
  );
  const hotWater = applicationCost(
    bucket.hotWaterTotal,
    bucket.hotWaterPv,
    bucket.hotWaterGrid,
    selfPrice,
    gridPrice,
  );
  const evCharger = applicationCost(
    bucket.evChargerTotal,
    bucket.evChargerPv,
    bucket.evChargerGrid,
    selfPrice,
    gridPrice,
  );

  const householdKwh = bucket.consumptionWithoutHeatPumpAndEv;
  const householdPv = householdKwh === null ? null : householdPvKwh(bucket, householdKwh);
  const household = applicationCost(
    householdKwh,
    householdPv,
    householdKwh === null || householdPv === null ? null : Math.max(0, householdKwh - householdPv),
    selfPrice,
    gridPrice,
  );

  const costs = [heating.costEur, hotWater.costEur, evCharger.costEur, household.costEur].filter(
    (value): value is number => value !== null,
  );
  const totalCostEur =
    costs.length === 0
      ? null
      : roundMoney(costs.reduce((sum, value) => sum + value, 0) + (prices.baseCostEur ?? 0));

  return {
    key: bucket.key,
    label: bucket.label,
    periodStart: bucket.periodStart,
    periodEnd: bucket.periodEnd,
    heating,
    hotWater,
    evCharger,
    household,
    baseCostEur: roundMoney(prices.baseCostEur),
    totalCostEur,
  };
}

export function buildPvEconomicsBuckets(buckets: EnergyReportBucket[]): PvEconomicsBucket[] {
  let cumulativeSavings = 0;
  let cumulativeBenefit = 0;
  let sawSavings = false;
  let sawBenefit = false;

  return buckets.map((bucket) => {
    const net = bucket.costs?.netElectricityCostEur ?? null;
    const noPv = bucket.costs?.noPvElectricityCostEur ?? null;
    const benefit = bucket.costs?.pvBenefitEur ?? null;
    const savings = net !== null && noPv !== null ? roundMoney(noPv - net) : null;

    if (savings !== null) {
      cumulativeSavings += savings;
      sawSavings = true;
    }
    if (benefit !== null) {
      cumulativeBenefit += benefit;
      sawBenefit = true;
    }

    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      netElectricityCostEur: net,
      noPvElectricityCostEur: noPv,
      savingsEur: savings,
      pvBenefitEur: benefit,
      cumulativeSavingsEur: sawSavings ? roundMoney(cumulativeSavings) : null,
      cumulativePvBenefitEur: sawBenefit ? roundMoney(cumulativeBenefit) : null,
    };
  });
}

function addYears(from: Date, years: number): string {
  return new Date(from.getTime() + years * DAYS_PER_YEAR * 86_400_000).toISOString();
}

/**
 * Extrapolates when the system has earned its cost back, from the benefit of
 * the last twelve months.
 */
function projectPayoff(
  remaining: number,
  benefitPerYear: number,
  lastPeriodEnd: string,
): string | null {
  if (remaining <= 0) return lastPeriodEnd;
  if (benefitPerYear <= 0) return null;
  const end = new Date(lastPeriodEnd);
  if (Number.isNaN(end.getTime())) return null;
  return addYears(end, remaining / benefitPerYear);
}

/** How far ahead the opportunity-cost payoff is searched before giving up. */
const MAX_PROJECTION_YEARS = 60;

/**
 * Same projection, but against an investment that keeps growing at the expected
 * return rate. The money is only tied up as long as the system has not paid for
 * itself, so the forgone return compounds on the full sum every further year —
 * which has no closed form against a linear benefit. Stepping month by month is
 * precise enough for a projected date and makes no assumption about the two
 * curves crossing exactly once.
 */
function projectPayoffWithReturn(
  investmentTotal: number,
  rate: number,
  cumulativeBenefit: number,
  benefitPerYear: number,
  yearsElapsed: number,
  lastPeriodEnd: string,
): string | null {
  const end = new Date(lastPeriodEnd);
  if (Number.isNaN(end.getTime())) return null;
  const openAt = (years: number) =>
    investmentTotal * Math.pow(1 + rate, years) -
    (cumulativeBenefit + benefitPerYear * (years - yearsElapsed));

  if (openAt(yearsElapsed) <= 0) return lastPeriodEnd;
  if (benefitPerYear <= 0) return null;
  for (let month = 1; month <= MAX_PROJECTION_YEARS * 12; month += 1) {
    if (openAt(yearsElapsed + month / 12) <= 0) return addYears(end, month / 12);
  }
  return null;
}

export function buildAmortization(
  monthlyBuckets: PvEconomicsBucket[],
  timeline: EnergyTariffTimeline,
): PvAmortization | null {
  const withBenefit = monthlyBuckets.filter((bucket) => bucket.pvBenefitEur !== null);
  if (withBenefit.length === 0) return null;

  const investmentNetEur = timeline.amountOf("pv_investment_net");
  const investmentVatEur = timeline.amountOf("pv_investment_vat");
  const expectedReturnRate = timeline.amountOf("expected_return_rate");
  const investmentTotalEur =
    investmentNetEur === null && investmentVatEur === null
      ? null
      : roundMoney((investmentNetEur ?? 0) + (investmentVatEur ?? 0));

  const cumulativePvBenefitEur =
    withBenefit[withBenefit.length - 1].cumulativePvBenefitEur ?? 0;

  const first = withBenefit[0];
  const last = withBenefit[withBenefit.length - 1];
  const yearsElapsed =
    (new Date(last.periodEnd).getTime() - new Date(first.periodStart).getTime()) /
    (DAYS_PER_YEAR * 86_400_000);

  const benefitLast12MonthsEur =
    withBenefit.length >= 12
      ? roundMoney(
          withBenefit
            .slice(-12)
            .reduce((sum, bucket) => sum + (bucket.pvBenefitEur ?? 0), 0),
        )
      : null;

  const remainingEur =
    investmentTotalEur === null ? null : roundMoney(investmentTotalEur - cumulativePvBenefitEur);

  // Forgone return, compounded over the time the money has been tied up — the
  // yearly figure is no longer stored, only the rate it comes from.
  const opportunityCostEur =
    investmentTotalEur === null || expectedReturnRate === null
      ? null
      : roundMoney(
          investmentTotalEur *
            (Math.pow(1 + expectedReturnRate, Math.max(0, yearsElapsed)) - 1),
        );
  const remainingWithOpportunityEur =
    investmentTotalEur === null || opportunityCostEur === null
      ? null
      : roundMoney(investmentTotalEur + opportunityCostEur - cumulativePvBenefitEur);

  const canProject = remainingEur !== null && benefitLast12MonthsEur !== null;
  return {
    investmentNetEur,
    investmentVatEur,
    investmentTotalEur,
    expectedReturnRate,
    opportunityCostEur,
    cumulativePvBenefitEur: roundMoney(cumulativePvBenefitEur) ?? 0,
    remainingEur,
    remainingWithOpportunityEur,
    benefitLast12MonthsEur,
    yearsElapsed: Math.round(yearsElapsed * 100) / 100,
    payoffReached: remainingEur !== null && remainingEur <= 0,
    projectedPayoffDate: canProject
      ? projectPayoff(remainingEur!, benefitLast12MonthsEur!, last.periodEnd)
      : null,
    projectedPayoffDateWithOpportunity:
      canProject && investmentTotalEur !== null && expectedReturnRate !== null
        ? projectPayoffWithReturn(
            investmentTotalEur,
            expectedReturnRate,
            cumulativePvBenefitEur,
            benefitLast12MonthsEur!,
            yearsElapsed,
            last.periodEnd,
          )
        : null,
  };
}

function sumOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return roundMoney(present.reduce((sum, value) => sum + value, 0));
}

function sumApplication(buckets: UsageCostBucket[], pick: (b: UsageCostBucket) => ApplicationCost) {
  const parts = buckets.map(pick);
  return {
    totalKwh: sumOf(parts.map((part) => part.totalKwh)),
    pvKwh: sumOf(parts.map((part) => part.pvKwh)),
    gridKwh: sumOf(parts.map((part) => part.gridKwh)),
    costEur: sumOf(parts.map((part) => part.costEur)),
  };
}

/**
 * Water cost per period. Sewage is billed on the same metered volume as fresh
 * water, so both rates apply to it; the standing charge is prorated across
 * month boundaries like the electricity one.
 */
export function buildWaterCostReport(
  meterId: number,
  name: string,
  unit: string,
  buckets: MeterReportBucket[],
  timeline: EnergyTariffTimeline,
): WaterCostReport {
  const costBuckets = buckets.map((bucket): WaterCostBucket => {
    const waterPrice = timeline.weightedAmountForPeriod(
      "water_price",
      bucket.periodStart,
      bucket.periodEnd,
    );
    const sewagePrice = timeline.weightedAmountForPeriod(
      "sewage_price",
      bucket.periodStart,
      bucket.periodEnd,
    );
    const baseCostEur = timeline.monthlyChargeForPeriod(
      "water_base_price",
      bucket.periodStart,
      bucket.periodEnd,
    );

    const waterCostEur = waterPrice === null ? null : bucket.consumption * waterPrice;
    const sewageCostEur = sewagePrice === null ? null : bucket.consumption * sewagePrice;
    const parts = [waterCostEur, sewageCostEur, baseCostEur].filter(
      (value): value is number => value !== null,
    );

    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      volume: bucket.consumption,
      waterCostEur: roundMoney(waterCostEur),
      sewageCostEur: roundMoney(sewageCostEur),
      baseCostEur: roundMoney(baseCostEur),
      totalCostEur:
        parts.length === 0 ? null : roundMoney(parts.reduce((sum, value) => sum + value, 0)),
    };
  });

  return {
    meterId,
    name,
    unit,
    buckets: costBuckets,
    totalVolume:
      Math.round(costBuckets.reduce((sum, bucket) => sum + bucket.volume, 0) * 1000) / 1000,
    totalCostEur: sumOf(costBuckets.map((bucket) => bucket.totalCostEur)),
  };
}

export async function getEconomicsReportForUser(
  userId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<EconomicsReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const report = await getEnergyReportForUser(userId, granularity, fromDate, toDate);
  // Amortisation always runs on the full monthly history: it asks what the
  // system has earned since it was installed, not what a filtered view shows.
  const monthlyReport: EnergyReport =
    granularity === "month" && !fromDate && !toDate
      ? report
      : await getEnergyReportForUser(userId, "month", null, null);

  const timeline = await loadEnergyTariffTimeline(userId);
  const hasTariffs = timeline.hasCostTariffs();

  const pvBuckets = buildPvEconomicsBuckets(report.buckets);
  const monthlyPvBuckets =
    monthlyReport === report ? pvBuckets : buildPvEconomicsBuckets(monthlyReport.buckets);
  const amortization = hasTariffs ? buildAmortization(monthlyPvBuckets, timeline) : null;

  const usageBuckets = hasTariffs
    ? report.buckets.map((bucket) => buildUsageCostBucket(bucket, timeline))
    : [];

  const hasWaterTariffs =
    timeline.amountOf("water_price") !== null || timeline.amountOf("sewage_price") !== null;
  const water: WaterCostReport[] = [];
  if (hasWaterTariffs) {
    for (const meter of await listMeters(userId)) {
      if (meter.type !== "water") continue;
      const meterReport = await getMeterReportForUser(
        userId,
        meter.id,
        granularity,
        fromDate,
        toDate,
      );
      water.push(
        buildWaterCostReport(meter.id, meter.name, meter.unit, meterReport.buckets, timeline),
      );
    }
  }

  return {
    granularity,
    currency: "EUR",
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    hasTariffs,
    hasInvestmentData: amortization?.investmentTotalEur !== null && amortization !== null,
    pv: {
      buckets: pvBuckets,
      totalSavingsEur: sumOf(pvBuckets.map((bucket) => bucket.savingsEur)),
      totalPvBenefitEur: sumOf(pvBuckets.map((bucket) => bucket.pvBenefitEur)),
      totalNetElectricityCostEur: sumOf(pvBuckets.map((bucket) => bucket.netElectricityCostEur)),
      totalNoPvElectricityCostEur: sumOf(pvBuckets.map((bucket) => bucket.noPvElectricityCostEur)),
      amortization,
    },
    usageCosts: {
      buckets: usageBuckets,
      totals: {
        heating: sumApplication(usageBuckets, (bucket) => bucket.heating),
        hotWater: sumApplication(usageBuckets, (bucket) => bucket.hotWater),
        evCharger: sumApplication(usageBuckets, (bucket) => bucket.evCharger),
        household: sumApplication(usageBuckets, (bucket) => bucket.household),
        baseCostEur: sumOf(usageBuckets.map((bucket) => bucket.baseCostEur)),
        totalCostEur: sumOf(usageBuckets.map((bucket) => bucket.totalCostEur)),
      },
    },
    water,
  };
}
