import { describe, expect, it } from "vitest";
import { buildSeasonProfile } from "./season-profile.service";
import type { EnergyReportBucket } from "./reports.service";

function bucket(
  key: string,
  autarky: number | null,
  selfConsumptionRate: number | null,
  coverage = 1,
): EnergyReportBucket {
  const [year, month] = key.split("-").map(Number);
  return {
    key,
    label: `${String(month).padStart(2, "0")}.${year}`,
    periodStart: `${key}-01T00:00:00.000Z`,
    periodEnd: new Date(Date.UTC(year, month, 1)).toISOString(),
    coverage,
    complete: coverage >= 0.99,
    warnings: [],
    gridImport: 100,
    gridExport: 50,
    production: 200,
    selfConsumption: 150,
    totalConsumption: 250,
    consumptionWithoutHeatPumpAndEv: 250,
    autarky,
    selfConsumptionRate,
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
  };
}

describe("buildSeasonProfile", () => {
  it("pivots monthly ratios into a year × month grid with averages", () => {
    const report = buildSeasonProfile([
      bucket("2025-01", 0.2, 0.9),
      bucket("2025-07", 0.8, 0.3),
      bucket("2026-01", 0.3, 0.85),
      bucket("2026-07", 0.9, 0.25),
    ]);

    expect(report.monthsMeasured).toBe(4);
    const autarky = report.metrics.find((metric) => metric.key === "autarky")!;
    expect(autarky.years.map((row) => row.year)).toEqual([2025, 2026]);
    expect(autarky.years[0].months[0]).toBe(0.2);
    expect(autarky.years[0].months[6]).toBe(0.8);
    expect(autarky.years[0].months[3]).toBeNull();
    expect(autarky.years[0].average).toBe(0.5);
    expect(autarky.years[0].measuredMonths).toBe(2);
    expect(autarky.monthAverages[0]).toBe(0.25);
    expect(autarky.monthAverages[6]).toBe(0.85);
    expect(autarky.monthAverages[1]).toBeNull();
    expect(autarky.min).toBe(0.2);
    expect(autarky.max).toBe(0.9);

    const scr = report.metrics.find((metric) => metric.key === "selfConsumptionRate")!;
    expect(scr.years[1].months[6]).toBe(0.25);
  });

  it("leaves partially measured months empty instead of showing a half-month ratio", () => {
    const report = buildSeasonProfile([
      bucket("2026-01", 0.3, 0.8),
      bucket("2026-02", 0.6, 0.7, 0.5),
    ]);
    const autarky = report.metrics[0];
    expect(report.monthsMeasured).toBe(1);
    expect(autarky.years[0].months[1]).toBeNull();
    expect(autarky.years[0].measuredMonths).toBe(1);
  });

  it("returns empty metrics without complete PV months", () => {
    const report = buildSeasonProfile([]);
    expect(report.monthsMeasured).toBe(0);
    expect(report.metrics).toHaveLength(2);
    expect(report.metrics[0].years).toEqual([]);
    expect(report.metrics[0].min).toBeNull();
  });
});
