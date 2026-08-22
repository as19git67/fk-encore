/**
 * Utility meters — counterfactual technology comparisons (Issue #792, Etappe 6d).
 *
 * "What would a gas boiler have cost instead of the heat pump?" and "what
 * would a petrol car have cost instead of charging at the wallbox?" These are
 * model calculations, not measurements: only the electricity side is metered,
 * the other side is derived from assumptions.
 *
 * Two consequences shape the design. Every response carries the assumptions it
 * used, so the UI can show them and the reader can judge the number. And the
 * heat-pump comparison is reported as a **range** over SCOP ± SCOP_BAND rather
 * than a single figure — without a heat meter the seasonal performance factor
 * is an estimate, and a single euro amount would claim a precision the data
 * does not have.
 */

import { APIError } from "encore.dev/api";
import {
  getEnergyReportForUser,
  type EnergyReportBucket,
  type ReportGranularity,
} from "./reports.service";
import {
  loadEnergyTariffTimeline,
  type ElectricityTariffKind,
  type ElectricityTariffUnit,
  type EnergyTariffTimeline,
} from "./tariffs.service";
import { buildUsageCostBucket, type UsageCostBucket } from "./economics.service";

/**
 * How far the seasonal performance factor is varied to give the heat-pump
 * comparison an honest range. ±0.5 is the usual spread between a manufacturer
 * figure and what a real installation delivers.
 */
export const SCOP_BAND = 0.5;

function roundMoney(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function roundAmount(value: number | null, decimals = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface ComparisonAssumption {
  kind: ElectricityTariffKind;
  label: string;
  amount: number;
  unit: ElectricityTariffUnit;
}

/** A euro figure with the range that the SCOP uncertainty spans. */
export interface CostRange {
  low: number | null;
  mid: number | null;
  high: number | null;
}

export interface HeatingComparisonBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Electricity the heat pump actually used for heating and hot water. */
  heatPumpKwh: number | null;
  /** Actual cost of that electricity. */
  heatPumpCostEur: number | null;
  /** Heat delivered, derived from the electricity via the SCOP. */
  heatDeliveredKwh: CostRange;
  /** Gas that a boiler would have burned for the same heat. */
  gasKwh: CostRange;
  /** What that gas would have cost, including the standing charge. */
  gasCostEur: CostRange;
  /** Positive = the heat pump was cheaper. */
  savingsEur: CostRange;
}

export interface HeatingComparison {
  buckets: HeatingComparisonBucket[];
  /** Span actually covered by buckets with heat pump consumption; null if none. */
  periodStart: string | null;
  periodEnd: string | null;
  totalHeatPumpCostEur: number | null;
  totalGasCostEur: CostRange;
  totalSavingsEur: CostRange;
  /** kg CO2 avoided against the gas boiler; null without emission factors. */
  avoidedCo2Kg: number | null;
  scop: number | null;
  scopRange: { low: number; high: number } | null;
  assumptions: ComparisonAssumption[];
}

export interface CarComparisonBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  chargedKwh: number | null;
  /** Actual metered cost of that charging electricity (grid + self-consumption price). */
  evCostEur: number | null;
  /**
   * Feed-in revenue forgone on the PV share of the charge: that kWh could have
   * been exported instead of used to charge. Null without a feed-in tariff.
   */
  lostFeedInEur: number | null;
  /** evCostEur plus the forgone feed-in revenue — the true cost of charging at home. */
  evCostWithOpportunityEur: number | null;
  /** Distance the charged energy covers, from the assumed consumption. */
  kilometers: number | null;
  /** Petrol the same distance would have needed. */
  petrolLitres: number | null;
  petrolCostEur: number | null;
  /** Positive = charging was cheaper than the petrol car, against evCostWithOpportunityEur. */
  savingsEur: number | null;
}

