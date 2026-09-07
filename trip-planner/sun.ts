/**
 * Where the sun stands, and when the light is worth planning around
 * (§7.3).
 *
 * Pure arithmetic, no API: from a coordinate and an instant follow the
 * sun's altitude and azimuth by the standard formulae (the ones
 * SunCalc implements), accurate to fractions of a degree — far beyond
 * what a plan built in half-day blocks can use. That matters twice
 * over: the same numbers come out on the server and, later, on the
 * device with no network at all (§3.9), and nobody has to be asked for
 * an API key to know when the sun sets.
 *
 * The bands below are altitudes, not durations, and that is on
 * purpose: a golden hour lasts twenty minutes in Lisbon and half an
 * afternoon in Tromsø, because up there the sun crawls along the
 * horizon instead of crossing it. Shortening the northern one to match
 * a central-European intuition would be inventing a sunset that does
 * not happen.
 *
 * What this module deliberately does **not** know is the terrain. The
 * windows below assume a free horizon; in a valley or behind a ridge
 * the sun is gone long before the astronomical sunset, and promising
 * golden light at 19:30 to somebody whose viewpoint went dark at 19:00
 * is a mistake in exactly the unpleasant direction. The horizon
 * profile that fixes it (§7.3) is a per-spot precomputation from an
 * elevation model and belongs with the import; until it exists the
 * answer here is the unobstructed one and says so.
 */

const RAD = Math.PI / 180;
/** Obliquity of the ecliptic. */
const OBLIQUITY = 23.4397 * RAD;
/** Days from the Unix epoch to J2000.0, the reckoning these formulae use. */
const DAYS_TO_J2000 = 10_957.5;
const MS_PER_DAY = 86_400_000;

export interface Coordinate {
  lat: number;
  lon: number;
}

export interface SolarPosition {
  /** Degrees above the horizon; negative below it. */
  altitude: number;
  /** Compass degrees, clockwise from north: 90 is due east. */
  azimuth: number;
}

/** Terrain elevation above the mathematical horizon for a compass bearing. */
export interface HorizonPoint {
  azimuth: number;
  altitude: number;
}

export type HorizonProfile = readonly HorizonPoint[];

/**
 * The sun's position as seen from `at`, at `when`.
 *
 * Astronomical altitude: no refraction correction and no terrain. Both
 * matter less than a degree, which is less than the block structure can
 * express.
 */
export function solarPosition(at: Coordinate, when: Date): SolarPosition {
  const d = when.getTime() / MS_PER_DAY - DAYS_TO_J2000;

  // Mean anomaly, then the equation of centre, then the ecliptic
  // longitude of the sun.
  const meanAnomaly = RAD * (357.5291 + 0.98560028 * d);
  const centre = RAD * (1.9148 * Math.sin(meanAnomaly)
    + 0.02 * Math.sin(2 * meanAnomaly)
    + 0.0003 * Math.sin(3 * meanAnomaly));
  const perihelion = RAD * 102.9372;
  const eclipticLongitude = meanAnomaly + centre + perihelion + Math.PI;

  const declination = Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.sin(eclipticLongitude) * Math.cos(OBLIQUITY),
    Math.cos(eclipticLongitude),
  );

  const west = RAD * -at.lon;
  const siderealTime = RAD * (280.16 + 360.9856235 * d) - west;
  const hourAngle = siderealTime - rightAscension;

  const phi = RAD * at.lat;
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(declination)
    + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle),
  );
  // The formula answers from due south, clockwise; the half-turn puts
  // it on the compass, where everybody else keeps their bearings.
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  ) + Math.PI;

  return {
    altitude: altitude / RAD,
    azimuth: ((azimuth / RAD) % 360 + 360) % 360,
  };
}

/**
 * The kinds of light worth saying something about (§7.3).
 *
 * `harsh` is the odd one out: it is not a recommendation but a warning
 * for façades, and the same hour is the good one for courtyards and
 * water. The screen decides what to make of it; this module only says
 * where the sun is.
 */
export type LightKind = "golden" | "blue" | "harsh";

export interface LightWindow {
  kind: LightKind;
  /** Inclusive start, as an ISO-8601 instant in UTC. */
  from: string;
  /** Inclusive end, as an ISO-8601 instant in UTC. */
  to: string;
  /** Minutes past local midnight, using the offset the caller gave. */
  fromMinutes: number;
  toMinutes: number;
}

