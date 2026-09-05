import { describe, expect, it } from "vitest";
import {
  DETOUR_FACTOR,
  WALKING_SPEED_M_PER_MIN,
  haversineMeters,
  travelLeg,
  walkingLeg,
} from "./travel";

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters({ lat: 48.37, lon: 10.9 }, { lat: 48.37, lon: 10.9 })).toBe(0);
  });

  it("gives ~111 m per 0.001° of latitude", () => {
    const d = haversineMeters({ lat: 48.37, lon: 10.9 }, { lat: 48.371, lon: 10.9 });
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(114);
  });

  it("is symmetric", () => {
    const a = { lat: 48.37, lon: 10.9 };
    const b = { lat: 48.4, lon: 11.0 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("walkingLeg", () => {
  it("applies the detour factor and the walking speed", () => {
    const a = { lat: 48.37, lon: 10.9 };
    const b = { lat: 48.379, lon: 10.9 }; // ~1 km straight line
    const straight = haversineMeters(a, b);
    const leg = walkingLeg(a, b);

    expect(leg.distanceM).toBe(Math.round(straight * DETOUR_FACTOR));
    expect(leg.minutes).toBe(Math.round(leg.distanceM / WALKING_SPEED_M_PER_MIN));
  });

  it("classifies a leg under ten minutes as a short walk", () => {
    // ~400 m straight → ~520 m walked → ~7 min
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.3736, lon: 10.9 });
    expect(leg.minutes).toBeLessThan(10);
    expect(leg.travelClass).toBe("short_walk");
  });

  it("classifies a longer leg as a long walk", () => {
    // ~1.5 km straight → ~2 km walked → ~26 min
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.3835, lon: 10.9 });
    expect(leg.minutes).toBeGreaterThanOrEqual(10);
    expect(leg.travelClass).toBe("long_walk");
  });

  it("costs nothing to stay where you are", () => {
    const leg = walkingLeg({ lat: 48.37, lon: 10.9 }, { lat: 48.37, lon: 10.9 });
    expect(leg).toEqual({ distanceM: 0, minutes: 0, travelClass: "short_walk" });
  });
});

describe("travelLeg across modes", () => {
  const FROM = { lat: 48.37, lon: 10.9 };
  /** ~1.5 km straight north. */
  const FAR = { lat: 48.3835, lon: 10.9 };
  /** ~110 m straight north — a few steps. */
  const NEAR = { lat: 48.371, lon: 10.9 };

  it("makes walking the slowest way to cover a real distance", () => {
    const minutes = (mode: Parameters<typeof travelLeg>[2]) =>
      travelLeg(FROM, FAR, mode).minutes;
    for (const mode of ["bike", "transit", "car"] as const) {
      expect(minutes("foot")).toBeGreaterThan(minutes(mode));
    }
  });

  it("lets the bicycle beat transit over a short hop and lose over a long one", () => {
    // This is why speed and overhead are separate. Waiting for a
    // departure dominates a 1.5 km hop and disappears into a 6 km one;
    // one average speed per mode could not say that, and the block
    // budget would be wrong at one end or the other.
    const NEARBY = { lat: 48.3835, lon: 10.9 }; // ~1.5 km
    const FURTHER = { lat: 48.424, lon: 10.9 }; // ~6 km
    expect(travelLeg(FROM, NEARBY, "bike").minutes)
      .toBeLessThan(travelLeg(FROM, NEARBY, "transit").minutes);
    expect(travelLeg(FROM, FURTHER, "bike").minutes)
      .toBeGreaterThan(travelLeg(FROM, FURTHER, "transit").minutes);
  });

  it("does not make a few steps into a bus ride", () => {
    // Below 150 m the waiting and parking overheads do not apply:
    // charging seven minutes for crossing the square would push real
    // stops out of a block for nothing.
    expect(travelLeg(FROM, NEAR, "transit").minutes).toBeLessThan(3);
    expect(travelLeg(FROM, NEAR, "car").minutes).toBeLessThan(3);
  });

  it("charges transit for the stop and the wait once the distance is real", () => {
    // ~1.5 km × 1.5 detour ÷ 400 m/min is under six minutes of moving;
    // most of what the block pays is getting to the platform.
    expect(travelLeg(FROM, FAR, "transit").minutes).toBeGreaterThan(14);
  });

  it("calls a hop that is not on foot a ride, not a walk", () => {
    expect(travelLeg(FROM, NEAR, "bike").travelClass).toBe("short_ride");
    expect(travelLeg(FROM, FAR, "transit").travelClass).toBe("long_ride");
    expect(travelLeg(FROM, FAR, "foot").travelClass).toBe("long_walk");
  });

  it("is the pedestrian case by default", () => {
    expect(travelLeg(FROM, FAR)).toEqual(walkingLeg(FROM, FAR));
  });
});

describe("transit means public transport and walking", () => {
  const FROM = { lat: 48.37, lon: 10.9 };
  /** ~330 m — three corners. */
  const ROUND_THE_CORNER = { lat: 48.373, lon: 10.9 };
  /** ~2.2 km — across town. */
  const ACROSS_TOWN = { lat: 48.39, lon: 10.9 };

  it("walks a hop that is quicker on foot than by tram", () => {
    // Nobody waits ten minutes for a tram to go three corners, and a
    // planner that charges the block for it plans a day nobody has.
    const leg = travelLeg(FROM, ROUND_THE_CORNER, "transit");
    expect(leg).toEqual(walkingLeg(FROM, ROUND_THE_CORNER));
  });

  it("says so on the card when the hop was walked", () => {
    // The traveller sees which of the two won: "zu Fuß" for the hop
    // across the square, "mit Öffentlichen" for the one across town.
    expect(travelLeg(FROM, ROUND_THE_CORNER, "transit").travelClass).toBe("short_walk");
    expect(travelLeg(FROM, ACROSS_TOWN, "transit").travelClass).toBe("long_ride");
  });

  it("takes the tram once it is quicker than walking", () => {
    const ride = travelLeg(FROM, ACROSS_TOWN, "transit");
    expect(ride.minutes).toBeLessThan(walkingLeg(FROM, ACROSS_TOWN).minutes);
  });

  it("is never slower than walking, at any distance", () => {
    // The property that matters: choosing "ÖPNV" can only ever make the
    // day cheaper than choosing "zu Fuß", never dearer. Without the
    // per-hop choice this failed everywhere under ~740 m.
    for (let metres = 50; metres <= 3_000; metres += 50) {
      const to = { lat: FROM.lat + metres / 111_320, lon: FROM.lon };
      expect(travelLeg(FROM, to, "transit").minutes)
        .toBeLessThanOrEqual(walkingLeg(FROM, to).minutes);
    }
  });

  it("leaves the car and the bicycle alone", () => {
    // Both stay with you: abandoning the car for one hop and finding it
    // again for the next is a decision with Park & Ride behind it, not
    // an estimate the planner may quietly make (§4.2).
    for (const mode of ["bike", "car"] as const) {
      const leg = travelLeg(FROM, ROUND_THE_CORNER, mode);
      expect(leg.travelClass).toBe("short_ride");
      expect(leg.minutes).toBeGreaterThanOrEqual(
        Math.round(leg.distanceM / (mode === "bike" ? 200 : 330)),
      );
    }
  });
});
