import { describe, it, expect } from "vitest";
import { chartOf, MAX_POINTS, MAX_SLICES, pieOf, thinIndices } from "./charts";
import { presentBlock } from "./present";
import type { ResultBlock } from "./types";

function analysis(groupBy: string | undefined, groups: Array<[string, number]>, subtitle?: string): ResultBlock {
  return {
    kind: "analysis",
    tool: "transaction_totals",
    subtitle,
    rows: [{ sum: groups.reduce((s, [, v]) => s + v, 0), count: 9, currency: "EUR", ...(groupBy ? { group_by: groupBy } : {}), groups: groups.map(([label, sum]) => ({ label, sum, count: 3 })) }],
  };
}

describe("pieOf", () => {
  it("takes expenses as their amounts and sorts the largest first", () => {
    expect(pieOf([{ label: "Strom", value: -40 }, { label: "Miete", value: -800 }])).toEqual({ labels: ["Miete", "Strom"], values: [800, 40] });
  });

  it("draws no pie of income and expenses together, nor of one slice", () => {
    expect(pieOf([{ label: "Gehalt", value: 2000 }, { label: "Miete", value: -800 }])).toBeNull();
    expect(pieOf([{ label: "Miete", value: -800 }, { label: "Leer", value: 0 }])).toBeNull();
  });

  it("folds the smallest slices into „Übrige“", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ label: `T${i}`, value: 100 - i }));
    const pie = pieOf(entries)!;
    expect(pie.labels).toHaveLength(MAX_SLICES);
    expect(pie.labels.at(-1)).toBe("Übrige");
    expect(pie.values.reduce((s, v) => s + v, 0)).toBe(entries.reduce((s, e) => s + e.value, 0));
  });
});

describe("thinIndices", () => {
  it("keeps short series whole and thins long ones evenly, first and last kept", () => {
    expect(thinIndices(5)).toEqual([0, 1, 2, 3, 4]);
    const idx = thinIndices(1000);
    expect(idx.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(999);
  });
});

describe("chartOf", () => {
  it("draws sums per month as bars", () => {
    const c = chartOf(analysis("month", [["Januar 2026", -120], ["Februar 2026", -80.5]]))!;
    expect(c).toMatchObject({ type: "bar", labels: ["Januar 2026", "Februar 2026"], series: [{ values: [-120, -80.5] }], format: "money", unit: "EUR" });
  });

  it("draws sums per tag as a pie, also for a block stored before group_by", () => {
    const c = chartOf(analysis(undefined, [["Lebensmittel", -300], ["Tanken", -120]], "Zwischensummen nach Tag"))!;
    expect(c.type).toBe("pie");
    expect(c.series[0]!.values).toEqual([300, 120]);
  });

  it("falls back to bars when tags carry income and expenses", () => {
    expect(chartOf(analysis("tag", [["Gehalt", 2000], ["Miete", -800]]))!.type).toBe("bar");
  });

  it("draws nothing for a total without groups", () => {
    expect(chartOf(analysis("none", []))).toBeUndefined();
  });

  it("draws readings as a line, oldest first, from three readings on", () => {
    const rows = [
      { id: 3, taken_at: "2026-03-01T00:00:00Z", value: 130 },
      { id: 2, taken_at: "2026-02-01T00:00:00Z", value: 120 },
      { id: 1, taken_at: "2026-01-01T00:00:00Z", value: 100 },
    ];
    expect(chartOf({ kind: "readings", tool: "latest_readings", rows })).toMatchObject({
      type: "line", labels: ["01.01.2026", "01.02.2026", "01.03.2026"], series: [{ values: [100, 120, 130] }],
    });
    expect(chartOf({ kind: "readings", tool: "latest_readings", rows: rows.slice(0, 2) })).toBeUndefined();
  });

  it("draws consumption as bars in the meter's unit", () => {
    const c = chartOf({ kind: "consumption", tool: "consumption_report", rows: [{ period: "Jan", consumption: 300, unit: "kWh" }, { period: "Feb", consumption: 280, unit: "kWh" }] })!;
    expect(c).toMatchObject({ type: "bar", format: "number", unit: "kWh" });
  });

  it("draws open positions as a pie of their value and says when the list was cut", () => {
    const c = chartOf({
      kind: "positions", tool: "portfolio_overview", total: 5,
      rows: [
        { key: "DE0000000001", name: "Beispiel AG", value: "7500.00", currency: "EUR" },
        { key: "DE0000000002", name: "Muster ETF", value: "5000.00", currency: "EUR" },
        { key: "DE0000000003", name: "Alt AG", value: "0", currency: "EUR", open: false },
      ],
    })!;
    expect(c).toMatchObject({ type: "pie", labels: ["Beispiel AG", "Muster ETF"], series: [{ values: [7500, 5000] }], unit: "EUR" });
    expect(c.caption).toContain("3 gezeigten von 5");
  });

  it("draws no pie of positions in two currencies", () => {
    expect(chartOf({
      kind: "positions", tool: "portfolio_overview",
      rows: [{ name: "A", value: "1", currency: "EUR" }, { name: "B", value: "2", currency: "USD" }],
    })).toBeUndefined();
  });

  it("draws the depot value and the invested capital as two lines", () => {
    const c = chartOf({
      kind: "performance", tool: "portfolio_performance",
      rows: [{ currency: "EUR", points: [{ day: "2026-01-02", value: "100.00", invested: "90.00" }, { day: "2026-01-03", value: null, invested: "90.00" }] }],
    })!;
    expect(c).toMatchObject({ type: "line", labels: ["02.01.2026", "03.01.2026"], unit: "EUR" });
    expect(c.series.map((s) => s.name)).toEqual(["Depotwert", "Investiertes Kapital"]);
    expect(c.series[0]!.values).toEqual([100, null]);
  });

  it("travels on the presented block, and only where there is one", () => {
    expect(presentBlock(analysis("year", [["2025", 10], ["2026", 20]])).chart?.type).toBe("bar");
    expect("chart" in presentBlock({ kind: "documents", tool: "search_documents", rows: [{ id: 1, title: "Brief" }] })).toBe(false);
  });
});
