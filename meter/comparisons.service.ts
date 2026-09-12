/**
 * Utility meters — counterfactual technology comparisons (Issue #792, Etappe 6d).
 *
 * "What would a gas boiler have cost instead of the heat pump?" and "what
 * would a petrol car have cost instead of charging at the wallbox?" These are
 * model calculations, not measurements: only the electricity side is metered,
 * the other side is derived from assumptions.
 *
 * Valuation of the metered electricity, the same for both comparisons: the
 * grid share at the work price in force, the PV share at the feed-in tariff
 * of the period — that is what the kWh would have earned had the heat pump or
 * the car not used it, so it is the true incremental cost of the use. Without
 * a feed-in tariff the PV share is valued at the self-consumption value (or
 * the grid price). Valuing the PV share at the self-consumption value *and*
 * adding the forgone feed-in on top would price the same kWh twice; doing it
 * for the car but not the heat pump would tilt the two comparisons against
 * each other. Both were the case once and are the reason this is spelled out.
 *
 * Every response carries the assumptions it used, dated, so the UI can show
 * them and the reader can judge the number. Assumptions are read at the
 * period they apply to (`amountAt`), prices time-weighted over the period.
 * The heat-pump comparison is reported as a **range** over SCOP ± SCOP_BAND
 * rather than a single figure — without a heat meter the seasonal performance
 * factor is an estimate. It is a one-parameter band: boiler efficiency and
 * gas price enter as single values.
 *
 * Headline totals are formed over the periods where *both* sides are known
 * (`compared`), so the difference shown is the difference of the two figures
 * next to it.
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
  /** From when this value applied; several entries of one kind form a series. */
  validFrom: string;
}

/** A figure with the range that the SCOP uncertainty spans. */
export interface CostRange {
  low: number | null;
  mid: number | null;
  high: number | null;
}

/** Where the heat pump's electricity figure comes from. */
export type HeatSource =
  /** Heating and hot water sub-meters. */
  | "sub_meters"
  /** The whole-pump meter; no PV split is metered. */
  | "heat_pump_total"
  /** Only the heating sub-meter — hot water is missing from the comparison. */
  | "heating_only"
  /** Only the hot-water sub-meter — heating is missing from the comparison. */
  | "hot_water_only";

export interface HeatingComparisonBucket {
  key: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Electricity of the heat pump (heating + hot water). */
  heatPumpKwh: number | null;
  /** PV share of it; null when no PV sub-meter exists. */
  heatPumpPvKwh: number | null;
  heatPumpGridKwh: number | null;
  /** Grid share at the work price, PV share at the feed-in tariff. */
  heatPumpCostEur: number | null;
  /** Heat the pump delivered: electricity × SCOP, as a range. */
  heatDeliveredKwh: CostRange;
  /** Gas a boiler would have burnt for that heat. */
  gasKwh: CostRange;
  gasCostEur: CostRange;
  /** Positive = the heat pump was cheaper. */
  savingsEur: CostRange;
  /** Gas emissions avoided minus the emissions of the grid share. */
  avoidedCo2Kg: CostRange;
  /** Both sides known — only these feed the totals. */
  compared: boolean;
}

export interface HeatingComparison {
  buckets: HeatingComparisonBucket[];
  /** Span of the compared periods; null if none. */
  periodStart: string | null;
  periodEnd: string | null;
  comparedPeriods: number;
  heatSource: HeatSource | null;
  totalHeatPumpKwh: number | null;
  totalHeatPumpCostEur: number | null;
  totalGasCostEur: CostRange;
  totalSavingsEur: CostRange;
  avoidedCo2Kg: number | null;
  avoidedCo2Range: CostRange;
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
  chargedPvKwh: number | null;
  chargedGridKwh: number | null;
  /** Grid share at the work price, PV share at the feed-in tariff. */
  evCostEur: number | null;
  /** From the charged kWh after charging losses. */
  kilometers: number | null;
  petrolLitres: number | null;
  petrolCostEur: number | null;
  /** Positive = the EV was cheaper. */
  savingsEur: number | null;
  avoidedCo2Kg: number | null;
  compared: boolean;
}

