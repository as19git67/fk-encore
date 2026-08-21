import { describe, expect, it } from "vitest";
import {
  buildAmortization,
  buildPvEconomicsBuckets,
  buildUsageCostBucket,
} from "./economics.service";
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

/** 0.40 €/kWh from the grid, 0.20 €/kWh assumed for self-consumed kWh. */
function standardTimeline() {
  return new EnergyTariffTimeline([
    tariff("grid_import", 0.4, "eur_per_kwh"),
    tariff("self_consumption_value", 0.2, "eur_per_kwh"),
    tariff("feed_in", 0.08, "eur_per_kwh"),
    tariff("base_price", 12, "eur_per_month"),
  ]);
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

function pvBucket(key: string, net: number, noPv: number, benefit: number): EnergyReportBucket {
  const [year, month] = key.split("-").map(Number);
  return energyBucket({
    key,
    label: key,
    periodStart: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    periodEnd: new Date(Date.UTC(year, month, 1)).toISOString(),
    costs: {
      gridImportCostEur: null,
      baseCostEur: null,
      feedInRevenueEur: null,
      avoidedGridCostEur: null,
      pvBenefitEur: benefit,
      netElectricityCostEur: net,
      noPvElectricityCostEur: noPv,
    },
  });
}

describe("buildUsageCostBucket", () => {
  it("values self-consumed kWh lower than kWh bought from the grid", () => {
    const bucket = energyBucket({
      heatHeatingTotal: 100,
      heatHeatingPv: 40,
      heatHeatingGrid: 60,
    });

    const costs = buildUsageCostBucket(bucket, standardTimeline());

    // 40 kWh × 0.20 € + 60 kWh × 0.40 € = 8 € + 24 € = 32 €
    expect(costs.heating).toMatchObject({ totalKwh: 100, pvKwh: 40, gridKwh: 60, costEur: 32 });
  });

  it("prices an application without a measured PV share at the grid price", () => {
    const bucket = energyBucket({ evChargerTotal: 50 });

    const costs = buildUsageCostBucket(bucket, standardTimeline());

    expect(costs.evCharger.costEur).toBe(20);
  });

  it("gives the household the self-consumption no sub-meter claims", () => {
    const bucket = energyBucket({
      selfConsumption: 300,
      consumptionWithoutHeatPumpAndEv: 200,
      heatHeatingTotal: 100,
      heatHeatingPv: 80,
      heatHeatingGrid: 20,
      hotWaterTotal: 50,
      hotWaterPv: 40,
      hotWaterGrid: 10,
      evChargerTotal: 60,
      evChargerPv: 30,
      evChargerGrid: 30,
    });

    const costs = buildUsageCostBucket(bucket, standardTimeline());

    // 300 self-consumed − (80 + 40 + 30) claimed = 150 left for the household.
    expect(costs.household).toMatchObject({ totalKwh: 200, pvKwh: 150, gridKwh: 50 });
    // 150 × 0.20 € + 50 × 0.40 € = 30 € + 20 € = 50 €
    expect(costs.household.costEur).toBe(50);
  });

  it("never hands the household a PV share larger than it consumed", () => {
    const bucket = energyBucket({
      selfConsumption: 500,
      consumptionWithoutHeatPumpAndEv: 100,
      heatHeatingTotal: 10,
      heatHeatingPv: 10,
      heatHeatingGrid: 0,
    });

    const costs = buildUsageCostBucket(bucket, standardTimeline());

    expect(costs.household.pvKwh).toBe(100);
    expect(costs.household.gridKwh).toBe(0);
  });

  it("adds the standing charge to the period total but to no application", () => {
    const bucket = energyBucket({ heatHeatingTotal: 100, heatHeatingPv: 0, heatHeatingGrid: 100 });

    const costs = buildUsageCostBucket(bucket, standardTimeline());

    expect(costs.heating.costEur).toBe(40);
    expect(costs.baseCostEur).toBe(12);
    expect(costs.totalCostEur).toBe(52);
  });
});

describe("buildPvEconomicsBuckets", () => {
  it("accumulates savings and benefit over the periods", () => {
    const buckets = buildPvEconomicsBuckets([
      pvBucket("2026-01", 50, 150, 120),
      pvBucket("2026-02", 40, 160, 130),
    ]);

    expect(buckets[0]).toMatchObject({ savingsEur: 100, cumulativeSavingsEur: 100 });
    expect(buckets[1]).toMatchObject({ savingsEur: 120, cumulativeSavingsEur: 220 });
    expect(buckets[1].cumulativePvBenefitEur).toBe(250);
  });

  it("leaves periods without cost data empty instead of counting them as zero", () => {
    const buckets = buildPvEconomicsBuckets([energyBucket()]);

    expect(buckets[0]).toMatchObject({
      savingsEur: null,
      cumulativeSavingsEur: null,
      cumulativePvBenefitEur: null,
    });
  });
});

describe("buildAmortization", () => {
  /** 24 months of PV benefit at `perMonth` euros. */
  function monthlyBenefit(months: number, perMonth: number) {
    return buildPvEconomicsBuckets(
      Array.from({ length: months }, (_, index) => {
        const year = 2024 + Math.floor(index / 12);
        const month = (index % 12) + 1;
        return pvBucket(`${year}-${String(month).padStart(2, "0")}`, 0, perMonth, perMonth);
      }),
    );
  }

  const investmentTimeline = () =>
    new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("pv_investment_net", 20000, "eur"),
      tariff("pv_investment_vat", 4000, "eur"),
      tariff("opportunity_cost_year", 1000, "eur"),
    ]);

  it("subtracts the accumulated benefit from the investment", () => {
    const amortization = buildAmortization(monthlyBenefit(24, 100), investmentTimeline())!;

    expect(amortization.investmentTotalEur).toBe(24000);
    expect(amortization.cumulativePvBenefitEur).toBe(2400);
    expect(amortization.remainingEur).toBe(21600);
    expect(amortization.benefitLast12MonthsEur).toBe(1200);
    expect(amortization.payoffReached).toBe(false);
  });

  it("projects the payoff date from the last twelve months", () => {
    const amortization = buildAmortization(monthlyBenefit(24, 100), investmentTimeline())!;

    // 21600 € remaining at 1200 €/year = 18 years after the last period end
    // (2026-01-01).
    const payoff = new Date(amortization.projectedPayoffDate!)
    expect(payoff.getUTCFullYear()).toBe(2044);
  });

  it("counts forgone returns in the opportunity-cost variant", () => {
    const amortization = buildAmortization(monthlyBenefit(24, 100), investmentTimeline())!;

    // Two years at 1000 €/year on top of the investment. The span covers a leap
    // day, so it is a touch over two years — hence the tolerance.
    expect(amortization.yearsElapsed).toBeCloseTo(2, 1);
    expect(amortization.remainingWithOpportunityEur).toBeCloseTo(23600, -1);
    // 1200 €/year benefit against 1000 €/year opportunity cost still pays off,
    // but only on the 200 € that are left over.
    expect(amortization.projectedPayoffDateWithOpportunity).not.toBeNull();
  });

  it("gives no payoff date when the benefit never outruns the opportunity cost", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("pv_investment_net", 20000, "eur"),
      tariff("opportunity_cost_year", 5000, "eur"),
    ]);

    const amortization = buildAmortization(monthlyBenefit(24, 100), timeline)!;

    expect(amortization.projectedPayoffDateWithOpportunity).toBeNull();
    // The plain projection still works — it does not carry the opportunity cost.
    expect(amortization.projectedPayoffDate).not.toBeNull();
  });

  it("reports a reached payoff instead of projecting into the past", () => {
    const amortization = buildAmortization(
      monthlyBenefit(24, 2000),
      investmentTimeline(),
    )!;

    expect(amortization.payoffReached).toBe(true);
    expect(amortization.remainingEur).toBeLessThanOrEqual(0);
  });

  it("returns nothing when no period carries PV benefit", () => {
    expect(buildAmortization([], investmentTimeline())).toBeNull();
  });

  it("skips the projection while there are less than twelve months", () => {
    const amortization = buildAmortization(monthlyBenefit(6, 100), investmentTimeline())!;

    expect(amortization.benefitLast12MonthsEur).toBeNull();
    expect(amortization.projectedPayoffDate).toBeNull();
  });
});
