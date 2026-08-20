import { describe, expect, it } from "vitest";
import {
  buildEnergyReportFromMeterReports,
  buildMeterReportBuckets,
} from "./reports.service";

describe("buildMeterReportBuckets — allocation 'interval_start'", () => {
  it("assigns each consumption interval to the month of the start reading", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T12:00:00.000Z", value: 100 },
        { takenAt: "2026-02-01T12:00:00.000Z", value: 145.5 },
        { takenAt: "2026-03-01T12:00:00.000Z", value: 170 },
      ],
      "month",
      { decimals: 1, allocation: "interval_start" },
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
      { decimals: 0, allocation: "interval_start" },
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
        allocation: "interval_start",
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
      { decimals: 0, allocation: "interval_start" },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([["2026-02", 30]]);
  });
});

describe("buildMeterReportBuckets — allocation 'interpolated' (default)", () => {
  it("matches the legacy allocation when readings sit on period boundaries", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 31 },
        { takenAt: "2026-03-01T00:00:00.000Z", value: 59 },
      ],
      "month",
      { decimals: 1 },
    );

    expect(buckets.map((b) => [b.key, b.consumption, b.coverage])).toEqual([
      ["2026-01", 31, 1],
      ["2026-02", 28, 1],
    ]);
  });

  it("splits an interval across the periods it overlaps, weighted by time", () => {
    // 41 days at exactly 1 unit/day: 31 days fall into January, 10 into February.
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-11T00:00:00.000Z", value: 41 },
      ],
      "month",
      { decimals: 1 },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([
      ["2026-01", 31],
      ["2026-02", 10],
    ]);
  });

  it("reports partial coverage for periods the readings do not span completely", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-11T00:00:00.000Z", value: 41 },
      ],
      "month",
      { decimals: 1 },
    );

    const february = buckets.find((b) => b.key === "2026-02")!;
    // 10 of 28 days measured.
    expect(february.coverage).toBeCloseTo(10 / 28, 3);
    expect(february.coverage).toBeLessThan(1);
  });

  it("keeps an interval spanning a whole year out of the neighbouring months", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2027-01-01T00:00:00.000Z", value: 365 },
      ],
      "year",
      { decimals: 0 },
    );

    expect(buckets.map((b) => [b.key, b.consumption, b.intervals])).toEqual([["2026", 365, 1]]);
  });

  it("filters whole periods by their start, not the reading timestamps", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 31 },
        { takenAt: "2026-03-01T00:00:00.000Z", value: 59 },
        { takenAt: "2026-04-01T00:00:00.000Z", value: 90 },
      ],
      "month",
      {
        from: new Date("2026-02-01T00:00:00.000Z"),
        to: new Date("2026-04-01T00:00:00.000Z"),
        decimals: 0,
      },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([
      ["2026-02", 28],
      ["2026-03", 31],
    ]);
  });

  it("skips negative intervals instead of reporting negative consumption", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 100 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 90 },
        { takenAt: "2026-03-01T00:00:00.000Z", value: 118 },
      ],
      "month",
      { decimals: 0 },
    );

    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([["2026-02", 28]]);
  });
});

describe("buildMeterReportBuckets — previous-year comparison", () => {
  /** Readings on the 1st of each month, `perMonth` units consumed per month. */
  function monthlyReadings(startYear: number, months: number, perMonth: (index: number) => number) {
    const readings: Array<{ takenAt: string; value: number }> = [];
    let value = 0;
    for (let i = 0; i <= months; i++) {
      const date = new Date(Date.UTC(startYear, i, 1));
      readings.push({ takenAt: date.toISOString(), value });
      value += perMonth(i);
    }
    return readings;
  }

  it("compares each period with the same period one year earlier", () => {
    const buckets = buildMeterReportBuckets(
      // 2025: 100 per month, 2026: 120 per month.
      monthlyReadings(2025, 15, (index) => (index < 12 ? 100 : 120)),
      "month",
      { decimals: 0 },
    );

    const january2026 = buckets.find((b) => b.key === "2026-01")!;
    expect(january2026).toMatchObject({
      consumption: 120,
      previousConsumption: 100,
      deltaAbsolute: 20,
      deltaPercent: 0.2,
    });
  });

  it("leaves the comparison empty when there is no reference period", () => {
    const buckets = buildMeterReportBuckets(
      monthlyReadings(2025, 3, () => 100),
      "month",
      { decimals: 0 },
    );

    expect(buckets[0]).toMatchObject({
      previousConsumption: null,
      deltaAbsolute: null,
      deltaPercent: null,
    });
  });

  it("keeps the reference period available when a from filter is applied", () => {
    const buckets = buildMeterReportBuckets(
      monthlyReadings(2025, 15, (index) => (index < 12 ? 100 : 120)),
      "month",
      { decimals: 0, from: new Date("2026-01-01T00:00:00.000Z") },
    );

    expect(buckets[0]).toMatchObject({
      key: "2026-01",
      previousConsumption: 100,
      deltaAbsolute: 20,
    });
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
    coverage: 1,
    previousConsumption: null,
    deltaAbsolute: null,
    deltaPercent: null,
  });

  const report = (name: string, buckets: Array<ReturnType<typeof bucket>>) => ({
    meterId: 1,
    name,
    unit: "kWh",
    decimals: 1,
    granularity: "month" as const,
    allocation: "interpolated" as const,
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

  it("reports heat pump and EV usage as totals with PV shares", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report("Bezug", [bucket("2026-01", 100)]),
        grid_export: report("Einspeisung", [bucket("2026-01", 300)]),
        pv_production: report("Produktion", [bucket("2026-01", 500)]),
        heat_pump_total: report("Wärmepumpe", [bucket("2026-01", 80)]),
        heat_heating_total: report("Heizung", [bucket("2026-01", 60)]),
        heat_heating_pv: report("Heizung PV", [bucket("2026-01", 25)]),
        hot_water_total: report("Warmwasser", [bucket("2026-01", 20)]),
        hot_water_pv: report("Warmwasser PV", [bucket("2026-01", 8)]),
        ev_charger_total: report("Wallbox", [bucket("2026-01", 40)]),
        ev_charger_pv: report("Wallbox PV", [bucket("2026-01", 10)]),
      },
      "month",
      null,
      null,
    );

    expect(energy.buckets[0]).toMatchObject({
      heatPumpTotal: 80,
      consumptionWithoutHeatPumpAndEv: 180,
      heatHeatingTotal: 60,
      heatHeatingPv: 25,
      heatHeatingGrid: 35,
      heatHeatingPvShare: 0.417,
      hotWaterTotal: 20,
      hotWaterPv: 8,
      hotWaterGrid: 12,
      hotWaterPvShare: 0.4,
      evChargerTotal: 40,
      evChargerPv: 10,
      evChargerPvShare: 0.25,
    });
    expect(energy.totals).toMatchObject({
      heatPumpTotal: 80,
      consumptionWithoutHeatPumpAndEv: 180,
      heatHeatingTotal: 60,
      heatHeatingPv: 25,
      heatHeatingGrid: 35,
      heatHeatingPvShare: 0.417,
      hotWaterTotal: 20,
      hotWaterPv: 8,
      hotWaterGrid: 12,
      hotWaterPvShare: 0.4,
      evChargerTotal: 40,
      evChargerPv: 10,
      evChargerPvShare: 0.25,
    });
  });
});
