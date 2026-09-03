/**
 * Throwaway PostGIS databases for tests.
 *
 * The area search is mostly SQL — radius, bounding box, tag predicate,
 * ordering, paging — so testing it against query doubles would only
 * assert that we assembled the string we meant to assemble, not that
 * the database agrees. These helpers create a real database, install
 * PostGIS, build the slice of `osm_pois` the query touches, and drop
 * everything afterwards.
 *
 * Connection details come from the same GEO_DB_* variables the service
 * uses, so a local run needs nothing but `GEO_DB_HOST=localhost`.
 */

import pg from "pg";
import { dropPool } from "./db.ts";

const HOST = process.env.GEO_DB_HOST ?? "geo-db";
const PORT = parseInt(process.env.GEO_DB_PORT ?? "5432", 10);
const USER = process.env.GEO_DB_USER ?? "postgres";
const PASSWORD = process.env.GEO_DB_PASSWORD ?? "postgres";
const ADMIN_DB = process.env.GEO_DB_ADMIN_DB ?? "postgres";

export interface SeedPoi {
  osmType?: "N" | "W" | "R";
  osmId: number;
  lat: number;
  lon: number;
  kind: string;
  tags: Record<string, string>;
  /** WKT outline for an area POI, in EPSG:4326. */
  shapeWkt?: string;
  facadeAzimuth?: number;
}

function adminClient(): pg.Client {
  return new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: ADMIN_DB });
}

/**
 * True when a PostGIS-capable server is reachable. Tests call this to
 * skip rather than fail on a machine without one — a red suite that
 * only means "no database here" trains people to ignore red suites.
 */
export async function postgisAvailable(): Promise<boolean> {
  const client = adminClient();
  try {
    await client.connect();
    const res = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_available_extensions WHERE name = 'postgis'",
    );
    return Number(res.rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Create a database named `name`, install PostGIS and an `osm_pois`
 * table shaped like the one osm2pgsql produces, then seed it.
 */
export async function createSeededRegion(name: string, pois: readonly SeedPoi[]): Promise<void> {
  await dropRegion(name);

  const admin = adminClient();
  await admin.connect();
  try {
    // Identifiers cannot be parameterised; the caller-supplied name is
    // restricted to the same character class the service enforces.
    if (!/^[a-z0-9_]{1,50}$/.test(name)) {
      throw new Error(`test database name must match [a-z0-9_]{1,50}, got '${name}'`);
    }
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end().catch(() => {});
  }

  const client = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: name });
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await client.query(`
      CREATE TABLE osm_pois (
        osm_id         bigint,
        osm_type       char(1),
        kind           text,
        name           text,
        tags           jsonb,
        geom           geometry(Point, 4326) NOT NULL,
        shape          geometry(Geometry, 4326),
        facade_azimuth real
      )
    `);
    await client.query("CREATE INDEX osm_pois_geom_idx ON osm_pois USING GIST (geom)");

    for (const poi of pois) {
      await client.query(
        `INSERT INTO osm_pois (osm_id, osm_type, kind, name, tags, geom, shape, facade_azimuth)
         VALUES ($1, $2, $3, $4, $5::jsonb, ST_SetSRID(ST_Point($6, $7), 4326),
                 CASE WHEN $8::text IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_GeomFromText($8), 4326) END,
                 $9)`,
        [
          poi.osmId,
          poi.osmType ?? "N",
          poi.kind,
          poi.tags.name ?? null,
          JSON.stringify(poi.tags),
          poi.lon,
          poi.lat,
          poi.shapeWkt ?? null,
          poi.facadeAzimuth ?? null,
        ],
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Drop the database and the service's cached pool for it. */
export async function dropRegion(name: string): Promise<void> {
  await dropPool(name).catch(() => {});
  const admin = adminClient();
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } catch {
    // A missing database is the normal case on first run.
  } finally {
    await admin.end().catch(() => {});
  }
}