export interface CarComparison {
  buckets: CarComparisonBucket[];
  periodStart: string | null;
  periodEnd: string | null;
  comparedPeriods: number;
  totalChargedKwh: number | null;
  totalKilometers: number | null;
  totalEvCostEur: number | null;
  totalPetrolCostEur: number | null;
  totalSavingsEur: number | null;
  evCentsPerKm: number | null;
  petrolCentsPerKm: number | null;
  avoidedCo2Kg: number | null;
  /** Share of the wallbox reading lost before the battery, as used. */
  chargingLoss: number;
  assumptions: ComparisonAssumption[];
}

export interface ComparisonsReport {
  granularity: ReportGranularity;
  currency: "EUR";
  from: string | null;
  to: string | null;
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
  ev_charging_loss: "Ladeverluste",
  grid_co2: "CO₂-Faktor Netzstrom",
  gas_co2: "CO₂-Faktor Erdgas",
  petrol_co2: "CO₂-Faktor Benzin",
  grid_import: "Arbeitspreis Netzbezug",
  feed_in: "Einspeisevergütung",
  self_consumption_value: "Eigenverbrauchswert",
};

const ASSUMPTION_UNITS: Partial<Record<ElectricityTariffKind, ElectricityTariffUnit>> = {
  gas_price: "eur_per_kwh",
  gas_base_price: "eur_per_month",
  boiler_efficiency: "ratio",
  heat_pump_scop: "ratio",
  ev_consumption: "kwh_per_100km",
  petrol_consumption: "l_per_100km",
  petrol_price: "eur_per_l",
  ev_charging_loss: "ratio",
  grid_co2: "kg_per_kwh",
  gas_co2: "kg_per_kwh",
  petrol_co2: "kg_per_l",
  grid_import: "eur_per_kwh",
  feed_in: "eur_per_kwh",
  self_consumption_value: "eur_per_kwh",
};