export interface CarComparison {
  buckets: CarComparisonBucket[];
  /** Span actually covered by buckets with charging activity; null if none. */
  periodStart: string | null;
  periodEnd: string | null;
  totalChargedKwh: number | null;
  totalKilometers: number | null;
  totalEvCostEur: number | null;
  totalLostFeedInEur: number | null;
  totalEvCostWithOpportunityEur: number | null;
  totalPetrolCostEur: number | null;
  totalSavingsEur: number | null;
  /** Cost per kilometre, in cents — against the opportunity-adjusted charging cost. */
  evCentsPerKm: number | null;
  petrolCentsPerKm: number | null;
  avoidedCo2Kg: number | null;
  assumptions: ComparisonAssumption[];
}

export interface ComparisonsReport {
  granularity: ReportGranularity;
  currency: "EUR";
  from: string | null;
  to: string | null;
  /** False when the assumptions for a comparison are missing entirely. */
  hasHeatingAssumptions: boolean;
  hasCarAssumptions: boolean;
  heating: HeatingComparison | null;
  car: CarComparison | null;
}

const ASSUMPTION_LABELS: Partial<Record<ElectricityTariffKind, string>> = {
  gas_price: "Gaspreis",
  gas_base_price: "Gas-Grundpreis",
  boiler_efficiency: "Kesselwirkungsgrad",
  heat_pump_scop: "Jahresarbeitszahl (JAZ)",
  ev_consumption: "Verbrauch E-Auto",
  petrol_consumption: "Verbrauch Benziner",
  petrol_price: "Benzinpreis",
  grid_co2: "CO₂-Faktor Netzstrom",
  gas_co2: "CO₂-Faktor Erdgas",
  petrol_co2: "CO₂-Faktor Benzin",
  feed_in: "Einspeisevergütung",
};

const ASSUMPTION_UNITS: Partial<Record<ElectricityTariffKind, ElectricityTariffUnit>> = {
  gas_price: "eur_per_kwh",
  gas_base_price: "eur_per_month",
  boiler_efficiency: "ratio",
  heat_pump_scop: "ratio",
  ev_consumption: "kwh_per_100km",
  petrol_consumption: "l_per_100km",
  petrol_price: "eur_per_l",
  grid_co2: "kg_per_kwh",
  gas_co2: "kg_per_kwh",
  petrol_co2: "kg_per_l",
  feed_in: "eur_per_kwh",
};

function collectAssumptions(
  timeline: EnergyTariffTimeline,
  kinds: ElectricityTariffKind[],
): ComparisonAssumption[] {
  const result: ComparisonAssumption[] = [];
  for (const kind of kinds) {
    const amount = timeline.amountOf(kind);
    if (amount === null) continue;
    result.push({
      kind,
      label: ASSUMPTION_LABELS[kind] ?? kind,
      amount,
      unit: ASSUMPTION_UNITS[kind] ?? "eur",
    });
  }
  return result;
}

function emptyRange(): CostRange {
  return { low: null, mid: null, high: null };
}

function mapRange(range: CostRange, fn: (value: number) => number): CostRange {
  return {
    low: range.low === null ? null : fn(range.low),
    mid: range.mid === null ? null : fn(range.mid),
    high: range.high === null ? null : fn(range.high),
  };
}

function sumRanges(ranges: CostRange[]): CostRange {
  const sumKey = (key: keyof CostRange) => {
    const values = ranges.map((range) => range[key]).filter((v): v is number => v !== null);
    return values.length === 0 ? null : roundMoney(values.reduce((a, b) => a + b, 0));
  };
  return { low: sumKey("low"), mid: sumKey("mid"), high: sumKey("high") };
}

function sumOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * Span actually covered by the buckets that carry a value — not the report's
 * `from`/`to` filter, which is usually null (unbounded) and would leave the
 * reader guessing which years the figures below are drawn from.
 */
