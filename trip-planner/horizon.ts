/**
 * Turning a height model into a horizon profile (§7.3).
 *
 * §7.3 leaves exactly one thing open in step 9: the light window
 * assumes a free horizon, and "in a valley, behind a ridge or in a city
 * with a steep slope the sun is gone long before astronomical sunset —
 * a mistake in exactly the unpleasant direction". The arithmetic that
 * cuts the window has been there for a while (`horizonAltitude`,
 * `lightWindows`); what was missing is the thing that produces the
 * profile. This is it.
 *
 * The method is the obvious one and deliberately so: walk out from the
 * spot along a fan of bearings, ask the height model how high the
 * ground is at a handful of distances, and keep per bearing the largest
 * angle anything subtends. That angle is the horizon there.
 *
 * Two corrections that are not optional at these distances:
 *
 *   - **The earth curves away.** Twenty kilometres out the ground has
 *     dropped about thirty metres below the tangent plane. Ignoring it
 *     turns distant flat land into a ridge.
 *   - **Air bends light downwards**, which lets you see slightly
 *     further than geometry allows. The standard approximation is to
 *     pretend the earth is 7/6 of its size, and it is what every
 *     viewshed calculation uses.
 *
 * Everything here is pure: no network, no database. Where the samples
 * come from is `elevation-client.ts`, and what is done with the result
 * is `horizon-store.ts`.
 */

// The shapes come from `sun.ts`, which is what consumes them: a
// second definition of "a bearing and an angle" would be one more
// thing that can drift out of step with the calculation using it.
export type { Coordinate, HorizonPoint } from "./sun";
import type { Coordinate, HorizonPoint } from "./sun";

const EARTH_RADIUS_M = 6_371_008.8;
/** Refraction, as the textbook fudge: a bigger earth curves away more slowly. */
const REFRACTION_RADIUS_M = (EARTH_RADIUS_M * 7) / 6;

/**
 * How many bearings the fan has.
 *
 * Twenty-four is fifteen degrees apart — one hour of the sun's travel,
 * and the profile is interpolated between neighbours anyway. Finer
 * would cost requests without telling us anything the sun could notice:
 * a ridge that only blocks a five-degree slice does not decide whether
 * the golden hour happens.
 */
export const HORIZON_AZIMUTHS = 24;

/**
 * How far out to look, in metres.
 *
 * Near samples catch the wall across the street, far ones the mountain
 * range. Spaced geometrically because the angle a hill subtends falls
 * with distance: the first kilometre deserves several samples, the
 * twentieth one.
 */
export const HORIZON_DISTANCES_M = [
  100, 200, 400, 700, 1_200, 2_000, 3_500, 6_000, 10_000, 15_000, 22_000,
] as const;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Where you end up going `distanceM` from `at` on bearing `azimuth`.
 *
 * Great-circle rather than a flat-earth offset: at twenty kilometres
 * the two differ by metres, which does not matter, but the formula is
 * no longer and it does not need a note explaining where it stops being
 * true.
 */
export function destination(at: Coordinate, azimuth: number, distanceM: number): Coordinate {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = toRad(azimuth);
  const lat1 = toRad(at.lat);
  const lon1 = toRad(at.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: toDeg(lat2),
    // Back onto (-180, 180]: a fan around the date line would otherwise
    // ask the height model about longitude 181.
    lon: ((toDeg(lon2) + 540) % 360) - 180,
  };
}

export interface HorizonSample {
  azimuth: number;
  distanceM: number;
  coordinate: Coordinate;
}

/** The fan of points a profile needs, in a stable order. */
export function samplePoints(
  at: Coordinate,
  azimuths: number = HORIZON_AZIMUTHS,
  distances: readonly number[] = HORIZON_DISTANCES_M,
): HorizonSample[] {
  const step = 360 / azimuths;
  const samples: HorizonSample[] = [];
  for (let index = 0; index < azimuths; index += 1) {
    const azimuth = index * step;
    for (const distanceM of distances) {
      samples.push({ azimuth, distanceM, coordinate: destination(at, azimuth, distanceM) });
    }
  }
  return samples;
}

/**
 * The angle a point `distanceM` away and `riseM` higher subtends.
 *
 * Negative when the ground falls away, which is the normal case on a
 * hilltop and the reason the profile is not clamped: a spot that looks
 * down into a valley really does see the sun below the mathematical
 * horizon, and pretending otherwise would shorten its evening.
 */
export function elevationAngle(riseM: number, distanceM: number): number {
  if (!(distanceM > 0)) return 0;
  const drop = (distanceM * distanceM) / (2 * REFRACTION_RADIUS_M);
  return toDeg(Math.atan2(riseM - drop, distanceM));
}

/**
 * The profile from a fan of samples and the height at the spot itself.
 *
 * A sample whose height is unknown is skipped rather than treated as
 * sea level (§15.3): a hole in a height model is a hole, and filling it
 * with zero would invent a cliff or a plain, depending on where you
 * stand. A bearing on which every sample is missing gets no point at
 * all, and `horizonAltitude` then interpolates across it from its
 * neighbours — which is a guess, but a guess between two measurements
 * rather than one made up out of nothing.
 */
export function profileFrom(
  spotElevationM: number,
  samples: readonly HorizonSample[],
  elevations: readonly (number | null)[],
): HorizonPoint[] {
  const highest = new Map<number, number>();
  for (const [index, sample] of samples.entries()) {
    const elevation = elevations[index];
    if (elevation === null || elevation === undefined || !Number.isFinite(elevation)) continue;
    const angle = elevationAngle(elevation - spotElevationM, sample.distanceM);
    const previous = highest.get(sample.azimuth);
    if (previous === undefined || angle > previous) highest.set(sample.azimuth, angle);
  }

  return [...highest.entries()]
    .map(([azimuth, altitude]) => ({ azimuth, altitude: round(altitude) }))
    .sort((a, b) => a.azimuth - b.azimuth);
}

/**
 * Is this profile worth storing at all?
 *
 * A profile of nothing but small negative angles is flat ground, and
 * flat ground is what the light calculation already assumes. Keeping it
 * costs a row and a lookup and changes no window by a minute worth
 * naming — but keeping the *knowledge* that we looked is worth
 * something, so this decides what the caller says, not whether the row
 * is written.
 */
export const FLAT_ENOUGH_DEGREES = 0.5;

export function isFlat(profile: readonly HorizonPoint[]): boolean {
  return profile.every((point) => point.altitude < FLAT_ENOUGH_DEGREES);
}

function round(value: number): number {
  // The `+ 0` turns a rounded-away negative into a plain zero: level
  // ground would otherwise store -0, which reads back from JSON as 0
  // and makes a stored profile unequal to the one just computed.
  return Math.round(value * 100) / 100 + 0;
}
