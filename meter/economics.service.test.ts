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
      // 24000 € at 4 % is ~960 €/year to start with.
      tariff("expected_return_rate", 0.04, "ratio"),
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

  it("derives the forgone return from the expected rate instead of a stored figure", () => {
    const amortization = buildAmortization(monthlyBenefit(24, 100), investmentTimeline())!;

    // The span covers a leap day, so it is a touch over two years — hence the
    // tolerance. 24000 € x 4 %/year x ~2 years is ~1920 €.
    expect(amortization.yearsElapsed).toBeCloseTo(2, 1);
    expect(amortization.expectedReturnRate).toBe(0.04);
    expect(amortization.opportunityCostEur).toBeCloseTo(1920, -1);
    // Investment + forgone return - benefit earned so far.
    expect(amortization.remainingWithOpportunityEur).toBeCloseTo(23520, -1);
  });

  it("charges the forgone return as a flat yearly amount, not compounded", () => {
    // Compounding a fixed annual PV benefit against an exponentially growing
    // "what if invested elsewhere" would make the opportunity-cost payoff
    // unreachable for nearly every real system — the gap always widens in the
    // long run, for any positive rate. Flat interest avoids that: it is the
    // same shape as the source spreadsheet's own formula (investment x 5 %).
    const twenty = buildAmortization(monthlyBenefit(240, 100), investmentTimeline())!;

    // 24000 € x 4 %/year x ~20 years.
    expect(twenty.yearsElapsed).toBeCloseTo(20, 0);
    expect(twenty.opportunityCostEur).toBeCloseTo(24000 * 0.04 * 20, -2);
  });

  it("gives no payoff date when the benefit never outruns the expected return", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("pv_investment_net", 20000, "eur"),
      // 20000 € at 25 % grows by 5000 €/year — far beyond the 1200 €/year the
      // system earns, so the gap only ever widens.
      tariff("expected_return_rate", 0.25, "ratio"),
    ]);

    const amortization = buildAmortization(monthlyBenefit(24, 100), timeline)!;

    expect(amortization.projectedPayoffDateWithOpportunity).toBeNull();
    // The plain projection still works — it does not carry the opportunity cost.
    expect(amortization.projectedPayoffDate).not.toBeNull();
  });

  it("projects a payoff once the benefit outgrows the expected return", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("pv_investment_net", 10000, "eur"),
      tariff("expected_return_rate", 0.01, "ratio"),
    ]);

    // 3000 €/year against 10000 € growing at 1 % pays off within a few years.
    const amortization = buildAmortization(monthlyBenefit(24, 250), timeline)!;

    const withOpportunity = amortization.projectedPayoffDateWithOpportunity;
    expect(withOpportunity).not.toBeNull();
    // Always later than the projection that ignores the forgone return.
    expect(new Date(withOpportunity!).getTime()).toBeGreaterThan(
      new Date(amortization.projectedPayoffDate!).getTime(),
    );
  });

  it("leaves the opportunity-cost variant empty without an expected return rate", () => {
    const timeline = new EnergyTariffTimeline([
      tariff("grid_import", 0.4, "eur_per_kwh"),
      tariff("pv_investment_net", 20000, "eur"),
    ]);

    const amortization = buildAmortization(monthlyBenefit(24, 100), timeline)!;

    expect(amortization.expectedReturnRate).toBeNull();
    expect(amortization.opportunityCostEur).toBeNull();
    expect(amortization.remainingWithOpportunityEur).toBeNull();
    expect(amortization.projectedPayoffDateWithOpportunity).toBeNull();
    expect(amortization.remainingEur).toBe(17600);
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
