import { describe, expect, it } from "vitest";
import { buildCarComparison, buildHeatingComparison, SCOP_BAND } from "./comparisons.service";
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
    complete: true,
    warnings: [],
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

const february = (overrides: Partial<EnergyReportBucket> = {}) =>
  energyBucket({
    key: "2026-02",
    label: "02.2026",
    periodStart: "2026-02-01T00:00:00.000Z",
    periodEnd: "2026-03-01T00:00:00.000Z",
    ...overrides,
  });

/** Grid 0.40 €/kWh, self-consumption value 0.20, gas 0.10 €/kWh, SCOP 4, boiler efficiency 0.9. */
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

/** Grid 0.40 €/kWh, self-consumption value 0.20, EV 20 kWh/100 km, petrol 7 l/100 km at 1.80 €. */
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

describe("buildHeatingComparison", () => {
  const gridOnly = energyBucket({
    heatHeatingTotal: 800,
    heatHeatingPv: 0,
    heatHeatingGrid: 800,
    hotWaterTotal: 200,
    hotWaterPv: 0,
    hotWaterGrid: 200,
  });
  const allPv = energyBucket({
    heatHeatingTotal: 800,
    heatHeatingPv: 800,
    heatHeatingGrid: 0,
    hotWaterTotal: 200,
    hotWaterPv: 200,
    hotWaterGrid: 0,
  });

  it("derives gas demand from the electricity via SCOP and boiler efficiency", () => {
    const result = buildHeatingComparison([gridOnly], heatingTimeline())!;
    // 1000 kWh electricity × SCOP 4 = 4000 kWh heat; ÷ 0.9 = 4444.4 kWh gas.
    expect(result.buckets[0].heatDeliveredKwh.mid).toBe(4000);
    expect(result.buckets[0].gasKwh.mid).toBeCloseTo(4444.4, 0);
    expect(result.heatSource).toBe("sub_meters");
  });

  it("reports a range over the SCOP uncertainty instead of a single figure", () => {
    const result = buildHeatingComparison([gridOnly], heatingTimeline())!;
    expect(result.scopRange).toEqual({ low: 4 - SCOP_BAND, high: 4 + SCOP_BAND });
    expect(result.buckets[0].gasKwh.low).toBeLessThan(result.buckets[0].gasKwh.mid!);
    expect(result.buckets[0].gasKwh.high).toBeGreaterThan(result.buckets[0].gasKwh.mid!);
  });

  it("compares the gas cost with what the heat pump's grid electricity cost", () => {
    const result = buildHeatingComparison([gridOnly], heatingTimeline())!;
    expect(result.totalHeatPumpCostEur).toBe(400);
    expect(result.totalGasCostEur.mid).toBeCloseTo(444.44, 1);
    expect(result.totalSavingsEur.mid).toBeCloseTo(44.44, 1);
  });

  it("values the PV share at the feed-in tariff it would have earned, not at the self-consumption value", () => {
    const withFeedIn = buildHeatingComparison([allPv], heatingTimeline([tariff("feed_in", 0.08, "eur_per_kwh")]))!;
    expect(withFeedIn.totalHeatPumpCostEur).toBe(80);
    // Without a feed-in tariff the self-consumption value is the fallback.
    const withoutFeedIn = buildHeatingComparison([allPv], heatingTimeline())!;
    expect(withoutFeedIn.totalHeatPumpCostEur).toBe(200);
  });

  it("adds the gas standing charge to the counterfactual cost", () => {
    const timeline = heatingTimeline([tariff("gas_base_price", 15, "eur_per_month")]);
    const result = buildHeatingComparison([gridOnly], timeline)!;
    expect(result.totalGasCostEur.mid).toBeCloseTo(444.44 + 15, 1);
  });

  it("counts only the grid share of the heat pump against the avoided emissions", () => {
    const factors = [tariff("gas_co2", 0.2, "kg_per_kwh"), tariff("grid_co2", 0.4, "kg_per_kwh")];
    // Grid-fed: 4444.4 × 0.2 − 1000 × 0.4 = 488.9 kg.
    expect(buildHeatingComparison([gridOnly], heatingTimeline(factors))!.avoidedCo2Kg).toBeCloseTo(488.9, 0);
    // PV-fed: nothing to subtract → 888.9 kg.
    const pv = buildHeatingComparison([allPv], heatingTimeline(factors))!;
    expect(pv.avoidedCo2Kg).toBeCloseTo(888.9, 0);
    expect(pv.avoidedCo2Range.low).toBeLessThan(pv.avoidedCo2Range.mid!);
  });

  it("gives no CO₂ balance without a grid factor rather than treating the grid share as clean", () => {
    const result = buildHeatingComparison([gridOnly], heatingTimeline([tariff("gas_co2", 0.2, "kg_per_kwh")]))!;
    expect(result.avoidedCo2Kg).toBeNull();
  });

  it("returns the dated assumptions it used, prices included", () => {
    const timeline = heatingTimeline([
      tariff("gas_price", 0.2, "eur_per_kwh", "2026-01-15T00:00:00.000Z"),
      tariff("gas_price", 0.3, "eur_per_kwh", "2028-01-01T00:00:00.000Z"),
    ]);
    const result = buildHeatingComparison([gridOnly], timeline)!;
    const gas = result.assumptions.filter((a) => a.kind === "gas_price");
    expect(gas.map((a) => [a.amount, a.validFrom.slice(0, 10)])).toEqual([
      [0.1, "2020-01-01"],
      [0.2, "2026-01-15"],
    ]);
    expect(result.assumptions.some((a) => a.kind === "grid_import")).toBe(true);
    // The bucket itself used the day-weighted mix of the two prices.
    expect(result.buckets[0].gasCostEur.mid).toBeCloseTo(4444.4 * ((0.1 * 14 + 0.2 * 17) / 31), 0);
  });

  it("gives no comparison at all when the SCOP is missing", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("boiler_efficiency", 0.9, "ratio"),
      tariff("gas_price", 0.1, "eur_per_kwh"),
    ]);
    expect(buildHeatingComparison([gridOnly], timeline)).toBeNull();
  });

  it("does not let a future-dated SCOP rewrite an earlier period", () => {
    const timeline = heatingTimeline([tariff("heat_pump_scop", 6, "ratio", "2030-01-01T00:00:00.000Z")]);
    const result = buildHeatingComparison([gridOnly], timeline)!;
    expect(result.buckets[0].heatDeliveredKwh.mid).toBe(4000);
  });

  it("falls back to the whole-pump meter when there are no sub-meters", () => {
    const wholePump = energyBucket({ heatPumpTotal: 1000 });
    const result = buildHeatingComparison([wholePump], heatingTimeline())!;
    expect(result.heatSource).toBe("heat_pump_total");
    expect(result.totalHeatPumpCostEur).toBe(400);
    expect(result.buckets[0].heatPumpPvKwh).toBeNull();
  });

  it("names a comparison built from a single sub-meter as partial", () => {
    const heatingOnly = energyBucket({ heatHeatingTotal: 800, heatHeatingPv: 0 });
    expect(buildHeatingComparison([heatingOnly], heatingTimeline())!.heatSource).toBe("heating_only");
  });

  it("forms every headline figure over the same periods", () => {
    // Gas price only from February on: January is measured but not comparable.
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("heat_pump_scop", 4, "ratio"),
      tariff("boiler_efficiency", 0.9, "ratio"),
      tariff("gas_price", 0.1, "eur_per_kwh", "2026-02-01T00:00:00.000Z"),
    ]);
    const jan = energyBucket({ heatHeatingTotal: 750, hotWaterTotal: 0 });
    const feb = february({ heatHeatingTotal: 800, hotWaterTotal: 200 });
    const result = buildHeatingComparison([jan, feb], timeline)!;
    expect(result.comparedPeriods).toBe(1);
    expect(result.periodStart).toBe(feb.periodStart);
    expect(result.totalHeatPumpCostEur).toBe(400);
    expect(result.totalGasCostEur.mid).toBeCloseTo(444.44, 1);
    expect(result.totalSavingsEur.mid).toBeCloseTo(44.44, 1);
    expect(result.buckets[0].compared).toBe(false);
  });

  it("leaves periods without heat pump readings empty and out of the span", () => {
    const empty = energyBucket({ key: "2025-12", periodStart: "2025-12-01T00:00:00.000Z", periodEnd: "2026-01-01T00:00:00.000Z" });
    const result = buildHeatingComparison([empty, gridOnly], heatingTimeline())!;
    expect(result.buckets[0].heatPumpKwh).toBeNull();
    expect(result.periodStart).toBe(gridOnly.periodStart);
    expect(result.periodEnd).toBe(gridOnly.periodEnd);
  });
});

