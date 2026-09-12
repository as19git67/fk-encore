/**
 * "Does this database actually hold that place?" — the question a
 * bounding box cannot answer.
 *
 * The region router picks a database by bbox, because a bbox is cheap
 * and indexed. But a Geofabrik extract is cut along administrative
 * boundaries and its bbox is the rectangle around them, so the two
 * disagree wherever a region is not rectangular — which is everywhere.
 * Italy's Nord-Ovest extends south to about 43.7°, so its rectangle
 * covers Pisa and Florence while its data stops at the Tuscan border. A
 * trip to Pisa was routed to it and came back with no spots at all,
 * and nothing in the answer said why.
 *
 * So the router asks the data instead of the rectangle. One boolean,
 * one indexed predicate, no categories: this is not "is there anything
 * worth seeing here", it is "was this corner of the world imported".
 */

import { poolFor } from "./db.ts";

/**
 * How far around the point counts as covered.
 *
 * Generous on purpose. A hotel on the edge of an extract is inside it,
 * and the failure this guards against is a region that is *hundreds* of
 * kilometres off — the border case is not what it has to decide. Too
 * small a radius would reject a correct region over an empty valley.
 */
export const DEFAULT_COVERAGE_RADIUS_M = 25_000;

/** True when the database holds any POI within the radius. */
export async function hasCoverage(
  database: string,
  lat: number,
  lon: number,
  radiusM: number = DEFAULT_COVERAGE_RADIUS_M,
): Promise<boolean> {
  // EXISTS rather than a count: the answer is a boolean, and the
  // planner's question is "is this the right database", not "how rich
  // is it". Postgres stops at the first row.
  const res = await poolFor(database).query<{ covered: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM osm_pois
       WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ) AS covered`,
    [lon, lat, radiusM],
  );
  return res.rows[0]?.covered === true;
}
