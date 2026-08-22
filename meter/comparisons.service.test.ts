import { describe, expect, it } from "vitest";
import {
  buildCarComparison,
  buildHeatingComparison,
  SCOP_BAND,
} from "./comparisons.service";
import { buildUsageCostBucket } from "./economics.service";
import { EnergyTariffTimeline, type ElectricityTariff } from "./tariffs.service";
import type { EnergyReportBucket } from "./reports.service";

let nextId = 1;
function tariff(
  kind: ElectricityTariff["kind"],
  amount: number,
  unit: ElectricityTariff["unit"],
  validFrom = "2020-01-01T00:00:00.000Z",
): ElectricityTariff {
  return {
    id: nextId++,
    kind,
    validFrom,
    amount,
    unit,
    taxStatus: null,
    name: null,
    capacityLimitKw: null,
    source: null,
  };
}

function energyBucket(overrides: Partial<EnergyReportBucket> = {}): EnergyReportBucket {
  return {
    key: "2026-01",
    label: "01.2026",
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2026-02-01T00:00:00.000Z",
    coverage: 1,
    gridImport: null,
    gridExport: null,
    production: null,
    selfConsumption: null,
    totalConsumption: null,
    consumptionWithoutHeatPumpAndEv: null,
    autarky: null,
    selfConsumptionRate: null,
    heatPumpTotal: null,
    heatHeatingTotal: null,
    heatHeatingPv: null,
    heatHeatingGrid: null,
    heatHeatingPvShare: null,
    hotWaterTotal: null,
    hotWaterPv: null,
    hotWaterGrid: null,
    hotWaterPvShare: null,
    evChargerTotal: null,
    evChargerPv: null,
    evChargerGrid: null,
    evChargerPvShare: null,
    costs: null,
    ...overrides,
  };
}

/** Grid 0.40 €/kWh, gas 0.10 €/kWh, SCOP 4, boiler efficiency 0.9. */
function heatingTimeline(extra: ElectricityTariff[] = []) {
  return new EnergyTariffTimeline([
    tariff("grid_import", 0.4, "eur_per_kwh"),
    tariff("self_consumption_value", 0.2, "eur_per_kwh"),
    tariff("heat_pump_scop", 4, "ratio"),
    tariff("boiler_efficiency", 0.9, "ratio"),
    tariff("gas_price", 0.1, "eur_per_kwh"),
    ...extra,
  ]);
}

function carTimeline(extra: ElectricityTariff[] = []) {
  return new EnergyTariffTimeline([
    tariff("grid_import", 0.4, "eur_per_kwh"),
    tariff("self_consumption_value", 0.2, "eur_per_kwh"),
    tariff("ev_consumption", 20, "kwh_per_100km"),
    tariff("petrol_consumption", 7, "l_per_100km"),
    tariff("petrol_price", 1.8, "eur_per_l"),
    ...extra,
  ]);
}

function withUsage(bucket: EnergyReportBucket, timeline: EnergyTariffTimeline) {
  return [buildUsageCostBucket(bucket, timeline)];
}

