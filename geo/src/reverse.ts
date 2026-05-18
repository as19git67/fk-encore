/**
 * Reverse geocoding against a per-region PostGIS database.
 *
 * Returns the same shape `proxy.ts → reverseGeocode` used to forward
 * from Nominatim, so the existing photo service and frontend keep
 * working unchanged:
 *
 *   { address: { road, house_number, city, country, … }, display_name }
 *
 * Strategy: three independent index-backed queries against the region
 * DB, then assemble the address object in JS. Each query is bounded
 * by ST_DWithin to ensure the planner uses the GIST index instead of
 * a full table scan.
 */

import { poolFor } from "./db.ts";

const STREET_RADIUS_M = 100;
const POI_RADIUS_M = 30;

export interface ReverseAddress {
  road?: string;
  house_number?: string;
  pedestrian?: string;
  footway?: string;
  path?: string;
  tourism?: string;
  amenity?: string;
  building?: string;
  leisure?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
}

export interface ReverseResult {
  display_name: string;
  address: ReverseAddress;
}

export async function reverseGeocode(
  database: string,
  lat: number,
  lon: number,
): Promise<ReverseResult> {
  const pool = poolFor(database);
  const point = `ST_SetSRID(ST_Point($1, $2), 4326)`;

  const [streetRes, poiRes, adminRes] = await Promise.all([
    pool.query<{ name: string | null; highway: string | null; housenumber: string | null }>(
      `SELECT name, highway, housenumber
       FROM osm_highways
       WHERE ST_DWithin(geom::geography, ${point}::geography, $3)
       ORDER BY geom <-> ${point}
       LIMIT 1`,
      [lon, lat, STREET_RADIUS_M],
    ),
    pool.query<{ name: string | null; kind: string | null }>(
      `SELECT name, kind
       FROM osm_pois
       WHERE ST_DWithin(geom::geography, ${point}::geography, $3)
       ORDER BY geom <-> ${point}
       LIMIT 1`,
      [lon, lat, POI_RADIUS_M],
    ),
    pool.query<{ name: string | null; admin_level: number }>(
      `SELECT name, admin_level
       FROM osm_admin
       WHERE ST_Contains(geom, ${point})
       ORDER BY admin_level DESC`,
      [lon, lat],
    ),
  ]);

  const address: ReverseAddress = {};

  const street = streetRes.rows[0];
  if (street?.name) {
    const hwy = street.highway ?? "";
    if (hwy === "pedestrian") address.pedestrian = street.name;
    else if (hwy === "footway") address.footway = street.name;
    else if (hwy === "path") address.path = street.name;
    else address.road = street.name;
    if (street.housenumber) address.house_number = street.housenumber;
  }

  const poi = poiRes.rows[0];
  if (poi?.name && poi.kind) {
    const [key] = poi.kind.split("=");
    if (key === "tourism") address.tourism = poi.name;
    else if (key === "amenity") address.amenity = poi.name;
    else if (key === "building") address.building = poi.name;
    else if (key === "historic") address.tourism = poi.name; // Nominatim parity
    else if (key === "man_made") address.building = poi.name;
  }

  // admin_level mapping follows the OSM wiki convention used in
  // Germany (2 = country, 4 = state, 6 = Regierungsbezirk/county,
  // 8 = city/Gemeinde, 10 = Stadtteil). The mapping for other
  // countries is approximate but matches what Nominatim emits.
  for (const a of adminRes.rows) {
    if (!a.name) continue;
    switch (a.admin_level) {
      case 2:  if (!address.country)      address.country = a.name; break;
      case 4:  if (!address.state)        address.state = a.name; break;
      case 6:  if (!address.county)       address.county = a.name; break;
      case 7:  if (!address.county)       address.county = a.name; break;
      case 8:  if (!address.city)         address.city = a.name; break;
      case 9:  if (!address.municipality) address.municipality = a.name; break;
      case 10: if (!address.village)      address.village = a.name; break;
    }
  }

  // display_name: join the most specific parts top-down, matching the
  // photo service's expectations (`addr.city, addr.country` fallback).
  const parts: string[] = [];
  if (address.road)
    parts.push(address.house_number ? `${address.road} ${address.house_number}` : address.road);
  else if (address.tourism) parts.push(address.tourism);
  else if (address.pedestrian) parts.push(address.pedestrian);
  if (address.city && address.city !== parts[0]) parts.push(address.city);
  else if (address.village && address.village !== parts[0]) parts.push(address.village);
  else if (address.municipality) parts.push(address.municipality);
  if (address.country) parts.push(address.country);

  return { display_name: parts.join(", "), address };
}
