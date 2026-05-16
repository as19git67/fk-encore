/**
 * Admin endpoints for self-hosted OSM region imports (Epic #383).
 *
 * The endpoints in this file are the stable HTTP contract the admin UI
 * and the photo POI worker code against. The state transitions
 * persisted here are real; the dockerode-driven container provisioning
 * that turns `importing` rows into `ready_running` containers lands in
 * a follow-up slice.
 */

import { api, APIError } from "encore.dev/api";
import { desc } from "drizzle-orm";
import db from "../db/database";
import { osmRegionImports } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import { getAuthData } from "~encore/auth";
import {
  approve,
  createPending,
  remove,
  suggestForCoord,
  type RegionSuggestion,
} from "./region.service";
import type { RegionStatus } from "./state-machine";

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

export interface SuggestRegionRequest {
  lat: number;
  lon: number;
}

export interface SuggestRegionResponse {
  region: RegionSuggestion | null;
}

/**
 * Look up the smallest Geofabrik region that covers the given GPS
 * coordinates. Read-only — does not persist anything. Used by the
 * photo POI worker before enqueuing an import job, and by the admin UI
 * for ad-hoc lookups.
 */
export const suggestRegion = api(
  { expose: true, auth: true, method: "POST", path: "/osm/regions/suggest" },
  async (req: SuggestRegionRequest): Promise<SuggestRegionResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    validateLatLon(req.lat, req.lon);
    const region = await suggestForCoord(req.lat, req.lon);
    return { region };
  },
);

export interface CreateRegionRequest {
  slug: string;
}

export interface CreateRegionResponse {
  slug: string;
  status: RegionStatus;
  created: boolean;
}

/**
 * Insert a region row in `pending_approval` (or `importing` if the
 * region is small enough to auto-approve). Idempotent: returns the
 * existing row's status unchanged if the slug is already tracked.
 */
export const createRegion = api(
  { expose: true, auth: true, method: "POST", path: "/osm/regions" },
  async (req: CreateRegionRequest): Promise<CreateRegionResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    if (!req.slug || typeof req.slug !== "string") {
      throw APIError.invalidArgument("slug is required");
    }
    try {
      return await createPending(req.slug);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.startsWith("unknown Geofabrik region")) {
        throw APIError.notFound(msg);
      }
      throw err;
    }
  },
);

export interface ApproveRegionRequest {
  slug: string;
}

export interface ApproveRegionResponse {
  slug: string;
  status: RegionStatus;
}

/**
 * Approve a region currently sitting in `pending_approval`. Moves the
 * row to `importing` so the importer worker can pick it up. Idempotent
 * for rows already in `importing`.
 *
 * The slug travels in the request body, not the path: Geofabrik slugs
 * are multi-segment (`europe/germany/bayern/oberbayern`) and Encore.ts'
 * path matcher does not transparently decode percent-encoded slashes.
 */
export const approveRegion = api(
  { expose: true, auth: true, method: "POST", path: "/osm/regions/approve" },
  async (req: ApproveRegionRequest): Promise<ApproveRegionResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    if (!req.slug || typeof req.slug !== "string") {
      throw APIError.invalidArgument("slug is required");
    }
    try {
      const status = await approve(req.slug);
      return { slug: req.slug, status };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg.startsWith("unknown region")) {
        throw APIError.notFound(msg);
      }
      if (msg.startsWith("invalid region status transition")) {
        throw APIError.failedPrecondition(msg);
      }
      throw err;
    }
  },
);

export interface DeleteRegionRequest {
  slug: string;
}

export interface DeleteRegionResponse {
  slug: string;
  deleted: boolean;
}

/**
 * Drop a region row. Once the dockerode driver is wired in for cleanup,
 * this will also stop the containers and drop the named volumes.
 *
 * Slug in body for the same multi-segment reason as approveRegion.
 */
export const deleteRegion = api(
  { expose: true, auth: true, method: "POST", path: "/osm/regions/delete" },
  async (req: DeleteRegionRequest): Promise<DeleteRegionResponse> => {
    requirePermission(getAuthData()!, "osm.admin");
    if (!req.slug || typeof req.slug !== "string") {
      throw APIError.invalidArgument("slug is required");
    }
    const deleted = await remove(req.slug);
    return { slug: req.slug, deleted };
  },
);

function validateLatLon(lat: number, lon: number): void {
  if (typeof lat !== "number" || Number.isNaN(lat) || lat < -90 || lat > 90) {
    throw APIError.invalidArgument(`lat out of range: ${lat}`);
  }
  if (typeof lon !== "number" || Number.isNaN(lon) || lon < -180 || lon > 180) {
    throw APIError.invalidArgument(`lon out of range: ${lon}`);
  }
}