/** Altitude bands, in degrees. Straight from §7.3. */
const BANDS: Readonly<Record<LightKind, { min: number; max: number }>> = {
  blue: { min: -6, max: -4 },
  golden: { min: -4, max: 6 },
  harsh: { min: 50, max: 90 },
};

/**
 * Every window of the given day in which the light is one of the three
 * kinds, in the order they occur.
 *
 * Sampled minute by minute rather than solved analytically. A minute is
 * an order of magnitude finer than any statement the planner makes, the
 * cost is a few thousand cheap trigonometric evaluations, and it cannot
 * quietly miss a band the way a root-finder can when the sun grazes it
 * — which is exactly what happens near the poles, where a naive solver
 * returns a sunset that never occurs.
 *
 * `utcOffsetMinutes` is the offset of the place being asked about, not
 * of the person asking: the local times below are what a clock at the
 * spot would read. It has to be passed in, because a coordinate does
 * not carry its time zone and inventing one from the longitude would be
 * wrong across most of Europe and all of China.
 */
export function lightWindows(
  at: Coordinate,
  isoDay: string,
  utcOffsetMinutes = 0,
  horizon: HorizonProfile = [],
): LightWindow[] {
  const startOfLocalDay = Date.parse(`${isoDay}T00:00:00Z`) - utcOffsetMinutes * 60_000;
  if (!Number.isFinite(startOfLocalDay)) {
    throw new Error(`not a calendar date: ${isoDay}`);
  }

  const windows: LightWindow[] = [];
  const open = new Map<LightKind, number>();

  const close = (kind: LightKind, startMinute: number, endMinute: number) => {
    windows.push({
      kind,
      from: new Date(startOfLocalDay + startMinute * 60_000).toISOString(),
      to: new Date(startOfLocalDay + endMinute * 60_000).toISOString(),
      fromMinutes: startMinute,
      toMinutes: endMinute,
    });
  };

  for (let minute = 0; minute <= 1440; minute++) {
    const altitude = minute === 1440
      ? Number.NaN
      : adjustedAltitude(
        at,
        new Date(startOfLocalDay + minute * 60_000),
        horizon,
      );

    for (const kind of Object.keys(BANDS) as LightKind[]) {
      const band = BANDS[kind];
      const inside = altitude >= band.min && altitude <= band.max;
      const startedAt = open.get(kind);
      if (inside && startedAt === undefined) {
        open.set(kind, minute);
      } else if (!inside && startedAt !== undefined) {
        // A single sampled minute is not a window worth naming.
        if (minute - startedAt >= 2) close(kind, startedAt, minute - 1);
        open.delete(kind);
      }
    }
  }

  return windows.sort((a, b) => a.fromMinutes - b.fromMinutes);
}

/** Subtract the terrain angle at the sun's bearing, interpolating circularly. */
export function adjustedAltitude(
  at: Coordinate,
  when: Date,
  horizon: HorizonProfile,
): number {
  const position = solarPosition(at, when);
  return position.altitude - horizonAltitude(horizon, position.azimuth);
}

export function horizonAltitude(profile: HorizonProfile, azimuth: number): number {
  if (profile.length === 0) return 0;
  const points = [...profile]
    .filter((point) => Number.isFinite(point.azimuth) && Number.isFinite(point.altitude))
    .map((point) => ({
      azimuth: ((point.azimuth % 360) + 360) % 360,
      altitude: point.altitude,
    }))
    .sort((a, b) => a.azimuth - b.azimuth);
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].altitude;

  const bearing = ((azimuth % 360) + 360) % 360;
  let before = points[points.length - 1];
  let after = points[0];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.azimuth <= bearing) before = point;
    if (point.azimuth >= bearing) {
      after = point;
      break;
    }
  }
  const beforeAzimuth = before.azimuth > after.azimuth ? before.azimuth - 360 : before.azimuth;
  const afterAzimuth = after.azimuth < before.azimuth ? after.azimuth + 360 : after.azimuth;
  const target = bearing < beforeAzimuth ? bearing + 360 : bearing;
  const span = afterAzimuth - beforeAzimuth;
  if (span <= 0) return before.altitude;
  const fraction = (target - beforeAzimuth) / span;
  return before.altitude + (after.altitude - before.altitude) * fraction;
}
