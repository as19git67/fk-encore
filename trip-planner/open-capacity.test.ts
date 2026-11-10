import { describe, expect, it } from "vitest";
import { capacityOf, OPEN_TRAVEL_SHARE } from "./open-capacity";

const days = [
  { dayIndex: 0, freeMinutes: 300 },
  { dayIndex: 1, freeMinutes: 400 },
  { dayIndex: 2, freeMinutes: 500 },
];

describe("capacityOf", () => {
  it("sums the open spots by priority and leaves food out", () => {
    const capacity = capacityOf({
      days,
      open: [
        { priority: "must", dwellMinutes: 120, category: "museum" },
        { priority: "must", dwellMinutes: 60, category: "viewpoint" },
        { priority: "want", dwellMinutes: 90, category: "park" },
        { priority: "maybe", dwellMinutes: 45, category: "church" },
        { priority: "must", dwellMinutes: 75, category: "food" },
      ],
      startDate: null,
      today: "2026-11-10",
    });
    expect(capacity).toMatchObject({ mustMinutes: 180, wantMinutes: 90, maybeMinutes: 45, days: 3 });
    expect(capacity.freeMinutes).toBe(Math.round(1200 * (1 - OPEN_TRAVEL_SHARE)));
    expect(capacity.fits).toBe(true);
  });

  it("counts only the days still to come, today included", () => {
    const capacity = capacityOf({ days, open: [], startDate: "2026-11-09", today: "2026-11-10" });
    expect(capacity.days).toBe(2);
    expect(capacity.freeMinutes).toBe(Math.round(900 * (1 - OPEN_TRAVEL_SHARE)));
  });

  it("says how far the Muss spots run over", () => {
    const capacity = capacityOf({
      days: [{ dayIndex: 0, freeMinutes: 100 }],
      open: [{ priority: "must", dwellMinutes: 200, category: "museum" }],
      startDate: null,
      today: "2026-11-10",
    });
    expect(capacity).toMatchObject({ fits: false, freeMinutes: 80, overMinutes: 120 });
  });
});