describe("buildCarComparison", () => {
  const gridCharged = energyBucket({ evChargerTotal: 200, evChargerPv: 0, evChargerGrid: 200 });
  const pvCharged = energyBucket({ evChargerTotal: 200, evChargerPv: 200, evChargerGrid: 0 });

  it("converts charged kWh into kilometres and the petrol they replace", () => {
    const result = buildCarComparison([gridCharged], carTimeline())!;
    // 200 kWh ÷ 20 kWh/100 km = 1000 km; × 7 l/100 km = 70 l; × 1.80 € = 126 €.
    expect(result.totalKilometers).toBe(1000);
    expect(result.buckets[0].petrolLitres).toBe(70);
    expect(result.totalPetrolCostEur).toBe(126);
  });

  it("compares against what the grid charging cost", () => {
    const result = buildCarComparison([gridCharged], carTimeline())!;
    expect(result.totalEvCostEur).toBe(80);
    expect(result.totalSavingsEur).toBe(46);
    expect(result.evCentsPerKm).toBe(8);
    expect(result.petrolCentsPerKm).toBe(12.6);
  });

  it("values PV-charged kWh at the feed-in tariff, once", () => {
    const withFeedIn = buildCarComparison([pvCharged], carTimeline([tariff("feed_in", 0.08, "eur_per_kwh")]))!;
    // 200 kWh that could have been exported at 0.08 € = 16 €, not 40 € + 16 €.
    expect(withFeedIn.totalEvCostEur).toBe(16);
    expect(withFeedIn.totalSavingsEur).toBe(110);
    expect(withFeedIn.evCentsPerKm).toBe(1.6);
    // Without a feed-in tariff the self-consumption value is the fallback.
    expect(buildCarComparison([pvCharged], carTimeline())!.totalEvCostEur).toBe(40);
  });

  it("accounts for charging losses between meter and battery", () => {
    const result = buildCarComparison([gridCharged], carTimeline([tariff("ev_charging_loss", 0.1, "ratio")]))!;
    expect(result.chargingLoss).toBe(0.1);
    expect(result.totalKilometers).toBe(900);
    expect(result.buckets[0].petrolLitres).toBe(63);
  });

  it("counts only the grid share of charging against the avoided emissions", () => {
    const factors = [tariff("petrol_co2", 2.37, "kg_per_l"), tariff("grid_co2", 0.4, "kg_per_kwh")];
    // Petrol 70 l × 2.37 = 165.9 kg; grid charging 200 × 0.4 = 80 kg.
    expect(buildCarComparison([gridCharged], carTimeline(factors))!.avoidedCo2Kg).toBeCloseTo(85.9, 1);
    expect(buildCarComparison([pvCharged], carTimeline(factors))!.avoidedCo2Kg).toBeCloseTo(165.9, 1);
  });

  it("gives no comparison when the EV consumption or the petrol consumption is missing", () => {
    expect(
      buildCarComparison(
        [gridCharged],
        new EnergyTariffTimeline([tariff("grid_import", 0.4, "eur_per_kwh"), tariff("petrol_consumption", 7, "l_per_100km")]),
      ),
    ).toBeNull();
    expect(
      buildCarComparison(
        [gridCharged],
        new EnergyTariffTimeline([tariff("grid_import", 0.4, "eur_per_kwh"), tariff("ev_consumption", 20, "kwh_per_100km")]),
      ),
    ).toBeNull();
  });

  it("forms the totals and cost per kilometre over the compared periods only", () => {
    // Petrol price only from February on.
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("ev_consumption", 20, "kwh_per_100km"),
      tariff("petrol_consumption", 7, "l_per_100km"),
      tariff("petrol_price", 1.8, "eur_per_l", "2026-02-01T00:00:00.000Z"),
    ]);
    const result = buildCarComparison([gridCharged, february({ evChargerTotal: 200, evChargerPv: 0 })], timeline)!;
    expect(result.buckets[0].kilometers).toBe(1000);
    expect(result.buckets[0].savingsEur).toBeNull();
    expect(result.comparedPeriods).toBe(1);
    expect(result.totalKilometers).toBe(1000);
    expect(result.totalSavingsEur).toBe(46);
    expect(result.petrolCentsPerKm).toBe(12.6);
    expect(result.evCentsPerKm).toBe(8);
  });

  it("reports the span of the compared periods, and none when nothing was charged", () => {
    const empty = energyBucket({ key: "2025-12", periodStart: "2025-12-01T00:00:00.000Z", periodEnd: "2026-01-01T00:00:00.000Z" });
    const result = buildCarComparison([empty, gridCharged], carTimeline())!;
    expect(result.periodStart).toBe(gridCharged.periodStart);
    expect(buildCarComparison([empty], carTimeline())!.periodStart).toBeNull();
  });
});