describe("buildHeatingComparison", () => {
  const bucket = energyBucket({
    heatHeatingTotal: 800,
    heatHeatingPv: 0,
    heatHeatingGrid: 800,
    hotWaterTotal: 200,
    hotWaterPv: 0,
    hotWaterGrid: 200,
  });

  it("derives gas demand from the electricity via SCOP and boiler efficiency", () => {
    const timeline = heatingTimeline();
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // 1000 kWh electricity × SCOP 4 = 4000 kWh heat; ÷ 0.9 = 4444.4 kWh gas.
    expect(result.buckets[0].heatDeliveredKwh.mid).toBe(4000);
    expect(result.buckets[0].gasKwh.mid).toBeCloseTo(4444.4, 0);
  });

  it("reports a range over the SCOP uncertainty instead of a single figure", () => {
    const timeline = heatingTimeline();
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    expect(result.scopRange).toEqual({ low: 4 - SCOP_BAND, high: 4 + SCOP_BAND });
    // A lower SCOP means less heat delivered, so less gas would replace it.
    expect(result.buckets[0].gasKwh.low).toBeLessThan(result.buckets[0].gasKwh.mid!);
    expect(result.buckets[0].gasKwh.high).toBeGreaterThan(result.buckets[0].gasKwh.mid!);
  });

  it("compares the gas cost with what the heat pump actually cost", () => {
    const timeline = heatingTimeline();
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // 1000 kWh from the grid at 0.40 € = 400 €.
    expect(result.totalHeatPumpCostEur).toBe(400);
    // 4444.4 kWh gas at 0.10 € = 444.44 €.
    expect(result.totalGasCostEur.mid).toBeCloseTo(444.44, 1);
    expect(result.totalSavingsEur.mid).toBeCloseTo(44.44, 1);
  });

  it("adds the gas standing charge to the counterfactual cost", () => {
    const timeline = heatingTimeline([tariff("gas_base_price", 15, "eur_per_month")]);
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    expect(result.totalGasCostEur.mid).toBeCloseTo(444.44 + 15, 1);
  });

  it("counts the grid share of the heat pump against the avoided emissions", () => {
    const timeline = heatingTimeline([
      tariff("gas_co2", 0.2, "kg_per_kwh"),
      tariff("grid_co2", 0.4, "kg_per_kwh"),
    ]);
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // Gas 4444.4 × 0.2 = 888.9 kg, heat pump 1000 × 0.4 = 400 kg.
    expect(result.avoidedCo2Kg).toBeCloseTo(488.9, 0);
  });

  it("returns the assumptions it used", () => {
    const timeline = heatingTimeline();
    const result = buildHeatingComparison([bucket], withUsage(bucket, timeline), timeline)!;

    expect(result.assumptions.map((a) => a.kind)).toEqual([
      "heat_pump_scop",
      "boiler_efficiency",
      "gas_price",
    ]);
    expect(result.assumptions[0]).toMatchObject({ amount: 4, unit: "ratio" });
  });

  it("gives no comparison at all when the SCOP is missing", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("boiler_efficiency", 0.9, "ratio"),
      tariff("gas_price", 0.1, "eur_per_kwh"),
    ]);

    expect(buildHeatingComparison([bucket], [], timeline)).toBeNull();
  });

  it("leaves periods without heat pump readings empty", () => {
    const timeline = heatingTimeline();
    const empty = energyBucket();
    const result = buildHeatingComparison([empty], withUsage(empty, timeline), timeline)!;

    expect(result.buckets[0].heatPumpKwh).toBeNull();
    expect(result.buckets[0].gasCostEur.mid).toBeNull();
  });

  it("reports the span actually covered by heat pump readings, not empty periods", () => {
    const timeline = heatingTimeline();
    const empty = energyBucket({ key: "2025-12", periodStart: "2025-12-01T00:00:00.000Z", periodEnd: "2026-01-01T00:00:00.000Z" });
    const result = buildHeatingComparison(
      [empty, bucket],
      [...withUsage(empty, timeline), ...withUsage(bucket, timeline)],
      timeline,
    )!;

    expect(result.periodStart).toBe(bucket.periodStart);
    expect(result.periodEnd).toBe(bucket.periodEnd);
  });
});

