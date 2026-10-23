import { describe, it, expect } from "vitest";

import {
  buildValueSeries,
  periodPerformance,
  periodStart,
  restrictToKey,
  xirr,
  type PerfSnapshotRow,
  type PerfTx,
  type PerformanceInput,
  type PriceObservation,
} from "./portfolio-performance-calc";

// Synthetic securities and depots only.
const A = "DE0000000AAA1";
const B = "DE0000000BBB2";

function buy(day: string, amount: number, price: number, opts: Partial<PerfTx> = {}): PerfTx {
  return { account_id: 1, key: A, kind: "buy", day, amount, price, cash: amount * price, income: null, ...opts };
}

function sell(day: string, amount: number, price: number, opts: Partial<PerfTx> = {}): PerfTx {
  return { account_id: 1, key: A, kind: "sell", day, amount, price, cash: amount * price, income: null, ...opts };
}

function tx(kind: string, day: string, opts: Partial<PerfTx> = {}): PerfTx {
  return { account_id: 1, key: A, kind, day, amount: null, price: null, cash: null, income: null, ...opts };
}

function px(day: string, price: number, key = A): PriceObservation {
  return { key, day, price };
}

function snap(day: string, amount: number, price: number | null, opts: Partial<PerfSnapshotRow> = {}): PerfSnapshotRow {
  return { account_id: 1, day, key: A, amount, price, ...opts };
}

function input(parts: Partial<PerformanceInput>): PerformanceInput {
  return { snapshots: [], txs: [], prices: [], today: "2026-06-30", ...parts };
}

function maxPeriod(i: PerformanceInput) {
  const p = periodPerformance(buildValueSeries(i), "max", i.today);
  expect(p).not.toBeNull();
  return p!;
}

describe("portfolio performance — TWR", () => {
  it("measures a price move, not the money put in", () => {
    // +10 %, then a second buy at the new price, then −10 %.
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), buy("2026-01-07", 10, 110)],
        prices: [px("2026-01-05", 100), px("2026-01-06", 110), px("2026-01-07", 110), px("2026-01-08", 99)],
      }),
    );
    expect(p.twr).toBeCloseTo(1.1 * 0.9 - 1, 10);
    expect(p.end_value).toBeCloseTo(20 * 99, 6);
    expect(p.net_flow).toBeCloseTo(2100, 6);
    expect(p.gain).toBeCloseTo(1980 - 2100, 6);
    // More money was in for the fall than for the rise: worse for the investor.
    expect(p.mwr!).toBeLessThan(p.twr!);
    expect(p.points.at(-1)!.invested).toBeCloseTo(2100, 6);
  });

  it("is not moved by a sale", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), sell("2026-01-07", 5, 120)],
        prices: [px("2026-01-05", 100), px("2026-01-06", 120), px("2026-01-07", 120), px("2026-01-08", 132)],
      }),
    );
    expect(p.twr).toBeCloseTo(1.2 * 1.1 - 1, 10);
    expect(p.end_value).toBeCloseTo(5 * 132, 6);
    expect(p.points.at(-1)!.invested).toBeCloseTo(1000 - 600, 6);
  });

  it("counts a dividend as return that left the portfolio", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), tx("dividend", "2026-01-06", { income: 50 })],
        prices: [px("2026-01-05", 100), px("2026-01-06", 100)],
      }),
    );
    expect(p.twr).toBeCloseTo(0.05, 10);
    expect(p.income).toBeCloseTo(50, 6);
    expect(p.gain).toBeCloseTo(50, 6);
  });

  it("counts tax on kept income as money in that added no value", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), tx("tax", "2026-01-06", { income: -10 })],
        prices: [px("2026-01-05", 100), px("2026-01-06", 100)],
      }),
    );
    expect(p.twr).toBeCloseTo(1000 / 1010 - 1, 10);
  });

  it("includes the gap between buy price and close, and the fees, on the day of a buy", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100, { cash: 1010 })],
        prices: [px("2026-01-05", 100)],
      }),
    );
    expect(p.twr).toBeCloseTo(1000 / 1010 - 1, 10);
  });

  it("leaves a transfer between two depots in scope neutral", () => {
    const p = maxPeriod(
      input({
        txs: [
          buy("2026-01-05", 10, 100),
          tx("out", "2026-01-06", { amount: 10 }),
          tx("in", "2026-01-06", { account_id: 2, amount: 10 }),
        ],
        prices: [px("2026-01-05", 100), px("2026-01-06", 100), px("2026-01-07", 105)],
      }),
    );
    expect(p.twr).toBeCloseTo(0.05, 10);
    expect(p.end_value).toBeCloseTo(1050, 6);
    expect(p.points.at(-1)!.invested).toBeCloseTo(1000, 6);
  });

  it("values a transfer into the scope at the day's price", () => {
    const p = maxPeriod(
      input({
        txs: [tx("in", "2026-01-05", { amount: 10 })],
        prices: [px("2026-01-05", 80), px("2026-01-06", 88)],
      }),
    );
    expect(p.twr).toBeCloseTo(0.1, 10);
    expect(p.net_flow).toBeCloseTo(800, 6);
  });

  it("is not moved by a split", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), tx("split", "2026-01-06", { amount: 10 })],
        prices: [px("2026-01-05", 100), px("2026-01-06", 50), px("2026-01-07", 55)],
      }),
    );
    expect(p.twr).toBeCloseTo(0.1, 10);
    expect(p.end_value).toBeCloseTo(20 * 55, 6);
  });

  it("adds positions held in several depots", () => {
    const p = maxPeriod(
      input({
        snapshots: [
          snap("2026-01-05", 10, 100),
          snap("2026-01-05", 5, 100, { account_id: 2 }),
          snap("2026-01-05", 4, 50, { key: B, account_id: 2 }),
        ],
        txs: [
          buy("2026-01-05", 10, 100),
          buy("2026-01-05", 5, 100, { account_id: 2 }),
          buy("2026-01-05", 4, 50, { account_id: 2, key: B }),
        ],
        prices: [px("2026-01-06", 110), px("2026-01-06", 50, B)],
      }),
    );
    expect(p.start_value).toBe(0);
    expect(p.end_value).toBeCloseTo(15 * 110 + 4 * 50, 6);
    expect(p.twr).toBeCloseTo((15 * 110 + 200) / (1500 + 200) - 1, 10);
  });
});

