import { describe, expect, it } from "vitest";
import { dayEnds, travelPaidByRoute, type LocatedFixpoint } from "./day-ends";

const STATION = { lat: 48.365, lon: 10.886 };
const AIRPORT = { lat: 48.353, lon: 11.786 };

function fix(over: Partial<LocatedFixpoint> = {}): LocatedFixpoint {
  return {
    label: "Fixpunkt",
    kind: "appointment",
    startMinutes: 14 * 60,
    endMinutes: 14 * 60,
    lat: null,
    lon: null,
    ...over,
  };
}

const MORNING = [{ startMinutes: 9 * 60 }, { startMinutes: 13 * 60 }];

describe("dayEnds", () => {
  it("says nothing when no fixpoint carries a place", () => {
    // Then both ends are the anchor, which is what the caller does with
    // null — the ordinary day, and the overwhelming majority of them.
    expect(dayEnds([fix(), fix({ kind: "departure" })], MORNING))
      .toEqual({ start: null, end: null });
  });

  it("starts the day where the arrival left the travellers", () => {
    const arrival = fix({
      label: "Ankunft Hauptbahnhof", startMinutes: 8 * 60, endMinutes: 8 * 60 + 30, ...STATION,
    });
    const ends = dayEnds([arrival], [{ startMinutes: 9 * 60 }]);
    expect(ends.start).toEqual({ ...STATION, label: "Ankunft Hauptbahnhof" });
    expect(ends.end).toBeNull();
  });

  it("ends the day at the departure, not back at the hotel", () => {
    // After the last train you are gone: the walk home is a walk
    // nobody makes, and planning it costs the evening its last spot.
    const train = fix({
      label: "Zug 18:40", kind: "departure", startMinutes: 18 * 60 + 40,
      endMinutes: 18 * 60 + 40, ...STATION,
    });
    expect(dayEnds([train], MORNING).end).toEqual({ ...STATION, label: "Zug 18:40" });
  });

  it("catches the earlier train when two are named", () => {
    const early = fix({ label: "Zug 16:10", kind: "departure",
                        startMinutes: 16 * 60 + 10, endMinutes: 16 * 60 + 10, ...STATION });
    const late = fix({ label: "Flug 21:00", kind: "departure",
                       startMinutes: 21 * 60, endMinutes: 21 * 60, ...AIRPORT });
    expect(dayEnds([late, early], MORNING).end?.label).toBe("Zug 16:10");
  });

  it("does not let a departure start the day as well", () => {
    // Both ends from one fixpoint would plan a day that goes nowhere.
    const train = fix({ label: "Zug 07:00", kind: "departure",
                        startMinutes: 7 * 60, endMinutes: 7 * 60, ...STATION });
    const ends = dayEnds([train], MORNING);
    expect(ends.start).toBeNull();
    expect(ends.end?.label).toBe("Zug 07:00");
  });

  it("ignores an appointment inside the day", () => {
    // A booked tour at two would have to split a block to move the
    // route, and a block that is quietly two blocks is worse than a
    // walk that is slightly long. It keeps costing its time.
    const tour = fix({ label: "Führung", startMinutes: 14 * 60,
                       endMinutes: 15 * 60 + 30, ...STATION });
    expect(dayEnds([tour], MORNING)).toEqual({ start: null, end: null });
  });

  it("takes the last thing that finished before the day began", () => {
    const arrival = fix({ label: "Ankunft", startMinutes: 6 * 60,
                          endMinutes: 6 * 60 + 20, ...AIRPORT });
    const transfer = fix({ label: "Gepäck ins Hotel", startMinutes: 7 * 60,
                           endMinutes: 8 * 60, ...STATION });
    expect(dayEnds([arrival, transfer], MORNING).start?.label).toBe("Gepäck ins Hotel");
  });

  it("says nothing about the start when the day has no blocks left", () => {
    // Every block was dropped — there is no route to start anywhere.
    const arrival = fix({ label: "Ankunft", endMinutes: 8 * 60, ...STATION });
    expect(dayEnds([arrival], []).start).toBeNull();
  });

  it("treats half a coordinate as none", () => {
    expect(dayEnds([fix({ lat: 48.3, lon: null })], MORNING)).toEqual({ start: null, end: null });
    expect(dayEnds([fix({ lat: Number.NaN, lon: 10.9 })], MORNING))
      .toEqual({ start: null, end: null });
  });
});

describe("travelPaidByRoute", () => {
  const SPOTS = [{ kind: "spots" }, { kind: "spots" }];
  const train = { kind: "departure" as const, travelMinutes: 15, ...STATION };

  it("stops the guard charging for a walk the route already pays", () => {
    // Both at once made the day stop half an hour before the train and
    // then spend the real walk out of what was left — conservative, and
    // still a stop nobody had to give up.
    expect(travelPaidByRoute([train], SPOTS)[0].travelMinutes).toBe(0);
  });

  it("leaves a departure without a place alone", () => {
    const typed = { kind: "departure" as const, travelMinutes: 15 };
    expect(travelPaidByRoute([typed], SPOTS)[0].travelMinutes).toBe(15);
  });

  it("leaves an appointment alone, placed or not", () => {
    const tour = { kind: "appointment" as const, travelMinutes: 20, ...STATION };
    expect(travelPaidByRoute([tour], SPOTS)[0].travelMinutes).toBe(20);
  });

  it("keeps the guard when a meal comes after the last spots block", () => {
    // Then the route ends at the station before the dinner does, and
    // the guard is the only thing between a long meal and a missed
    // train.
    const withMeal = [{ kind: "spots" }, { kind: "meal" }];
    expect(travelPaidByRoute([train], withMeal)[0].travelMinutes).toBe(15);
  });

  it("changes nothing about the other fields", () => {
    const [out] = travelPaidByRoute([{ ...train, label: "Zug" }], SPOTS);
    expect(out.label).toBe("Zug");
    expect(out.lat).toBe(STATION.lat);
  });
});
