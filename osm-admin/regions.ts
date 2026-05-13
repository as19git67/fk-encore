/**
 * Admin endpoints for self-hosted OSM region imports (Epic #383).
 *
 * Read-only at this stage: the endpoints expose what's currently in
 * `osm_region_imports` so the upcoming admin UI can render the table
 * and the upcoming router can be wired against a stable contract.
 * Mutating endpoints (POST/DELETE, approval, refresh) land in the next
 * slice once the dockerode-driven importer is in place.
 */

import { api } from "encore.dev/api";
import { desc } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getAuthData } from "~encore/auth";

export interface OsmRegionImport {
  slug: string;
  geofabrikUrl: string;
  pbfSizeMb: number | null;
  postgresDb: string;
  bbox: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
  status: string;
  lastUsedAt: string | null;
  importedAt: string | null;
  replicationSeq: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListRegionsResponse {
  regions: OsmRegionImport[];
}

/**
 * List all known region imports along with their lifecycle status.
 *
 * Empty until the importer (next slice) starts populating rows.
 */
export const listRegions = api(
  { expose: true, auth: true, method: "GET", path: "/osm/regions" },
  async (): Promise<ListRegionsResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    const rows = await db
      .select()
      .from(osmRegionImports)
      .orderBy(desc(osmRegionImports.created_at));
    return {
      regions: rows.map((r) => ({
        slug: r.slug,
        geofabrikUrl: r.geofabrik_url,
        pbfSizeMb: r.pbf_size_mb ?? null,
        postgresDb: r.postgres_db,
        bbox: {
          minLat: r.bbox_min_lat,
          minLon: r.bbox_min_lon,
          maxLat: r.bbox_max_lat,
          maxLon: r.bbox_max_lon,
        },
        status: r.status,
        lastUsedAt: r.last_used_at,
        importedAt: r.imported_at,
        replicationSeq: r.replication_seq,
        lastError: r.last_error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  },
);