describe("portfolio performance — shares from snapshots", () => {
  it("books what a snapshot shows beyond the trades as moved in, not as gain", () => {
    const i = input({
      snapshots: [snap("2026-01-10", 15, 100)],
      txs: [buy("2026-01-05", 10, 100), buy("2026-01-12", 5, 100)],
      prices: [px("2026-01-05", 100), px("2026-01-08", 100), px("2026-01-12", 100)],
    });
    const series = buildValueSeries(i);
    const byDay = new Map(series.days.map((d) => [d.day, d.value]));
    expect(byDay.get("2026-01-05")).toBeCloseTo(1000, 6);
    expect(byDay.get("2026-01-10")).toBeCloseTo(1500, 6);
    expect(byDay.get("2026-01-12")).toBeCloseTo(2000, 6);
    expect(series.implied_inflow).toBeCloseTo(500, 6);
    const p = periodPerformance(series, "max", i.today)!;
    expect(p.twr).toBeCloseTo(0, 10);
    expect(p.points.at(-1)!.invested).toBeCloseTo(2000, 6);
  });

  it("takes the snapshot as truth when it disagrees with the trades", () => {
    const series = buildValueSeries(
      input({
        snapshots: [snap("2026-01-05", 10, 100), snap("2026-01-09", 8, 100)],
        txs: [buy("2026-01-05", 10, 100)],
        prices: [px("2026-01-07", 100)],
      }),
    );
    const byDay = new Map(series.days.map((d) => [d.day, d.value]));
    expect(byDay.get("2026-01-07")).toBeCloseTo(1000, 6);
    expect(byDay.get("2026-01-09")).toBeCloseTo(800, 6);
    expect(periodPerformance(series, "max", "2026-06-30")!.twr).toBeCloseTo(0, 10);
  });

  it("counts holdings older than every transaction as brought in when first seen", () => {
    const p = maxPeriod(
      input({
        snapshots: [snap("2026-01-05", 10, 100), snap("2026-01-06", 10, 105)],
      }),
    );
    expect(p.twr).toBeCloseTo(0.05, 10);
    expect(p.net_flow).toBeCloseTo(1000, 6);
  });

  it("treats a position missing from a later snapshot as gone", () => {
    const one = restrictToKey(
      input({
        snapshots: [snap("2026-01-05", 10, 100), snap("2026-01-05", 3, 10, { key: B }), snap("2026-01-06", 3, 10, { key: B })],
        txs: [buy("2026-01-05", 10, 100)],
      }),
      A,
    );
    const series = buildValueSeries(one);
    expect(series.days.at(-1)!.value).toBe(0);
  });
});

