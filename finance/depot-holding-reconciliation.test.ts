import { describe, it, expect } from "vitest";
import { findSplit, reconcilePosition, type SnapshotPoint } from "./depot-holding-reconciliation";

const p = (as_of: string, amount: number): SnapshotPoint => ({ as_of, amount });

describe("reconcilePosition", () => {
  it("accepts a change the transactions explain, even when the snapshot lags the trade", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-02", 10), p("2026-03-04", 15)], [
      { executed_at: "2026-03-02", kind: "buy", amount: 5 },
    ]);
    expect(r.gaps).toEqual([]);
    expect(r.unverifiable).toBe(0);
  });

  it("reports shares no transaction accounts for", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-04-01", 25)], [
      { executed_at: "2026-03-10", kind: "buy", amount: 5 },
    ]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({
      account_id: 1,
      position_key: "K",
      from: "2026-03-01",
      to: "2026-04-01",
      delta: "15.00000000",
      explained: "5.00000000",
      unexplained: "10.00000000",
      transaction_count: 1,
    });
  });

  it("reports a transfer out without a transaction, and a full sale as fine", () => {
    const gap = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-05", 0)], []);
    expect(gap.gaps[0]!.unexplained).toBe("-10.00000000");

    const sold = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-05", 0)], [
      { executed_at: "2026-03-03", kind: "sell", amount: 10 },
    ]);
    expect(sold.gaps).toEqual([]);
  });

  it("counts a change it cannot check instead of reporting it", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-05", 15)], [
      { executed_at: "2026-03-03", kind: "buy", amount: null },
    ]);
    expect(r.gaps).toEqual([]);
    expect(r.unverifiable).toBe(1);

    const split = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-05", 20)], [
      { executed_at: "2026-03-03", kind: "split", amount: null },
    ]);
    expect(split.unverifiable).toBe(1);
  });

  it("ignores trades before the first snapshot and dividends", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-01", 10), p("2026-03-05", 10)], [
      { executed_at: "2026-02-01", kind: "buy", amount: 10 },
      { executed_at: "2026-03-03", kind: "dividend", amount: null },
    ]);
    expect(r).toEqual({ gaps: [], unverifiable: 0 });
  });

  it("takes a trade dated a few days after the snapshot that shows it (value date)", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-02", 10), p("2026-03-04", 15), p("2026-03-06", 15)], [
      // Booked on the 1st, valued on the 5th: the snapshot of the 4th already shows it.
      { executed_at: "2026-03-05", kind: "buy", amount: 5 },
    ]);
    expect(r.gaps).toEqual([]);
  });

  it("does not take a later trade that does not make the change add up", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-02", 10), p("2026-03-04", 15)], [
      { executed_at: "2026-03-05", kind: "buy", amount: 3 },
    ]);
    expect(r.gaps.map((g) => g.unexplained)).toEqual(["5.00000000"]);
  });

  it("does not reach further than the lookahead", () => {
    const r = reconcilePosition(1, "K", [p("2026-03-02", 10), p("2026-03-04", 15)], [
      { executed_at: "2026-03-20", kind: "buy", amount: 5 },
    ]);
    expect(r.gaps).toHaveLength(1);
  });

  it("hands each trade to the first change after it only once", () => {
    const r = reconcilePosition(
      1,
      "K",
      [p("2026-03-01", 10), p("2026-03-05", 15), p("2026-03-10", 20)],
      [{ executed_at: "2026-03-03", kind: "buy", amount: 5 }],
    );
    // The second +5 has no transaction.
    expect(r.gaps.map((g) => [g.to, g.unexplained])).toEqual([["2026-03-10", "5.00000000"]]);
  });

  it("names a split nobody booked and keeps the trade right after it out of the next pair", () => {
    // 30 held, 10 sold, then a 1:3 split: 60. A buy of 6 the next snapshot
    // already shows carries its value date two days later. Later 12 more.
    const r = reconcilePosition(
      1,
      "K",
      [p("2026-01-01", 30), p("2026-03-01", 66), p("2026-06-30", 78)],
      [
        { executed_at: "2026-02-01", kind: "sell", amount: 10 },
        { executed_at: "2026-03-03", kind: "buy", amount: 6 },
        { executed_at: "2026-04-15", kind: "buy", amount: 12 },
      ],
    );
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({
      from: "2026-01-01",
      to: "2026-03-01",
      explained: "-4.00000000",
      unexplained: "40.00000000",
      transaction_count: 2,
      split_ratio: 3,
    });
    expect(r.unverifiable).toBe(0);
  });

  it("names a reverse split", () => {
    const r = reconcilePosition(1, "K", [p("2026-01-01", 100), p("2026-03-01", 10)], []);
    expect(r.gaps[0]).toMatchObject({ unexplained: "-90.00000000", split_ratio: 0.1 });
  });

  it("names no split where no usual ratio adds up", () => {
    const r = reconcilePosition(1, "K", [p("2026-01-01", 30), p("2026-03-01", 47)], [
      { executed_at: "2026-02-01", kind: "buy", amount: 5 },
    ]);
    expect(r.gaps[0]).toMatchObject({ unexplained: "12.00000000", split_ratio: null });
  });

  it("counts a booked split by its quantity", () => {
    const r = reconcilePosition(1, "K", [p("2026-01-01", 30), p("2026-03-01", 66), p("2026-06-30", 78)], [
      { executed_at: "2026-02-01", kind: "sell", amount: 10 },
      { executed_at: "2026-02-20", kind: "split", amount: 40 },
      { executed_at: "2026-03-03", kind: "buy", amount: 6 },
      { executed_at: "2026-04-15", kind: "buy", amount: 12 },
    ]);
    expect(r).toEqual({ gaps: [], unverifiable: 0 });
  });
});

describe("findSplit", () => {
  it("puts the split between the trades where the ratio adds up", () => {
    // 20 held, 5 bought before a 1:2 split, 4 sold after it: 46.
    expect(findSplit(20, 46, [5, -4])).toEqual({ ratio: 2, ahead: 0 });
    // Only with the trade dated after the snapshot.
    expect(findSplit(20, 52, [5], [2])).toEqual({ ratio: 2, ahead: 1 });
  });

  it("finds none for an empty holding or a change no ratio explains", () => {
    expect(findSplit(0, 40, [])).toBeNull();
    expect(findSplit(20, 0, [])).toBeNull();
    expect(findSplit(20, 33, [])).toBeNull();
  });
});