describe("buildCarComparison", () => {
  const bucket = energyBucket({
    evChargerTotal: 200,
    evChargerPv: 0,
    evChargerGrid: 200,
  });

  it("converts charged kWh into kilometres and the petrol they replace", () => {
    const timeline = carTimeline();
    const result = buildCarComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // 200 kWh at 20 kWh/100 km = 1000 km; at 7 l/100 km = 70 l.
    expect(result.totalKilometers).toBe(1000);
    expect(result.buckets[0].petrolLitres).toBe(70);
    // 70 l × 1.80 € = 126 €.
    expect(result.totalPetrolCostEur).toBe(126);
  });

  it("compares against what the charging actually cost", () => {
    const timeline = carTimeline();
    const result = buildCarComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // 200 kWh from the grid at 0.40 € = 80 €.
    expect(result.totalEvCostEur).toBe(80);
    expect(result.totalSavingsEur).toBe(46);
  });

  it("values PV-charged kWh lower, which widens the gap to petrol", () => {
    const pvBucket = energyBucket({
      evChargerTotal: 200,
      evChargerPv: 200,
      evChargerGrid: 0,
    });
    const timeline = carTimeline();
    const result = buildCarComparison([pvBucket], withUsage(pvBucket, timeline), timeline)!;

    // 200 kWh self-consumed at 0.20 € = 40 €.
    expect(result.totalEvCostEur).toBe(40);
    expect(result.totalSavingsEur).toBe(86);
  });

  it("reports cost per kilometre for both variants", () => {
    const timeline = carTimeline();
    const result = buildCarComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // 80 € over 1000 km = 8 ct/km; 126 € = 12.6 ct/km.
    expect(result.evCentsPerKm).toBe(8);
    expect(result.petrolCentsPerKm).toBe(12.6);
  });

  it("counts the grid share of charging against the avoided emissions", () => {
    const timeline = carTimeline([
      tariff("petrol_co2", 2.37, "kg_per_l"),
      tariff("grid_co2", 0.4, "kg_per_kwh"),
    ]);
    const result = buildCarComparison([bucket], withUsage(bucket, timeline), timeline)!;

    // Petrol 70 l × 2.37 = 165.9 kg, charging 200 kWh × 0.4 = 80 kg.
    expect(result.avoidedCo2Kg).toBeCloseTo(85.9, 1);
  });

  it("gives no comparison when the EV consumption is missing", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("petrol_consumption", 7, "l_per_100km"),
      tariff("petrol_price", 1.8, "eur_per_l"),
    ]);

    expect(buildCarComparison([bucket], [], timeline)).toBeNull();
  });

  it("still reports kilometres when no petrol price is known", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("ev_consumption", 20, "kwh_per_100km"),
      tariff("petrol_consumption", 7, "l_per_100km"),
    ]);
    const result = buildCarComparison([bucket], withUsage(bucket, timeline), timeline)!;

    expect(result.totalKilometers).toBe(1000);
    expect(result.totalPetrolCostEur).toBeNull();
    expect(result.totalSavingsEur).toBeNull();
  });

  it("counts the forgone feed-in revenue on the PV share as part of the true charging cost", () => {
    const pvBucket = energyBucket({
      evChargerTotal: 200,
      evChargerPv: 200,
      evChargerGrid: 0,
    });
    const timeline = carTimeline([tariff("feed_in", 0.08, "eur_per_kwh")]);
    const result = buildCarComparison([pvBucket], withUsage(pvBucket, timeline), timeline)!;

    // 200 kWh self-consumed at 0.20 € = 40 € metered cost.
    expect(result.totalEvCostEur).toBe(40);
    // Same 200 kWh could have been exported at 0.08 €/kWh = 16 € forgone.
    expect(result.totalLostFeedInEur).toBe(16);
    expect(result.totalEvCostWithOpportunityEur).toBe(56);
    // Savings and ct/km follow the opportunity-adjusted cost, not the raw one.
    expect(result.totalSavingsEur).toBe(70);
    expect(result.evCentsPerKm).toBe(5.6);
  });

  it("leaves the forgone feed-in revenue null without a feed-in tariff", () => {
    const pvBucket = energyBucket({
      evChargerTotal: 200,
      evChargerPv: 200,
      evChargerGrid: 0,
    });
    const timeline = carTimeline();
    const result = buildCarComparison([pvBucket], withUsage(pvBucket, timeline), timeline)!;

    expect(result.totalLostFeedInEur).toBeNull();
    // Falls back to the metered cost alone rather than losing the whole figure.
    expect(result.totalEvCostWithOpportunityEur).toBe(result.totalEvCostEur);
  });

  it("only charges the forgone feed-in revenue against the PV share, not the grid share", () => {
    const mixedBucket = energyBucket({
      evChargerTotal: 200,
      evChargerPv: 50,
      evChargerGrid: 150,
    });
    const timeline = carTimeline([tariff("feed_in", 0.08, "eur_per_kwh")]);
    const result = buildCarComparison([mixedBucket], withUsage(mixedBucket, timeline), timeline)!;

    // Only the 50 PV kWh could have been exported: 50 × 0.08 € = 4 €.
    expect(result.totalLostFeedInEur).toBe(4);
  });

  it("reports the span actually covered by charging activity", () => {
    const timeline = carTimeline();
    const empty = energyBucket({ key: "2025-12", periodStart: "2025-12-01T00:00:00.000Z", periodEnd: "2026-01-01T00:00:00.000Z" });
    const result = buildCarComparison(
      [empty, bucket],
      [...withUsage(empty, timeline), ...withUsage(bucket, timeline)],
      timeline,
    )!;

    expect(result.periodStart).toBe(bucket.periodStart);
    expect(result.periodEnd).toBe(bucket.periodEnd);
  });

  it("reports no covered span when nothing was charged", () => {
    const timeline = carTimeline();
    const empty = energyBucket();
    const result = buildCarComparison([empty], withUsage(empty, timeline), timeline)!;

    expect(result.periodStart).toBeNull();
    expect(result.periodEnd).toBeNull();
  });
});
