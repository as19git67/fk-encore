/**
 * "Reihenfolge vorschlagen" (ideas plan, stage 4): the order of the
 * ideas on a day under tickets, opening hours and the window.
 */

import { describe, expect, it } from "vitest";
import { EXACT_ORDER_LIMIT, orderDay, type OrderInput, type OrderStop } from "./day-order";
import { timeLine } from "./day-timing";
import type { Coordinate } from "./travel";

// A line of places one "unit" apart; a unit takes ten minutes.
const at = (x: number): Coordinate => ({ lat: 0, lon: x / 1000 });
const travel = (from: Coordinate, to: Coordinate) => {
  const minutes = Math.round(Math.abs(from.lon - to.lon) * 1000) * 10;
  return { minutes, distanceM: minutes * 80, travelClass: "short_walk" as const };
};

function stop(ref: string, x: number, extra: Partial<OrderStop> = {}): OrderStop {
  return { ref, ...at(x), dwellMinutes: 60, ...extra };
}

function day(stops: OrderStop[], extra: Partial<OrderInput> = {}): OrderInput {
  // 2026-09-07 is a Monday.
  return {
    start: at(0), startMinutes: 9 * 60, endMinutes: 19 * 60,
    stops, mode: "foot", date: "2026-09-07", travel, ...extra,
  };
}

describe("ordering a day of ideas", () => {
  it("walks the shortest way when nothing else counts", () => {
    const result = orderDay(day([stop("c", 3), stop("a", 1), stop("b", 2)]));
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.overrunMinutes).toBe(0);
    expect(result.toDrop).toEqual([]);
    // 10 + 60, 10 + 60, 10 + 60 from 09:00.
    expect(result.line.entries.map((e) => e.startMinutes)).toEqual([550, 620, 690]);
  });

  it("puts a booked visit at its hour and waits at the door rather than miss it", () => {
    const result = orderDay(day([
      stop("a", 1), stop("b", 2), stop("tower", 3, { ticketMinutes: 9 * 60 + 30 }),
    ]));
    expect(result.order[0]).toBe("tower");
    const tower = result.line.entries.find((e) => e.ref === "tower")!;
    expect(tower.startMinutes).toBe(9 * 60 + 30);
    expect(tower.lateMinutes).toBe(0);
  });

  it("does not go to a museum before it opens", () => {
    const result = orderDay(day([
      stop("museum", 1, { openingHours: "Mo-Su 14:00-18:00" }), stop("b", 2), stop("c", 3),
    ]));
    const museum = result.line.entries.find((e) => e.ref === "museum")!;
    expect(museum.startMinutes).toBeGreaterThanOrEqual(14 * 60);
    expect(museum.outsideHours).toBe(false);
  });

  it("says when a place is closed all day, whatever the order", () => {
    const result = orderDay(day([stop("museum", 1, { openingHours: "Tu-Su 10:00-18:00" })]));
    expect(result.line.entries[0].closed).toBe(true);
  });

  it("keeps a break where it was put", () => {
    const result = orderDay(day([stop("c", 3), stop("a", 1), stop("b", 2)], {
      breaks: [{ ref: "break:1", minutes: 45, position: 1 }],
    }));
    expect(result.line.entries.map((e) => e.ref)).toEqual(["a", "break:1", "b", "c"]);
    expect(result.line.plannedMinutes).toBe(30 + 180 + 45);
  });

  it("drops nothing and names what would make an overfull day fit, Wenn Zeit first", () => {
    const result = orderDay(day([
      stop("must", 1, { priority: "must", dwellMinutes: 240 }),
      stop("want", 2, { priority: "want", dwellMinutes: 180 }),
      stop("maybe", 3, { priority: "maybe", dwellMinutes: 120 }),
      stop("maybe2", 4, { priority: "maybe", dwellMinutes: 90 }),
    ], { endMinutes: 9 * 60 + 600 }));
    expect(result.order).toHaveLength(4);
    // 240 + 180 + 120 + 90 + 40 of ways is 670 against 600.
    expect(result.overrunMinutes).toBe(70);
    expect(result.toDrop).toEqual(["maybe2"]);
  });

  it("never names a Muss idea or a booked visit to drop", () => {
    const result = orderDay(day([
      stop("must", 1, { priority: "must", dwellMinutes: 400 }),
      stop("ticket", 2, { priority: "want", dwellMinutes: 300, ticketMinutes: 16 * 60 }),
    ]));
    expect(result.overrunMinutes).toBeGreaterThan(0);
    expect(result.toDrop).toEqual([]);
  });

  it("orders more than the exact limit without breaking a ticket", () => {
    const stops = Array.from({ length: EXACT_ORDER_LIMIT + 3 }, (_, i) =>
      stop(`s${String(i).padStart(2, "0")}`, 12 - i, { dwellMinutes: 20 }));
    stops[5] = { ...stops[5], ticketMinutes: 12 * 60 };
    const result = orderDay(day(stops));
    expect(new Set(result.order).size).toBe(stops.length);
    expect(result.line.entries.find((e) => e.ref === stops[5].ref)!.lateMinutes).toBe(0);
  });
});

describe("the clock of a day", () => {
  it("waits for an appointment that is in the way", () => {
    const line = timeLine({
      startMinutes: 9 * 60,
      items: [{ ref: "a", travelMinutes: 10, dwellMinutes: 60 }],
      blocked: [{ from: 9 * 60 + 30, to: 11 * 60 }],
    });
    expect(line.entries[0].startMinutes).toBe(11 * 60);
    expect(line.waitMinutes).toBe(11 * 60 - (9 * 60 + 10));
  });
});
