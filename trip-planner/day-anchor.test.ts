import { describe, expect, it } from "vitest";
import { chargeTheWayBack, dayTripOf } from "./day-anchor";
import { MIN_VIABLE_BLOCK_MINUTES } from "./fixpoints";

/** An invented base and two invented towns, roughly Tuscan distances. */
const BASE = { lat: 43.4677, lon: 11.0430 };
const FAR_TOWN = { lat: 43.7199, lon: 10.3973 };  // ≈ 59 km
const NEAR_TOWN = { lat: 43.7731, lon: 11.2560 }; // ≈ 38 km

describe("dayTripOf", () => {
  it("says nothing for a day that stays at the base", () => {
    expect(dayTripOf(BASE, null, "car")).toBeNull();
    expect(dayTripOf(BASE, undefined, "car")).toBeNull();
  });

  it("treats an anchor at the quarters as staying put", () => {
    // Somebody naming the same place has said "we stay here". Charging
    // a zero-minute drive would cost the day a line on the card and
    // nothing else.
    expect(dayTripOf(BASE, { ...BASE }, "car")).toBeNull();
  });

  it("costs an hour or so each way by car", () => {
    const trip = dayTripOf(BASE, { ...FAR_TOWN, label: "Pisa" }, "car");
    expect(trip?.label).toBe("Pisa");
    expect(trip?.travelMinutes).toBeGreaterThan(120);
    expect(trip?.at).toEqual(FAR_TOWN);
  });

  it("is dearer on foot than by car, for the same town", () => {
    const byCar = dayTripOf(BASE, NEAR_TOWN, "car")?.travelMinutes ?? 0;
    const onFoot = dayTripOf(BASE, NEAR_TOWN, "foot")?.travelMinutes ?? 0;
    expect(onFoot).toBeGreaterThan(byCar);
  });

  it("keeps a radius the day named, and none when it did not", () => {
    expect(dayTripOf(BASE, { ...NEAR_TOWN, radiusM: 8_000 }, "car")?.radiusM).toBe(8_000);
    expect(dayTripOf(BASE, NEAR_TOWN, "car")?.radiusM).toBeNull();
  });

  it("refuses half a coordinate rather than planning near the equator", () => {
    expect(dayTripOf(BASE, { lat: Number.NaN, lon: 11.0 }, "car")).toBeNull();
  });
});

describe("chargeTheWayBack", () => {
  const blocks = [
    { id: "morning", label: "Vormittag", kind: "spots", budgetMinutes: 180 },
    { id: "lunch", label: "Mittag", kind: "meal", budgetMinutes: 60 },
    { id: "afternoon", label: "Nachmittag", kind: "spots", budgetMinutes: 180 },
  ];

  it("takes it off the last block that holds places", () => {
    const { blocks: out, dropped } = chargeTheWayBack(blocks, 75, "Pisa");
    expect(out.map((b) => b.budgetMinutes)).toEqual([180, 60, 105]);
    expect(dropped).toEqual([]);
  });

  it("leaves a meal alone even when it is last", () => {
    // A meal block is a time and a rough area (§10.3). Shortening it
    // would move a dinner rather than a drive.
    const mealLast = [blocks[0], blocks[2], blocks[1]];
    const { blocks: out } = chargeTheWayBack(mealLast, 60, "Pisa");
    expect(out.map((b) => `${b.id}:${b.budgetMinutes}`))
      .toEqual(["morning:180", "afternoon:120", "lunch:60"]);
  });

  it("drops a block the drive leaves nothing of, and says why", () => {
    const { blocks: out, dropped } = chargeTheWayBack(blocks, 175, "Pisa");
    expect(out.map((b) => b.id)).toEqual(["morning", "lunch"]);
    expect(dropped[0].reason).toContain("Rückfahrt von Pisa");
    expect(dropped[0].reason).toContain("175");
  });

  it("drops rather than leaving a block with room for nothing", () => {
    const tight = 180 - (MIN_VIABLE_BLOCK_MINUTES - 1);
    expect(chargeTheWayBack(blocks, tight, "Pisa").dropped).toHaveLength(1);
    const roomy = 180 - MIN_VIABLE_BLOCK_MINUTES;
    expect(chargeTheWayBack(blocks, roomy, "Pisa").dropped).toEqual([]);
  });

  it("says the sentence without a name when the day trip has none", () => {
    const { dropped } = chargeTheWayBack(blocks, 175, null);
    expect(dropped[0].reason).toContain("Rückfahrt braucht");
  });

  it("changes nothing when there is no drive", () => {
    expect(chargeTheWayBack(blocks, 0, "Pisa").blocks).toEqual(blocks);
  });

  it("leaves a day of nothing but meals alone", () => {
    const meals = [{ id: "lunch", label: "Mittag", kind: "meal", budgetMinutes: 60 }];
    expect(chargeTheWayBack(meals, 45, "Pisa")).toEqual({ blocks: meals, dropped: [] });
  });
});