/** Every dated entry of the given kinds the compared span drew on. */
function collectAssumptions(
  timeline: EnergyTariffTimeline,
  kinds: ElectricityTariffKind[],
  periodStart: string | null,
  periodEnd: string | null,
): ComparisonAssumption[] {
  const result: ComparisonAssumption[] = [];
  for (const kind of kinds) {
    const entries =
      periodStart && periodEnd
        ? timeline.entriesForPeriod(kind, periodStart, periodEnd)
        : timeline.entriesForPeriod(kind, "1900-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z");
    for (const entry of entries) {
      result.push({
        kind,
        label: ASSUMPTION_LABELS[kind] ?? kind,
        amount: entry.amount,
        unit: entry.unit ?? ASSUMPTION_UNITS[kind] ?? "eur",
        validFrom: entry.validFrom,
      });
    }
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

function roundRange(range: CostRange, round: (v: number | null) => number | null): CostRange {
  return { low: round(range.low), mid: round(range.mid), high: round(range.high) };
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

/** Span of the periods that carry a value. */
function coveredPeriod<T extends { periodStart: string; periodEnd: string }>(
  buckets: T[],
): { periodStart: string | null; periodEnd: string | null } {
  if (buckets.length === 0) return { periodStart: null, periodEnd: null };
  return { periodStart: buckets[0].periodStart, periodEnd: buckets[buckets.length - 1].periodEnd };
}

/**
 * A low SCOP means the heat pump delivered less heat per kWh, so the boiler
 * replacing it burns less gas — the *low* SCOP therefore yields the *low* gas
 * figure. Measured is the electricity; the heat is the estimate, and the band
 * is the uncertainty of that estimate.
 */
function heatRangeFromScop(electricityKwh: number, scop: number): CostRange {
  return {
    low: electricityKwh * Math.max(0, scop - SCOP_BAND),
    mid: electricityKwh * scop,
    high: electricityKwh * (scop + SCOP_BAND),
  };
}

/** Grid share at the work price, PV share at what it would have earned exported. */
function electricityCost(
  timeline: EnergyTariffTimeline,
  bucket: { periodStart: string; periodEnd: string },
  gridKwh: number,
  pvKwh: number,
): number | null {
  const prices = timeline.pricesForPeriod(bucket.periodStart, bucket.periodEnd);
  if (prices.gridImportPricePerKwh === null) return null;
  const pvValue = prices.feedInPricePerKwh ?? prices.selfConsumptionPricePerKwh ?? prices.gridImportPricePerKwh;
  return gridKwh * prices.gridImportPricePerKwh + pvKwh * pvValue;
}

/** Electricity of the heat pump in a period, from whatever meters exist. */
function heatPumpElectricity(
  bucket: EnergyReportBucket,
): { total: number; pv: number | null; source: HeatSource } | null {
  const heating = bucket.heatHeatingTotal;
  const hotWater = bucket.hotWaterTotal;
  const pvOf = (total: number | null, pv: number | null) =>
    total === null ? null : pv === null ? null : Math.min(pv, total);
  if (heating !== null && hotWater !== null) {
    const heatingPv = pvOf(heating, bucket.heatHeatingPv);
    const hotWaterPv = pvOf(hotWater, bucket.hotWaterPv);
    return {
      total: heating + hotWater,
      pv: heatingPv === null && hotWaterPv === null ? null : (heatingPv ?? 0) + (hotWaterPv ?? 0),
      source: "sub_meters",
    };
  }
  if (bucket.heatPumpTotal !== null) {
    return { total: bucket.heatPumpTotal, pv: null, source: "heat_pump_total" };
  }
  if (heating !== null) {
    return { total: heating, pv: pvOf(heating, bucket.heatHeatingPv), source: "heating_only" };
  }
  if (hotWater !== null) {
    return { total: hotWater, pv: pvOf(hotWater, bucket.hotWaterPv), source: "hot_water_only" };
  }
  return null;
}

export function buildHeatingComparison(
  energyBuckets: EnergyReportBucket[],
  timeline: EnergyTariffTimeline,
): HeatingComparison | null {
  const scopNow = timeline.amountOf("heat_pump_scop");
  const boilerNow = timeline.amountOf("boiler_efficiency");
  if (scopNow === null || scopNow <= 0 || boilerNow === null || boilerNow <= 0) {
    return null;
  }

  let heatSource: HeatSource | null = null;
  const buckets = energyBuckets.map((bucket): HeatingComparisonBucket => {
    const base = {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
    };
    const electricity = heatPumpElectricity(bucket);
    if (!electricity) {
      return {
        ...base,
        heatPumpKwh: null,
        heatPumpPvKwh: null,
        heatPumpGridKwh: null,
        heatPumpCostEur: null,
        heatDeliveredKwh: emptyRange(),
        gasKwh: emptyRange(),
        gasCostEur: emptyRange(),
        savingsEur: emptyRange(),
        avoidedCo2Kg: emptyRange(),
        compared: false,
      };
    }
    heatSource ??= electricity.source;

    const pvKwh = electricity.pv ?? 0;
    const gridKwh = Math.max(0, electricity.total - pvKwh);
    const heatPumpCostEur = electricityCost(timeline, bucket, gridKwh, pvKwh);

    const scop = timeline.amountAt("heat_pump_scop", bucket.periodStart) ?? scopNow;
    const boilerEfficiency = timeline.amountAt("boiler_efficiency", bucket.periodStart) ?? boilerNow;
    const gasPrice = timeline.weightedAmountForPeriod("gas_price", bucket.periodStart, bucket.periodEnd);
    const gasBaseCost =
      timeline.monthlyChargeForPeriod("gas_base_price", bucket.periodStart, bucket.periodEnd) ?? 0;

    const heatDeliveredKwh = heatRangeFromScop(electricity.total, scop);
    const gasKwh = mapRange(heatDeliveredKwh, (heat) => heat / boilerEfficiency);
    const gasCostEur =
      gasPrice === null ? emptyRange() : mapRange(gasKwh, (kwh) => kwh * gasPrice + gasBaseCost);
    const savingsEur =
      heatPumpCostEur === null ? emptyRange() : mapRange(gasCostEur, (cost) => cost - heatPumpCostEur);

    // Only the grid share of the heat pump emits; PV kWh do not. Without a
    // grid factor the balance is not formed rather than pretending the grid
    // share is clean.
    const gasCo2 = timeline.amountAt("gas_co2", bucket.periodStart);
    const gridCo2 = timeline.amountAt("grid_co2", bucket.periodStart);
    const avoidedCo2Kg =
      gasCo2 === null || gridCo2 === null
        ? emptyRange()
        : mapRange(gasKwh, (kwh) => kwh * gasCo2 - gridKwh * gridCo2);

    return {
      ...base,
      heatPumpKwh: roundAmount(electricity.total),
      heatPumpPvKwh: electricity.pv === null ? null : roundAmount(pvKwh),
      heatPumpGridKwh: roundAmount(gridKwh),
      heatPumpCostEur: roundMoney(heatPumpCostEur),
      heatDeliveredKwh: roundRange(heatDeliveredKwh, roundAmount),
      gasKwh: roundRange(gasKwh, roundAmount),
      gasCostEur: roundRange(gasCostEur, roundMoney),
      savingsEur: roundRange(savingsEur, roundMoney),
      avoidedCo2Kg: roundRange(avoidedCo2Kg, roundAmount),
      compared: savingsEur.mid !== null,
    };
  });

  const compared = buckets.filter((bucket) => bucket.compared);
  const span = coveredPeriod(compared);
  const avoidedCo2Range = sumRanges(compared.map((bucket) => bucket.avoidedCo2Kg));

  return {
    buckets,
    ...span,
    comparedPeriods: compared.length,
    heatSource,
    totalHeatPumpKwh: roundAmount(sumOf(compared.map((bucket) => bucket.heatPumpKwh))),
    totalHeatPumpCostEur: roundMoney(sumOf(compared.map((bucket) => bucket.heatPumpCostEur))),
    totalGasCostEur: sumRanges(compared.map((bucket) => bucket.gasCostEur)),
    totalSavingsEur: sumRanges(compared.map((bucket) => bucket.savingsEur)),
    avoidedCo2Kg: roundAmount(avoidedCo2Range.mid),
    avoidedCo2Range: roundRange(avoidedCo2Range, roundAmount),
    scop: scopNow,
    scopRange: { low: Math.max(0, scopNow - SCOP_BAND), high: scopNow + SCOP_BAND },
    assumptions: collectAssumptions(
      timeline,
      [
        "heat_pump_scop",
        "boiler_efficiency",
        "gas_price",
        "gas_base_price",
        "grid_import",
        "feed_in",
        "self_consumption_value",
        "gas_co2",
        "grid_co2",
      ],
      span.periodStart,
      span.periodEnd,
    ),
  };
}

export function buildCarComparison(
  energyBuckets: EnergyReportBucket[],
  timeline: EnergyTariffTimeline,
): CarComparison | null {
  const evConsumptionNow = timeline.amountOf("ev_consumption");
  const petrolConsumptionNow = timeline.amountOf("petrol_consumption");
  if (
    evConsumptionNow === null ||
    evConsumptionNow <= 0 ||
    petrolConsumptionNow === null ||
    petrolConsumptionNow <= 0
  ) {
    return null;
  }
  const chargingLossNow = timeline.amountOf("ev_charging_loss") ?? 0;

  const buckets = energyBuckets.map((bucket): CarComparisonBucket => {
    const base = {
      key: bucket.key,
      label: bucket.label,
      periodStart: bucket.periodStart,
      periodEnd: bucket.periodEnd,
    };
    const chargedKwh = bucket.evChargerTotal;
    if (chargedKwh === null) {
      return {
        ...base,
        chargedKwh: null,
        chargedPvKwh: null,
        chargedGridKwh: null,
        evCostEur: null,
        kilometers: null,
        petrolLitres: null,
        petrolCostEur: null,
        savingsEur: null,
        avoidedCo2Kg: null,
        compared: false,
      };
    }
    const pvKwh = bucket.evChargerPv === null ? 0 : Math.min(bucket.evChargerPv, chargedKwh);
    const gridKwh = Math.max(0, chargedKwh - pvKwh);
    const evCostEur = electricityCost(timeline, bucket, gridKwh, pvKwh);

    const evConsumption = timeline.amountAt("ev_consumption", bucket.periodStart) ?? evConsumptionNow;
    const petrolConsumption =
      timeline.amountAt("petrol_consumption", bucket.periodStart) ?? petrolConsumptionNow;
    const chargingLoss = Math.min(
      0.9,
      Math.max(0, timeline.amountAt("ev_charging_loss", bucket.periodStart) ?? chargingLossNow),
    );
    const petrolPrice = timeline.weightedAmountForPeriod("petrol_price", bucket.periodStart, bucket.periodEnd);

    // The wallbox meter sits before the charger; what the battery keeps is less.
    const kilometers = (chargedKwh * (1 - chargingLoss)) / evConsumption * 100;
    const petrolLitres = (kilometers / 100) * petrolConsumption;
    const petrolCostEur = petrolPrice === null ? null : petrolLitres * petrolPrice;
    const savingsEur =
      petrolCostEur === null || evCostEur === null ? null : petrolCostEur - evCostEur;

    const petrolCo2 = timeline.amountAt("petrol_co2", bucket.periodStart);
    const gridCo2 = timeline.amountAt("grid_co2", bucket.periodStart);
    const avoidedCo2Kg =
      petrolCo2 === null || gridCo2 === null ? null : petrolLitres * petrolCo2 - gridKwh * gridCo2;

    return {
      ...base,
      chargedKwh: roundAmount(chargedKwh),
      chargedPvKwh: bucket.evChargerPv === null ? null : roundAmount(pvKwh),
      chargedGridKwh: roundAmount(gridKwh),
      evCostEur: roundMoney(evCostEur),
      kilometers: roundAmount(kilometers, 0),
      petrolLitres: roundAmount(petrolLitres),
      petrolCostEur: roundMoney(petrolCostEur),
      savingsEur: roundMoney(savingsEur),
      avoidedCo2Kg: roundAmount(avoidedCo2Kg),
      compared: savingsEur !== null,
    };
  });

  const compared = buckets.filter((bucket) => bucket.compared);
  const span = coveredPeriod(compared);
  const totalKilometers = sumOf(compared.map((bucket) => bucket.kilometers));
  const totalEvCostEur = sumOf(compared.map((bucket) => bucket.evCostEur));
  const totalPetrolCostEur = sumOf(compared.map((bucket) => bucket.petrolCostEur));
  const centsPerKm = (cost: number | null) =>
    cost === null || totalKilometers === null || totalKilometers <= 0
      ? null
      : roundAmount((cost / totalKilometers) * 100, 1);

  return {
    buckets,
    ...span,
    comparedPeriods: compared.length,
    totalChargedKwh: roundAmount(sumOf(compared.map((bucket) => bucket.chargedKwh))),
    totalKilometers: roundAmount(totalKilometers, 0),
    totalEvCostEur: roundMoney(totalEvCostEur),
    totalPetrolCostEur: roundMoney(totalPetrolCostEur),
    totalSavingsEur: roundMoney(sumOf(compared.map((bucket) => bucket.savingsEur))),
    evCentsPerKm: centsPerKm(totalEvCostEur),
    petrolCentsPerKm: centsPerKm(totalPetrolCostEur),
    avoidedCo2Kg: roundAmount(sumOf(compared.map((bucket) => bucket.avoidedCo2Kg))),
    chargingLoss: chargingLossNow,
    assumptions: collectAssumptions(
      timeline,
      [
        "ev_consumption",
        "petrol_consumption",
        "petrol_price",
        "ev_charging_loss",
        "grid_import",
        "feed_in",
        "self_consumption_value",
        "petrol_co2",
        "grid_co2",
      ],
      span.periodStart,
      span.periodEnd,
    ),
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
  // Only fully measured periods: a half-metered month against a full month
  // of gas standing charge would tilt every figure.
  const buckets = report.buckets.filter((bucket) => bucket.complete);

  const heating = timeline.hasCostTariffs() ? buildHeatingComparison(buckets, timeline) : null;
  const car = timeline.hasCostTariffs() ? buildCarComparison(buckets, timeline) : null;

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
