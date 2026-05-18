/**
 * POI candidate lookup — direct PostGIS replacement for the Overpass
 * radius+tag-filter query in osm-admin/overpass-client.ts.
 *
 * The wire shape mirrors what fetchPoiCandidates returns so the
 * caller can drop in a one-line URL swap with no parser changes.
 */

import { poolFor } from "./db.ts";

export interface PoiCandidate {
  osmRef: string;
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  distanceM: number;
  name: string | null;
  nameDe: string | null;
  primaryTag: string | null;
  wikidataQid: string | null;
  wikipedia: string | null;
}

export interface PoiQueryOptions {
  /** Defaults to 200 m to match POI_RADIUS_M. */
  radiusM?: number;
  /** Defaults to 25 to match POI_MAX_CANDIDATES. */
  maxCandidates?: number;
  /**
   * Optional override of the tag filters. When omitted, the
   * built-in defaults below (in sync with poi.config.ts) apply.
   */
  filters?: PoiTagFilters;
}

export interface PoiTagFilters {
  tourism?: readonly string[];
  amenity?: readonly string[];
  building?: readonly string[];
  manMade?: readonly string[];
  /** When true, every value of `historic` matches. */
  historicAny?: boolean;
}

const DEFAULT_FILTERS: PoiTagFilters = {
  tourism: ["attraction", "museum", "artwork", "viewpoint", "gallery", "monument"],
  amenity: ["place_of_worship", "theatre"],
  building: ["castle", "cathedral", "church", "monastery", "palace"],
  manMade: ["tower", "lighthouse", "bridge", "obelisk"],
  historicAny: true,
};

type Row = {
  osm_type: string;
  osm_id: string;          // bigint comes back as string in node-pg
  name: string | null;
  name_de: string | null;
  kind: string | null;
  wikidata: string | null;
  wikipedia: string | null;
  lat: number;
  lon: number;
  distance_m: number;
};

export async function findPoiCandidates(
  database: string,
  lat: number,
  lon: number,
  opts: PoiQueryOptions = {},
): Promise<PoiCandidate[]> {
  const pool = poolFor(database);
  const radius = opts.radiusM ?? 200;
  const limit = opts.maxCandidates ?? 25;
  const f = { ...DEFAULT_FILTERS, ...(opts.filters ?? {}) };

  const conditions: string[] = [];
  const params: unknown[] = [lon, lat, radius, limit];
  let nextParam = params.length + 1;

  if (f.tourism && f.tourism.length > 0) {
    conditions.push(`tags->>'tourism' = ANY($${nextParam}::text[])`);
    params.push([...f.tourism]); nextParam += 1;
  }
  if (f.amenity && f.amenity.length > 0) {
    conditions.push(`tags->>'amenity' = ANY($${nextParam}::text[])`);
    params.push([...f.amenity]); nextParam += 1;
  }
  if (f.building && f.building.length > 0) {
    conditions.push(`tags->>'building' = ANY($${nextParam}::text[])`);
    params.push([...f.building]); nextParam += 1;
  }
  if (f.manMade && f.manMade.length > 0) {
    conditions.push(`tags->>'man_made' = ANY($${nextParam}::text[])`);
    params.push([...f.manMade]); nextParam += 1;
  }
  if (f.historicAny) {
    conditions.push(`tags ? 'historic'`);
  }
  if (conditions.length === 0) return [];

  const tagPredicate = conditions.join(" OR ");
  const point = `ST_SetSRID(ST_Point($1, $2), 4326)`;

  const sql = `
    SELECT
      osm_type,
      osm_id::text                 AS osm_id,
      tags->>'name'                AS name,
      tags->>'name:de'             AS name_de,
      kind,
      tags->>'wikidata'            AS wikidata,
      tags->>'wikipedia'           AS wikipedia,
      ST_Y(geom)                   AS lat,
      ST_X(geom)                   AS lon,
      ST_DistanceSphere(geom, ${point}) AS distance_m
    FROM osm_pois
    WHERE ST_DWithin(geom::geography, ${point}::geography, $3)
      AND (${tagPredicate})
    ORDER BY geom <-> ${point}
    LIMIT $4
  `;

  const res = await pool.query<Row>(sql, params);
  return res.rows.map(rowToCandidate);
}

function rowToCandidate(r: Row): PoiCandidate {
  const type = osmTypeFromCode(r.osm_type);
  const id = Number(r.osm_id);
  return {
    osmRef: `${type}:${id}`,
    type,
    id,
    lat: Number(r.lat),
    lon: Number(r.lon),
    distanceM: Number(r.distance_m),
    name: r.name,
    nameDe: r.name_de,
    primaryTag: r.kind,
    wikidataQid: isWikidataQid(r.wikidata) ? r.wikidata : null,
    wikipedia: r.wikipedia,
  };
}

function osmTypeFromCode(code: string): "node" | "way" | "relation" {
  // osm2pgsql Flex stores N/W/R for `type = 'any'` id columns.
  if (code === "N") return "node";
  if (code === "W") return "way";
  if (code === "R") return "relation";
  return "node";
}

function isWikidataQid(s: string | null): s is string {
  return s !== null && /^Q\d+$/.test(s);
}
