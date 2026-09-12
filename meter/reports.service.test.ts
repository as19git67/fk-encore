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
    meanIntervalDays: 30,
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

describe("buildMeterReportBuckets — day and week granularity (#1024)", () => {
  it("buckets by ISO week, Monday to Sunday, with a KW label", () => {
    // 2026-01-05 is a Monday (ISO week 2 of 2026).
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-05T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-12T00:00:00.000Z", value: 70 },
        { takenAt: "2026-01-19T00:00:00.000Z", value: 140 },
      ],
      "week",
      { decimals: 0 },
    );

    expect(buckets.map((b) => [b.key, b.label, b.consumption, b.coverage])).toEqual([
      ["2026-W02", "KW 02/2026", 70, 1],
      ["2026-W03", "KW 03/2026", 70, 1],
    ]);
    expect(buckets[0].periodStart).toBe("2026-01-05T00:00:00.000Z");
    expect(buckets[0].periodEnd).toBe("2026-01-12T00:00:00.000Z");
  });

  it("assigns the days around New Year to the ISO week-year they belong to", () => {
    // 2025-12-29 (Monday) … 2026-01-04 (Sunday) is ISO week 1 of 2026.
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2025-12-29T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-05T00:00:00.000Z", value: 7 },
      ],
      "week",
      { decimals: 0 },
    );
    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([["2026-W01", 7]]);
  });

  it("splits an interval across days, weighted by time", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-03-01T12:00:00.000Z", value: 0 },
        { takenAt: "2026-03-03T12:00:00.000Z", value: 48 },
      ],
      "day",
      { decimals: 0 },
    );

    expect(buckets.map((b) => [b.key, b.label, b.consumption, b.coverage])).toEqual([
      ["2026-03-01", "01.03.2026", 12, 0.5],
      ["2026-03-02", "02.03.2026", 24, 1],
      ["2026-03-03", "03.03.2026", 12, 0.5],
    ]);
  });

  it("compares a day with the same date a year earlier", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2025-06-01T00:00:00.000Z", value: 0 },
        { takenAt: "2025-06-02T00:00:00.000Z", value: 10 },
        { takenAt: "2026-06-01T00:00:00.000Z", value: 100 },
        { takenAt: "2026-06-02T00:00:00.000Z", value: 112 },
      ],
      "day",
      { decimals: 0 },
    );
    const today = buckets.find((b) => b.key === "2026-06-01")!;
    expect(today.previousConsumption).toBe(10);
    expect(today.deltaAbsolute).toBe(2);
    expect(today.deltaPercent).toBe(0.2);
  });
});

describe("buildMeterReportBuckets — review follow-ups", () => {
  it("keeps the consumption of two readings taken at the same instant", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-01T00:00:00.000Z", value: 0 },
        { takenAt: "2026-01-15T00:00:00.000Z", value: 100 },
        { takenAt: "2026-01-15T00:00:00.000Z", value: 130 },
        { takenAt: "2026-02-01T00:00:00.000Z", value: 200 },
      ],
      "month",
      { decimals: 0 },
    );
    expect(buckets.map((b) => [b.key, b.consumption])).toEqual([["2026-01", 200]]);
  });

  it("reports start and end values at the period boundaries, so end − start = consumption", () => {
    const buckets = buildMeterReportBuckets(
      [
        { takenAt: "2026-01-15T00:00:00.000Z", value: 0 },
        { takenAt: "2026-03-15T00:00:00.000Z", value: 590 },
      ],
      "month",
      { decimals: 0 },
    );
    const february = buckets.find((b) => b.key === "2026-02")!;
    expect(february.startReadingAt).toBe("2026-02-01T00:00:00.000Z");
    expect(february.endReadingAt).toBe("2026-03-01T00:00:00.000Z");
    expect(february.endValue - february.startValue).toBe(february.consumption);
    expect(february.meanIntervalDays).toBe(59);
  });

  it("compares daily rates, so a leap-year February is not a rise", () => {
    const readings: Array<{ takenAt: string; value: number }> = [];
    let value = 0;
    for (let month = 0; month <= 24; month++) {
      const date = new Date(Date.UTC(2023, month, 1));
      readings.push({ takenAt: date.toISOString(), value });
      const next = new Date(Date.UTC(2023, month + 1, 1));
      value += (next.getTime() - date.getTime()) / 86_400_000; // 1 per day
    }
    const buckets = buildMeterReportBuckets(readings, "month", { decimals: 0 });
    const feb2024 = buckets.find((b) => b.key === "2024-02")!;
    expect(feb2024.consumption).toBe(29);
    expect(feb2024.previousConsumption).toBe(28);
    expect(feb2024.deltaAbsolute).toBe(1);
    expect(feb2024.deltaPercent).toBe(0);
  });

  it("keeps the reference year with a from filter in interval_start mode too", () => {
    const readings: Array<{ takenAt: string; value: number }> = [];
    let value = 0;
    for (let i = 0; i <= 15; i++) {
      readings.push({ takenAt: new Date(Date.UTC(2025, i, 1)).toISOString(), value });
      value += i < 12 ? 100 : 120;
    }
    const buckets = buildMeterReportBuckets(readings, "month", {
      decimals: 0,
      allocation: "interval_start",
      from: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(buckets[0]).toMatchObject({ key: "2026-01", previousConsumption: 100 });
  });
});