describe("portfolio performance — gaps", () => {
  it("leaves days without a recent price unvalued and reports the gap", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100), buy("2026-01-05", 1, 10, { key: B }), buy("2026-02-20", 1, 10, { key: B })],
        prices: [
          px("2026-01-05", 100),
          px("2026-02-20", 120),
          // B has a price every week: those days exist, A has none for them.
          px("2026-01-05", 10, B),
          px("2026-01-20", 10, B),
          px("2026-02-01", 10, B),
          px("2026-02-20", 10, B),
        ],
      }),
    );
    expect(p.unvalued_days).toBe(2);
    expect(p.gaps).toEqual([{ from: "2026-01-20", to: "2026-02-19" }]);
    expect(p.points.find((pt) => pt.day === "2026-02-01")!.value).toBeNull();
    // The return still links across the gap.
    expect(p.twr).toBeCloseTo((10 * 120 + 20) / (1010 + 10) - 1, 10);
  });

  it("reports a stretch between two values longer than a price lasts", () => {
    const p = maxPeriod(
      input({
        txs: [buy("2026-01-05", 10, 100)],
        prices: [px("2026-01-05", 100), px("2026-03-01", 100)],
      }),
    );
    expect(p.unvalued_days).toBe(0);
    expect(p.gaps).toEqual([{ from: "2026-01-06", to: "2026-02-28" }]);
  });
});

describe("portfolio performance — periods", () => {
  it("starts a period at the last value on or before its first day", () => {
    const i = input({
      today: "2026-06-30",
      txs: [buy("2025-01-02", 10, 100)],
      prices: [px("2025-01-02", 100), px("2025-12-30", 150), px("2026-03-02", 165), px("2026-06-30", 180)],
    });
    const series = buildValueSeries(i);
    const ytd = periodPerformance(series, "YTD", i.today)!;
    expect(ytd.from).toBe("2025-12-30");
    expect(ytd.start_value).toBeCloseTo(1500, 6);
    expect(ytd.twr).toBeCloseTo(0.2, 10);
    expect(ytd.twr_pa).toBeNull();
    // Without flows in the period, both returns agree.
    expect(ytd.mwr).toBeCloseTo(0.2, 6);

    const max = periodPerformance(series, "max", i.today)!;
    expect(max.twr).toBeCloseTo(0.8, 10);
    expect(max.twr_pa).not.toBeNull();
  });

  it("says when the history does not reach back to the period's start", () => {
    const i = input({
      today: "2026-06-30",
      txs: [buy("2026-05-02", 10, 100)],
      prices: [px("2026-05-02", 100), px("2026-06-30", 110)],
    });
    const p = periodPerformance(buildValueSeries(i), "3Y", i.today)!;
    expect(p.shortened).toBe(true);
    expect(p.from).toBe("2026-05-02");
  });

  it("knows where each period starts", () => {
    expect(periodStart("1M", "2026-03-31")).toBe("2026-02-28");
    expect(periodStart("YTD", "2026-03-31")).toBe("2025-12-31");
    expect(periodStart("1Y", "2026-03-31")).toBe("2025-03-31");
    expect(periodStart("3Y", "2026-03-31")).toBe("2023-03-31");
    expect(periodStart("max", "2026-03-31")).toBeNull();
  });
});

describe("portfolio performance — XIRR", () => {
  it("finds the rate of one year", () => {
    expect(xirr([{ t: 0, amount: -1000 }, { t: 1, amount: 1100 }])).toBeCloseTo(0.1, 8);
  });

  it("weighs a second payment by the time it was in", () => {
    const r = xirr([
      { t: 0, amount: -1000 },
      { t: 0.5, amount: -1000 },
      { t: 1, amount: 2200 },
    ])!;
    // Check the rate by discounting the flows back.
    const npv = -1000 - 1000 / Math.pow(1 + r, 0.5) + 2200 / Math.pow(1 + r, 1);
    expect(Math.abs(npv)).toBeLessThan(1e-6);
    expect(r).toBeGreaterThan(0.1);
  });

  it("has no rate without money both in and out", () => {
    expect(xirr([{ t: 0, amount: -1000 }])).toBeNull();
    expect(xirr([{ t: 0, amount: 1000 }, { t: 1, amount: 10 }])).toBeNull();
  });

  it("handles a heavy loss", () => {
    expect(xirr([{ t: 0, amount: -1000 }, { t: 1, amount: 50 }])).toBeCloseTo(-0.95, 8);
  });
});
