import { describe, expect, it } from "vitest";
import {
  buildEnergyReportFromMeterReports,
  buildMeterReportBuckets,
} from "./reports.service";

describe("buildMeterReportBuckets", () => {
  it("assigns each consumption interval to the month of the start reading", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T12:00:00.000Z", value: 100 },
        { takenAt: "2026-02-01T12:00:00.000Z", value: 145.5 },
        { takenAt: "2026-03-01T12:00:00.000Z", value: 170 },
      ],
      "month",
      { decimals: 1 },
    );

    expect(buckets).toEqual([
      expect.objectContaining({
        key: "2026-01",
        label: "01.2026",
        consumption: 45.5,
        startValue: 100,
        endValue: 145.5,
        intervals: 1,
      }),
      expect.objectContaining({
        key: "2026-02",
        label: "02.2026",
        consumption: 24.5,
        startValue: 145.5,
        endValue: 170,
        intervals: 1,
      }),
    ]);
  });

  it("rolls multiple intervals into the same year bucket", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2025-12-01T12:00:00.000Z", value: 1000 },
        { takenAt: "2026-01-01T12:00:00.000Z", value: 1100 },
        { takenAt: "2026-02-01T12:00:00.000Z", value: 1250 },
        { takenAt: "2027-01-01T12:00:00.000Z", value: 2000 },
      ],
      "year",
      { decimals: 0 },
    );

    expect(buckets).toEqual([
      expect.objectContaining({ key: "2025", consumption: 100, intervals: 1 }),
      expect.objectContaining({ key: "2026", consumption: 900, intervals: 2 }),
    ]);
  });

  it("filters intervals by start date", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T12:00:00.000Z", value: 0 },
        { takenAt: "2026-02-01T12:00:00.000Z", value: 10 },
        { takenAt: "2026-03-01T12:00:00.000Z", value: 30 },
        { takenAt: "2026-04-01T12:00:00.000Z", value: 60 },
      ],
      "month",
      {
        from: new Date("2026-02-01T00:00:00.000Z"),
        to: new Date("2026-04-01T00:00:00.000Z"),
        decimals: 0,
      },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([
      ["2026-02", 20],
      ["2026-03", 30],
    ]);
  });

  it("skips negative intervals instead of reporting negative consumption", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T12:00:00.000Z", value: 100 },
        { takenAt: "2026-02-01T12:00:00.000Z", value: 90 },
        { takenAt: "2026-03-01T12:00:00.000Z", value: 120 },
      ],
      "month",
      { decimals: 0 },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([["2026-02", 30]]);
  });
});

describe("buildEnergyReportFromMeterReports", () => {
  const bucket = (key: string, consumption: number) => ({
    key,
    label: key,
    periodStart: `${key}-01T00:00:00.000Z`,
    periodEnd: `${key}-02T00:00:00.000Z`,
    startReadingAt: `${key}-01T12:00:00.000Z`,
    endReadingAt: `${key}-02T12:00:00.000Z`,
    startValue: 0,
    endValue: consumption,
    consumption,
    intervals: 1,
  });

  const report = (name: string, buckets: Array<ReturnType<typeof bucket>>) => ({
    meterId: 1,
    name,
    unit: "kWh",
    decimals: 1,
    granularity: "month" as const,
    from: null,
    to: null,
    buckets,
    totalConsumption: buckets.reduce((sum, b) => sum + b.consumption, 0),
  });

  it("derives self consumption, total consumption and ratios from import/export/production", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report("Bezug", [bucket("2026-01", 100)]),
        grid_export: report("Einspeisung", [bucket("2026-01", 300)]),
        pv_production: report("Produktion", [bucket("2026-01", 500)]),
      },
      "month",
      null,
      null,
    );

    expect(energy.buckets[0]).toMatchObject({
      key: "2026-01",
      gridImport: 100,
      gridExport: 300,
      production: 500,
      selfConsumption: 200,
      totalConsumption: 300,
      autarky: 0.667,
      selfConsumptionRate: 0.4,
    });
    expect(energy.totals).toMatchObject({
      gridImport: 100,
      gridExport: 300,
      production: 500,
      selfConsumption: 200,
      totalConsumption: 300,
      autarky: 0.667,
      selfConsumptionRate: 0.4,
    });
  });

  it("omits buckets that do not have a complete PV data set", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report("Bezug", [bucket("2026-01", 100)]),
        grid_export: report("Einspeisung", [bucket("2026-01", 50)]),
      },
      "month",
      null,
      null,
    );

    expect(energy.buckets).toHaveLength(0);
    expect(energy.totals).toMatchObject({
      gridImport: null,
      gridExport: null,
      production: null,
      selfConsumption: null,
      totalConsumption: null,
      autarky: null,
      selfConsumptionRate: null,
    });
  });
});