function coveredPeriod<T extends { periodStart: string; periodEnd: string }>(
  buckets: T[],
  hasValue: (bucket: T) => boolean,
): { periodStart: string | null; periodEnd: string | null } {
  const relevant = buckets.filter(hasValue);
  if (relevant.length === 0) return { periodStart: null, periodEnd: null };
  return {
    periodStart: relevant[0].periodStart,
    periodEnd: relevant[relevant.length - 1].periodEnd,
  };
}

/**
 * A low SCOP means the heat pump delivered less heat per kWh, so the boiler
 * replacing it burns less gas — the *low* SCOP therefore yields the *low* gas
 * cost. The range is ordered by SCOP, and the cost figures follow it.
 */
function heatRangeFromScop(electricityKwh: number, scop: number): CostRange {
  return {
    low: electricityKwh * Math.max(0, scop - SCOP_BAND),
    mid: electricityKwh * scop,
    high: electricityKwh * (scop + SCOP_BAND),
  };
}

export function buildHeatingComparison(
  energyBuckets: EnergyReportBucket[],
  usageBuckets: UsageCostBucket[],
  timeline: EnergyTariffTimeline,
): HeatingComparison | null {
  const scop = timeline.amountOf("heat_pump_scop");
  const boilerEfficiency = timeline.amountOf("boiler_efficiency");
  if (scop === null || scop <= 0 || boilerEfficiency === null || boilerEfficiency <= 0) {
    return null;
  }

  const usageByKey = new Map(usageBuckets.map((bucket) => [bucket.key, bucket]));
  const gasCo2 = timeline.amountOf("gas_co2");
  const gridCo2 = timeline.amountOf("grid_co2");

  const buckets = energyBuckets.map((bucket): HeatingComparisonBucket => {
    const usage = usageByKey.get(bucket.key);
    const heatPumpKwh = sumOf([bucket.heatHeatingTotal, bucket.hotWaterTotal]);
    const heatPumpCostEur = sumOf([
      usage?.heating.costEur ?? null,
      usage?.hotWater.costEur ?? null,
    ]);

    if (heatPumpKwh === null) {
      return {
        key: bucket.key,
        label: bucket.label,
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd,
        heatPumpKwh: null,
        heatPumpCostEur: roundMoney(heatPumpCostEur),
        heatDeliveredKwh: emptyRange(),
        gasKwh: emptyRange(),
        gasCostEur: emptyRange(),
        savingsEur: emptyRange(),
      };
    }

    const gasPrice = timeline.weightedAmountForPeriod(
      "gas_price",
      bucket.periodStart,
      bucket.periodEnd,
    );
    const gasBaseCost =
      timeline.monthlyChargeForPeriod("gas_base_price", bucket.periodStart, bucket.periodEnd) ?? 0;

    const heatDeliveredKwh = heatRangeFromScop(heatPumpKwh, scop);
    const gasKwh = mapRange(heatDeliveredKwh, (heat) => heat / boilerEfficiency);
    const gasCostEur =
      gasPrice === null
        ? emptyRange()
        : mapRange(gasKwh, (kwh) => kwh * gasPrice + gasBaseCost);
    const savingsEur =
      heatPumpCostEur === null
        ? emptyRange()
        : mapRange(gasCostEur, (cost) => cost - heatPumpCostEur);

    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      heatPumpKwh: roundAmount(heatPumpKwh),
      heatPumpCostEur: roundMoney(heatPumpCostEur),
      heatDeliveredKwh: mapRange(heatDeliveredKwh, (value) => roundAmount(value) as number),
      gasKwh: mapRange(gasKwh, (value) => roundAmount(value) as number),
      gasCostEur: mapRange(gasCostEur, (value) => roundMoney(value) as number),
      savingsEur: mapRange(savingsEur, (value) => roundMoney(value) as number),
    };
  });

  const totalGasKwhMid = sumOf(buckets.map((bucket) => bucket.gasKwh.mid));
  const totalHeatPumpKwh = sumOf(buckets.map((bucket) => bucket.heatPumpKwh));
  const avoidedCo2Kg =
    gasCo2 !== null && totalGasKwhMid !== null
      ? roundAmount(
          totalGasKwhMid * gasCo2 -
            // The heat pump is not emission-free: its grid share still counts.
            (gridCo2 !== null && totalHeatPumpKwh !== null ? totalHeatPumpKwh * gridCo2 : 0),
        )
      : null;

  return {
    buckets,
    ...coveredPeriod(buckets, (bucket) => bucket.heatPumpKwh !== null),
    totalHeatPumpCostEur: roundMoney(sumOf(buckets.map((bucket) => bucket.heatPumpCostEur))),
    totalGasCostEur: sumRanges(buckets.map((bucket) => bucket.gasCostEur)),
    totalSavingsEur: sumRanges(buckets.map((bucket) => bucket.savingsEur)),
    avoidedCo2Kg,
    scop,
    scopRange: { low: Math.max(0, scop - SCOP_BAND), high: scop + SCOP_BAND },
    assumptions: collectAssumptions(timeline, [
      "heat_pump_scop",
      "boiler_efficiency",
      "gas_price",
      "gas_base_price",
      "gas_co2",
      "grid_co2",
    ]),
  };
}

