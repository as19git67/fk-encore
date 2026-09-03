/**
 * Deriving a building's facade orientation from its outline.
 *
 * The planner uses this to say when a spot stands in good light: a
 * facade is front-lit while the sun sits in the half-space it faces
 * (docs/ios-urlaubsplanung.md §7.3). Sun position is pure arithmetic on
 * the planner's side; the one thing it cannot know is which way the
 * building looks.
 *
 * The outline reaches us only during the import — `osm_pois` otherwise
 * keeps a centroid — so the azimuth is computed once, here, and stored
 * as a column. At planning time it is then a comparison of two angles.
 *
 * Method: the **oriented envelope** — the smallest rotated rectangle
 * containing the outline — and the direction of its longest side. That
 * is more robust than "the longest edge of the polygon", which a single
 * long back wall or a mapping artefact can throw off, and it needs no
 * vertex walking. Round and highly articulated buildings have no
 * meaningful orientation and simply get a value that means little; the
 * planner weights light lightly for exactly that reason.
 *
 * The value is the azimuth of the facade *normal* in degrees clockwise
 * from north, in [0, 180): a wall running east-west faces either north
 * or south, and which of the two cannot be known from the outline
 * alone. The caller resolves that ambiguity against the sun.
 */

import { poolFor } from "./db.ts";

/**
 * Compute the azimuth for every area POI that does not have one yet.
 *
 * Incremental on purpose: replication appends re-insert rows with an
 * outline and no azimuth, so this runs after an import *and* after an
 * update, and does no work when there is nothing new.
 */
export async function refreshFacadeAzimuth(database: string): Promise<number> {
  const pool = poolFor(database);
  const res = await pool.query(FACADE_AZIMUTH_SQL);
  return res.rowCount ?? 0;
}

/**
 * Exported for the test, which runs it against a seeded table rather
 * than a full import.
 *
 * ST_OrientedEnvelope returns a rectangle whose first ring holds five
 * points (the last repeating the first). The two edges leaving the
 * first corner are its sides; the longer one gives the building's
 * principal direction, and the facade normal is perpendicular to it.
 * `degrees(ST_Azimuth(...))` is measured clockwise from north, so
 * adding 90 turns the side into the normal, and the modulo folds the
 * two opposite directions into one value.
 */
export const FACADE_AZIMUTH_SQL = `
  WITH env AS (
    SELECT
      osm_id,
      osm_type,
      ST_PointN(ST_ExteriorRing(ST_OrientedEnvelope(shape)), 1) AS p1,
      ST_PointN(ST_ExteriorRing(ST_OrientedEnvelope(shape)), 2) AS p2,
      ST_PointN(ST_ExteriorRing(ST_OrientedEnvelope(shape)), 3) AS p3
    FROM osm_pois
    WHERE shape IS NOT NULL
      AND facade_azimuth IS NULL
      AND ST_GeometryType(shape) IN ('ST_Polygon', 'ST_MultiPolygon')
  ), sides AS (
    SELECT
      osm_id,
      osm_type,
      CASE
        WHEN ST_Distance(p1::geography, p2::geography)
             >= ST_Distance(p2::geography, p3::geography)
        THEN degrees(ST_Azimuth(p1, p2))
        ELSE degrees(ST_Azimuth(p2, p3))
      END AS side_azimuth
    FROM env
    WHERE p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL
  )
  UPDATE osm_pois p
     -- Round *before* the final fold. Floating error puts a facade that
     -- faces exactly north at 179.999…, and without the rounding it
     -- would be stored as 180 — a value outside the [0, 180) range this
     -- column promises, and the opposite end of the scale from where it
     -- belongs.
     SET facade_azimuth =
       round((((sides.side_azimuth + 90)::numeric % 180) + 180) % 180, 3) % 180
    FROM sides
   WHERE p.osm_id = sides.osm_id
     AND p.osm_type = sides.osm_type
     AND p.facade_azimuth IS NULL
`;
