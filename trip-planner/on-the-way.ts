/**
 * What a route passes on its way (§4.7).
 *
 * The viewpoints and tunnels along the Ponale road are separate points
 * in OpenStreetMap, so the planner saw them as separate candidates and
 * gave them a block of their own. Walking the route means walking past
 * all of them — planning them again is planning the same hour twice,
 * and it is how an afternoon acquires three things it already had.
 *
 * So a spot that lies on a route the day already holds is **passed, not
 * planned**: it costs no budget, takes no place in a block, and the
 * route says it is coming. Nothing is hidden and nothing is decided for
 * good — the spot stays in the pool, and a day without that route
 * offers it again like any other.
 *
 * **Why not the corridor's ellipse.** `corridor.ts` asks what a stop
 * adds to a journey and keeps everything under a budget of extra
 * metres. That is the right question for a transfer, where the road is
 * unknown and a few kilometres of detour are the point. It is the wrong
 * one here, because the ellipse's width grows with the journey: four
 * hundred extra metres over an eight-kilometre route reaches more than
 * a kilometre off the line. This rule takes something out of the day
 * without being asked, so it is the tighter and plainer one — within
 * `CORRIDOR_HALF_WIDTH_M` of the line between the two ends.
 *
 * **What it cannot do yet.** The line between the ends is not the path:
 * the Ponale climbs in switchbacks that a chord cuts straight through,
 * so a viewpoint on the third bend is missed. That is the safe
 * direction to be wrong in — a spot not absorbed is simply planned the
 * way it always was. It is also why importing the route's own geometry
 * is the next step (§4.7): the same width against the real polyline
 * absorbs what this rule has to let through.
 *
 * Pure: coordinates in, references out.
 */

import type { SpotExtent } from "./extent";
import { haversineMeters, type Coordinate } from "./travel";

/**
 * How far off the way a spot may sit and still count as passed.
 *
 * A quarter of a kilometre: far enough for the car park beside the
 * path and the viewpoint just off it, near enough that nobody would
 * call it a detour. Deliberately a fixed width rather than a share of
 * the route — how far you would step aside has nothing to do with how
 * long the way is.
 */
export const CORRIDOR_HALF_WIDTH_M = 250;

/** The least a route must span before it can absorb anything. */
const MIN_ROUTE_LENGTH_M = 500;

/** Enough of a stop to ask the question, and no more. */
export interface Positioned extends Coordinate {
  osmRef: string;
  extent?: SpotExtent | null;
}

/**
 * How far `spot` lies from the way between `from` and `to`, in metres.
 *
 * Distance to the *segment*, not to the infinite line: a spot in line
 * with the route but well beyond its end is not on the way, it is
 * somewhere you would have to carry on to. The projection is planar and
 * local to the segment, which at the scale of a day's outing is exact
 * enough — and the last step is a haversine, so the number agrees with
 * every other distance the planner quotes.
 */
export function distanceToWayMetres(
  from: Coordinate,
  to: Coordinate,
  spot: Coordinate,
): number {
  const latScale = 110_574;
  const lonScale = 111_320 * Math.cos((from.lat * Math.PI) / 180);
  const point = (c: Coordinate) => ({
    x: (c.lon - from.lon) * lonScale,
    y: (c.lat - from.lat) * latScale,
  });

  const b = point(to);
  const p = point(spot);
  const lengthSquared = b.x * b.x + b.y * b.y;
  // A route whose ends coincide is a point; the distance to it is the
  // distance to that point.
  if (lengthSquared === 0) return haversineMeters(from, spot);

  // Where along the way the spot sits, clamped to its two ends.
  const t = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / lengthSquared));
  const nearest: Coordinate = {
    lat: from.lat + (t * b.y) / latScale,
    lon: from.lon + (t * b.x) / lonScale,
  };
  return haversineMeters(nearest, spot);
}

/**
 * Which of `candidates` this stop passes on its way.
 *
 * Empty for an ordinary point: a spot with no extent goes nowhere, so
 * it passes nothing — asking otherwise would turn every stop into a
 * hoover for its own neighbourhood. Empty too for a route shorter than
 * `MIN_ROUTE_LENGTH_M`, which has no way to speak of.
 *
 * The stop never passes itself, and another route is never passed: two
 * ways that cross are two outings, and the one nobody planned is not
 * something you saw.
 */
export function passedBy(
  stop: Positioned,
  candidates: readonly Positioned[],
  halfWidthM: number = CORRIDOR_HALF_WIDTH_M,
): Positioned[] {
  const end = stop.extent?.end;
  if (!end) return [];
  const start: Coordinate = { lat: stop.lat, lon: stop.lon };
  if (haversineMeters(start, end) < MIN_ROUTE_LENGTH_M) return [];

  return candidates.filter((candidate) => {
    if (candidate.osmRef === stop.osmRef) return false;
    if (candidate.extent?.end) return false;
    return distanceToWayMetres(start, end, candidate) <= halfWidthM;
  });
}

/**
 * Is this candidate passed by any of the stops already chosen?
 *
 * The question the fill asks before it spends budget on a spot: a
 * viewpoint along a route the block already holds is coming either way.
 */
export function isPassedByAny(
  chosen: readonly Positioned[],
  candidate: Positioned,
  halfWidthM: number = CORRIDOR_HALF_WIDTH_M,
): boolean {
  return chosen.some((stop) => passedBy(stop, [candidate], halfWidthM).length > 0);
}