describe("buildEnergyReportFromMeterReports — review follow-ups", () => {
  const bucket = (key: string, consumption: number, coverage = 1) => ({
    key,
    label: key,
    periodStart: `${key}-01T00:00:00.000Z`,
    periodEnd: `${key}-28T00:00:00.000Z`,
    startReadingAt: `${key}-01T00:00:00.000Z`,
    endReadingAt: `${key}-28T00:00:00.000Z`,
    startValue: 0,
    endValue: consumption,
    consumption,
    intervals: 1,
    coverage,
    meanIntervalDays: 30,
    previousConsumption: null,
    deltaAbsolute: null,
    deltaPercent: null,
  });
  const report = (buckets: Array<ReturnType<typeof bucket>>) => ({
    meterId: 1,
    name: "m",
    unit: "kWh",
    decimals: 0,
    granularity: "month" as const,
    allocation: "interpolated" as const,
    from: null,
    to: null,
    buckets,
    totalConsumption: 0,
  });
  const pvSet = (keys: string[]) => ({
    grid_import: report(keys.map((k) => bucket(k, 300))),
    grid_export: report(keys.map((k) => bucket(k, 100))),
    pv_production: report(keys.map((k) => bucket(k, 400))),
  });

  it("leaves the household figure undefined when a metered heat pump reading is missing", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        ...pvSet(["2026-01", "2026-02"]),
        heat_pump_total: report([bucket("2026-01", 350)]),
      },
      "month",
      null,
      null,
    );
    expect(energy.buckets[0].consumptionWithoutHeatPumpAndEv).toBe(250);
    expect(energy.buckets[1].consumptionWithoutHeatPumpAndEv).toBeNull();
    expect(energy.totals.consumptionWithoutHeatPumpAndEv).toBe(250);
  });

  it("uses a single heating sub-meter when that is all the household has", () => {
    const energy = buildEnergyReportFromMeterReports(
      { ...pvSet(["2026-01"]), heat_heating_total: report([bucket("2026-01", 250)]) },
      "month",
      null,
      null,
    );
    expect(energy.buckets[0].consumptionWithoutHeatPumpAndEv).toBe(350);
  });

  it("forms PV shares in the totals over periods where both sides are known", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        ...pvSet(["2026-01", "2026-02"]),
        heat_heating_total: report([bucket("2026-01", 200)]),
        heat_heating_pv: report([bucket("2026-01", 150), bucket("2026-02", 150)]),
      },
      "month",
      null,
      null,
    );
    expect(energy.totals.heatHeatingPvShare).toBe(0.75);
  });

  it("flags partially measured periods and keeps them out of the totals", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report([bucket("2026-01", 300), bucket("2026-02", 90, 0.3)]),
        grid_export: report([bucket("2026-01", 100), bucket("2026-02", 30, 0.3)]),
        pv_production: report([bucket("2026-01", 400), bucket("2026-02", 120, 0.3)]),
      },
      "month",
      null,
      null,
    );
    expect(energy.buckets.map((b) => b.complete)).toEqual([true, false]);
    expect(energy.totals.totalConsumption).toBe(600);
  });

  it("warns when more was exported than produced instead of silently clamping", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report([bucket("2026-01", 100)]),
        grid_export: report([bucket("2026-01", 450)]),
        pv_production: report([bucket("2026-01", 400)]),
      },
      "month",
      null,
      null,
    );
    expect(energy.buckets[0].warnings).toEqual(["export_exceeds_production"]);
    expect(energy.buckets[0].selfConsumption).toBe(0);
  });

  it("warns when the sub-meters exceed the total", () => {
    const energy = buildEnergyReportFromMeterReports(
      {
        grid_import: report([bucket("2026-01", 100)]),
        grid_export: report([bucket("2026-01", 350)]),
        pv_production: report([bucket("2026-01", 400)]),
        heat_pump_total: report([bucket("2026-01", 400)]),
      },
      "month",
      null,
      null,
    );
    expect(energy.buckets[0].warnings).toEqual(["exclusion_exceeds_total"]);
    expect(energy.buckets[0].consumptionWithoutHeatPumpAndEv).toBe(0);
  });
});