export function buildCarComparison(
  energyBuckets: EnergyReportBucket[],
  usageBuckets: UsageCostBucket[],
  timeline: EnergyTariffTimeline,
): CarComparison | null {
  const evConsumption = timeline.amountOf("ev_consumption");
  const petrolConsumption = timeline.amountOf("petrol_consumption");
  if (evConsumption === null || evConsumption <= 0 || petrolConsumption === null) {
    return null;
  }

  const usageByKey = new Map(usageBuckets.map((bucket) => [bucket.key, bucket]));
  const petrolCo2 = timeline.amountOf("petrol_co2");
  const gridCo2 = timeline.amountOf("grid_co2");

  const buckets = energyBuckets.map((bucket): CarComparisonBucket => {
    const chargedKwh = bucket.evChargerTotal;
    const evCostEur = usageByKey.get(bucket.key)?.evCharger.costEur ?? null;
    // PV kWh spent charging could have been exported instead — that forgone
    // feed-in revenue is a real cost of charging at home, not a saving.
    const feedInPrice = timeline.weightedAmountForPeriod(
      "feed_in",
      bucket.periodStart,
      bucket.periodEnd,
    );
    const lostFeedInEur =
      feedInPrice === null || bucket.evChargerPv === null
        ? null
        : bucket.evChargerPv * feedInPrice;
    const evCostWithOpportunityEur =
      evCostEur === null ? null : evCostEur + (lostFeedInEur ?? 0);

    if (chargedKwh === null) {
      return {
        key: bucket.key,
        label: bucket.label,
        periodStart: bucket.periodStart,
        periodEnd: bucket.periodEnd,
        chargedKwh: null,
        evCostEur: roundMoney(evCostEur),
        lostFeedInEur: roundMoney(lostFeedInEur),
        evCostWithOpportunityEur: roundMoney(evCostWithOpportunityEur),
        kilometers: null,
        petrolLitres: null,
        petrolCostEur: null,
        savingsEur: null,
      };
    }

    const petrolPrice = timeline.weightedAmountForPeriod(
      "petrol_price",
      bucket.periodStart,
      bucket.periodEnd,
    );
    const kilometers = (chargedKwh / evConsumption) * 100;
    const petrolLitres = (kilometers / 100) * petrolConsumption;
    const petrolCostEur = petrolPrice === null ? null : petrolLitres * petrolPrice;

    return {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
      chargedKwh: roundAmount(chargedKwh),
      evCostEur: roundMoney(evCostEur),
      lostFeedInEur: roundMoney(lostFeedInEur),
      evCostWithOpportunityEur: roundMoney(evCostWithOpportunityEur),
      kilometers: roundAmount(kilometers, 0),
      petrolLitres: roundAmount(petrolLitres),
      petrolCostEur: roundMoney(petrolCostEur),
      savingsEur:
        petrolCostEur === null || evCostWithOpportunityEur === null
          ? null
          : roundMoney(petrolCostEur - evCostWithOpportunityEur),
    };
  });

  const totalChargedKwh = sumOf(buckets.map((bucket) => bucket.chargedKwh));
  const totalKilometers = sumOf(buckets.map((bucket) => bucket.kilometers));
  const totalEvCostEur = sumOf(buckets.map((bucket) => bucket.evCostEur));
  const totalLostFeedInEur = sumOf(buckets.map((bucket) => bucket.lostFeedInEur));
  const totalEvCostWithOpportunityEur = sumOf(
    buckets.map((bucket) => bucket.evCostWithOpportunityEur),
  );
  const totalPetrolCostEur = sumOf(buckets.map((bucket) => bucket.petrolCostEur));
  const totalPetrolLitres = sumOf(buckets.map((bucket) => bucket.petrolLitres));

  const centsPerKm = (cost: number | null) =>
    cost === null || totalKilometers === null || totalKilometers <= 0
      ? null
      : roundAmount((cost / totalKilometers) * 100, 1);

  const avoidedCo2Kg =
    petrolCo2 !== null && totalPetrolLitres !== null
      ? roundAmount(
          totalPetrolLitres * petrolCo2 -
            // Only the grid share of charging emits; PV kWh do not.
            (gridCo2 !== null
              ? (sumOf(buckets.map((bucket) => bucket.chargedKwh)) ?? 0) * gridCo2
              : 0),
        )
      : null;

  return {
    buckets,
    ...coveredPeriod(buckets, (bucket) => bucket.chargedKwh !== null),
    totalChargedKwh: roundAmount(totalChargedKwh),
    totalKilometers: roundAmount(totalKilometers, 0),
    totalEvCostEur: roundMoney(totalEvCostEur),
    totalLostFeedInEur: roundMoney(totalLostFeedInEur),
    totalEvCostWithOpportunityEur: roundMoney(totalEvCostWithOpportunityEur),
    totalPetrolCostEur: roundMoney(totalPetrolCostEur),
    totalSavingsEur:
      totalPetrolCostEur === null || totalEvCostWithOpportunityEur === null
        ? null
        : roundMoney(totalPetrolCostEur - totalEvCostWithOpportunityEur),
    evCentsPerKm: centsPerKm(totalEvCostWithOpportunityEur),
    petrolCentsPerKm: centsPerKm(totalPetrolCostEur),
    avoidedCo2Kg,
    assumptions: collectAssumptions(timeline, [
      "ev_consumption",
      "petrol_consumption",
      "petrol_price",
      "petrol_co2",
      "grid_co2",
      "feed_in",
    ]),
  };
}

export async function getComparisonsReportForUser(
  userId: number,
  granularity: ReportGranularity,
  fromDate: Date | null,
  toDate: Date | null,
): Promise<ComparisonsReport> {
  if (fromDate && toDate && fromDate >= toDate) {
    throw APIError.invalidArgument("from must be before to");
  }

  const report = await getEnergyReportForUser(userId, granularity, fromDate, toDate);
  const timeline = await loadEnergyTariffTimeline(userId);
  const usageBuckets = timeline.hasCostTariffs()
    ? report.buckets.map((bucket) => buildUsageCostBucket(bucket, timeline))
    : [];

  const heating = buildHeatingComparison(report.buckets, usageBuckets, timeline);
  const car = buildCarComparison(report.buckets, usageBuckets, timeline);

  return {
    granularity,
    currency: "EUR",
    from: fromDate?.toISOString() ?? null,
    to: toDate?.toISOString() ?? null,
    hasHeatingAssumptions: heating !== null,
    hasCarAssumptions: car !== null,
    heating,
    car,
  };
}
