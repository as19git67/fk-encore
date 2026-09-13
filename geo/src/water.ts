/**
 * "Is there a lake in the way?" (§4.5, §14).
 *
 * The planner has no router. It estimates a journey as the straight
 * line times a per-mode detour factor — 1.4 for a car — which is a fair
 * average over a road network that goes roughly where you want. A lake
 * is not an average. From the east shore of Lake Garda to Lago d'Idro
 * is twenty kilometres straight, so the planner says twenty-eight; the
 * road goes around the north end and it is seventy.
 *
 * That is worse than a wrong number on a card: the leg limit decides
 * which spots may enter a day at all, so an underestimate lets in
 * places nobody can reach.
 *
 * A router is the real answer and a large piece of work (§14). This is
 * the cheap half of it, and it is possible because the data is already
 * here: named water bodies are imported as POIs *with their geometry*
 * (`shape`), for lakes as closed ways and as multipolygon relations
 * alike. Asking whether a straight line crosses one is a single
 * indexed query.
 *
 * ## What it does not know
 *
 * Only **named** water is imported (`poi_name_required`), which is the
 * right rule for a POI list and a limitation here: an unnamed reservoir
 * is invisible. Rivers are mostly `waterway=*` lines rather than
 * `natural=water` polygons, so a river crossing usually does not
 * register — which is no great loss, since rivers have bridges and
 * lakes do not.
 *
 * And it says nothing about *where* the way round is. That is the
 * caller's estimate to make, from the size of the thing in the way.
 */

import { poolFor } from "./db.ts";

export interface WaterCrossing {
  /** Metres of the straight line that lie on water. */
  crossedM: number;
  /** The longest single crossing, when several bodies are in the way. */
  widestM: number;
  /**
   * How long the biggest body in the way is, corner to corner of its
   * bounding box. What going around it costs is some fraction of this;
   * the fraction is a judgement the caller makes.
   */
  extentM: number;
  /** What that body is called. Always set — only named water is imported. */
  name: string | null;
}

const NOTHING: WaterCrossing = { crossedM: 0, widestM: 0, extentM: 0, name: null };

/**
 * How much water the straight line from A to B crosses.
 *
 * One row per water body in the way, biggest crossing first. The sum is
 * what the journey would have to swim; the first row is what it has to
 * go around.
 */
export async function waterCrossing(
  database: string,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<WaterCrossing> {
  const res = await poolFor(database).query<{
    name: string | null;
    crossed_m: number;
    extent_m: number;
  }>(
    `WITH line AS (
       SELECT ST_SetSRID(
         ST_MakeLine(ST_MakePoint($1, $2), ST_MakePoint($3, $4)), 4326) AS g
     )
     SELECT p.name,
            ST_Length(ST_Intersection(p.shape, line.g)::geography)   AS crossed_m,
            ST_Distance(
              ST_SetSRID(ST_MakePoint(ST_XMin(p.shape), ST_YMin(p.shape)), 4326)::geography,
              ST_SetSRID(ST_MakePoint(ST_XMax(p.shape), ST_YMax(p.shape)), 4326)::geography
            )                                                        AS extent_m
     FROM osm_pois p, line
     WHERE p.kind = 'natural=water'
       AND p.shape IS NOT NULL
       AND ST_Intersects(p.shape, line.g)
     ORDER BY crossed_m DESC
     LIMIT 20`,
    [from.lon, from.lat, to.lon, to.lat],
  );

  if (res.rows.length === 0) return NOTHING;

  const crossedM = res.rows.reduce((sum, row) => sum + Number(row.crossed_m ?? 0), 0);
  const biggest = res.rows[0];
  return {
    crossedM: Math.round(crossedM),
    widestM: Math.round(Number(biggest.crossed_m ?? 0)),
    extentM: Math.round(Number(biggest.extent_m ?? 0)),
    name: biggest.name,
  };
}
