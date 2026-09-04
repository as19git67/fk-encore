/**
 * What a region database actually costs on disk, and where it goes.
 *
 * `/status` already reports the total size per region, which answers
 * "how full is the volume". It does not answer the question the import
 * rework raises (docs/ios-urlaubsplanung.md §13.0): **how much did
 * carrying gastronomy and everyday infrastructure add?** For that the
 * total has to be broken down, because most of a region's bytes are the
 * osm2pgsql slim middle tables — kept so replication can append — and
 * those barely move when the POI filter widens.
 *
 * Two numbers matter, and they are easy to confuse: `totalMb` includes
 * indexes and TOAST, which is what fills a volume; `tableMb` is the heap
 * alone, which is what a wider filter directly inflates. Both are
 * reported rather than one, so a measurement cannot silently compare
 * unlike things.
 */

import { poolFor } from "./db.ts";

export interface TableStorage {
  table: string;
  /** Heap, indexes and TOAST — what the volume feels. */
  totalMb: number;
  /** Heap alone. */
  tableMb: number;
  rows: number;
}

export interface KindCount {
  kind: string;
  count: number;
}

export interface RegionStorage {
  database: string;
  sizeMb: number;
  tables: TableStorage[];
  /** POI rows per matched OSM tag, biggest first. */
  poisByKind: KindCount[];
  poiTotal: number;
  /** Area POIs that carry an outline, and how many have an azimuth. */
  poisWithShape: number;
  poisWithFacadeAzimuth: number;
}

/** Only the tables this service owns or depends on, in a stable order. */
const TABLES = [
  "osm_pois",
  "osm_highways",
  "osm_admin",
  "planet_osm_nodes",
  "planet_osm_ways",
  "planet_osm_rels",
] as const;

export async function readRegionStorage(database: string): Promise<RegionStorage> {
  const pool = poolFor(database);

  const size = await pool.query<{ size_mb: string }>(
    "SELECT (pg_database_size(current_database()) / 1024.0 / 1024.0)::text AS size_mb",
  );

  // `to_regclass` returns null instead of raising for a table that does
  // not exist, so a half-imported region reports what it has rather
  // than failing the whole call.
  const tables = await pool.query<{
    table: string;
    total_mb: string;
    table_mb: string;
    rows: string;
  }>(
    `
    SELECT t.name                                                        AS table,
           (pg_total_relation_size(c.oid) / 1024.0 / 1024.0)::text       AS total_mb,
           (pg_table_size(c.oid) / 1024.0 / 1024.0)::text                AS table_mb,
           COALESCE(s.n_live_tup, 0)::text                               AS rows
      FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord)
      JOIN pg_class c ON c.oid = to_regclass(t.name)
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     ORDER BY t.ord
    `,
    [[...TABLES]],
  );

  // `n_live_tup` is the stats collector's running count, not a catalog
  // fact — a server restart (or pg_stat_reset) zeroes it for every table
  // until something touches the table again: a write, or ANALYZE. A
  // region whose replication is paused (e.g. ahead of a reimport) can
  // sit at a stale 0 indefinitely while actively-replicated regions look
  // fine, which reads as "this region is empty" even though it isn't.
  // Refreshing just the tables reporting 0 keeps the common case (stats
  // already warm) free of extra queries.
  const staleTables = tables.rows.filter((r) => r.rows === "0").map((r) => r.table);
  if (staleTables.length > 0) {
    for (const table of staleTables) {
      await pool.query(`ANALYZE ${table}`);
    }
    const refreshed = await pool.query<{ table: string; rows: string }>(
      `
      SELECT t.name AS table, COALESCE(s.n_live_tup, 0)::text AS rows
        FROM unnest($1::text[]) AS t(name)
        JOIN pg_class c ON c.oid = to_regclass(t.name)
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      `,
      [staleTables],
    );
    const refreshedRows = new Map(refreshed.rows.map((r) => [r.table, r.rows]));
    for (const r of tables.rows) {
      const updated = refreshedRows.get(r.table);
      if (updated !== undefined) r.rows = updated;
    }
  }

  const hasPois = tables.rows.some((r) => r.table === "osm_pois");
  const byKind = hasPois
    ? await pool.query<{ kind: string; count: string }>(
        `SELECT COALESCE(kind, '(none)') AS kind, count(*)::text AS count
           FROM osm_pois
          GROUP BY 1
          ORDER BY count(*) DESC, 1`,
      )
    : { rows: [] as { kind: string; count: string }[] };

  // A region imported before the `shape`/`facade_azimuth` columns were
  // added to the osm2pgsql schema still has an `osm_pois` table without
  // them — osm2pgsql only applies this schema on create, it doesn't
  // migrate existing tables. Check for the columns rather than assuming
  // they exist, so an old region reports what it has instead of a 500.
  const hasShapeColumns = hasPois
    ? await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'osm_pois' AND column_name IN ('shape', 'facade_azimuth')`,
      )
    : { rows: [] as { column_name: string }[] };
  const columnNames = new Set(hasShapeColumns.rows.map((r) => r.column_name));

  const shapes =
    hasPois && columnNames.has("shape") && columnNames.has("facade_azimuth")
      ? await pool.query<{ total: string; with_shape: string; with_azimuth: string }>(
          `SELECT count(*)::text                                              AS total,
                  count(*) FILTER (WHERE shape IS NOT NULL)::text             AS with_shape,
                  count(*) FILTER (WHERE facade_azimuth IS NOT NULL)::text    AS with_azimuth
             FROM osm_pois`,
        )
      : {
          rows: [
            {
              total: hasPois ? String(byKind.rows.reduce((n, r) => n + Number(r.count), 0)) : "0",
              with_shape: "0",
              with_azimuth: "0",
            },
          ],
        };

  const counts = shapes.rows[0] ?? { total: "0", with_shape: "0", with_azimuth: "0" };

  return {
    database,
    sizeMb: round2(size.rows[0]?.size_mb),
    tables: tables.rows.map((r) => ({
      table: r.table,
      totalMb: round2(r.total_mb),
      tableMb: round2(r.table_mb),
      rows: Number(r.rows),
    })),
    poisByKind: byKind.rows.map((r) => ({ kind: r.kind, count: Number(r.count) })),
    poiTotal: Number(counts.total),
    poisWithShape: Number(counts.with_shape),
    poisWithFacadeAzimuth: Number(counts.with_azimuth),
  };
}

function round2(value: string | undefined): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}
