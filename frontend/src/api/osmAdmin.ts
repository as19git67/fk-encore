/**
 * Typed client for the `osm-admin` Encore service (Epic #383).
 *
 * All endpoints require the `osm.admin` permission. The shapes mirror
 * `osm-admin/regions.ts` and `osm-admin/proxy.ts` exactly so the admin
 * UI can render without hand-typed casts.
 */
import { apiFetch } from './client'

export type RegionStatus =
  | 'pending_approval'
  | 'importing'
  | 'ready_running'
  | 'ready_stopped'
  | 'blocked_disk'
  | 'failed'

export interface OsmRegionImport {
  slug: string
  geofabrikUrl: string
  pbfSizeMb: number | null
  postgresDb: string
  bbox: {
    minLat: number
    minLon: number
    maxLat: number
    maxLon: number
  }
  status: string
  lastUsedAt: string | null
  importedAt: string | null
  replicationSeq: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface RegionSuggestion {
  slug: string
  name: string
  parent: string | null
  pbfUrl: string
  bbox: {
    minLat: number
    minLon: number
    maxLat: number
    maxLon: number
  }
  pbfSizeMb: number | null
  existing: boolean
  existingStatus: RegionStatus | null
  autoApprove: boolean
}

export async function listOsmRegions(): Promise<{ regions: OsmRegionImport[] }> {
  return apiFetch('/osm/regions')
}

export async function suggestOsmRegion(
  lat: number,
  lon: number,
): Promise<{ region: RegionSuggestion | null }> {
  return apiFetch('/osm/regions/suggest', {
    method: 'POST',
    body: JSON.stringify({ lat, lon }),
  })
}

export async function createOsmRegion(
  slug: string,
): Promise<{ slug: string; status: RegionStatus; created: boolean }> {
  return apiFetch('/osm/regions', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
}

export async function approveOsmRegion(
  slug: string,
): Promise<{ slug: string; status: RegionStatus }> {
  // Slug in body: Geofabrik slugs are multi-segment (e.g.
  // `europe/germany/bayern/oberbayern`) and Encore.ts' path matcher
  // doesn't accept percent-encoded slashes in `:slug` placeholders.
  return apiFetch('/osm/regions/approve', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
}

export async function deleteOsmRegion(
  slug: string,
): Promise<{ slug: string; deleted: boolean }> {
  return apiFetch('/osm/regions/delete', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
}

export interface RefreshOsmRegionResult {
  slug: string
  ok: boolean
  replicationSeq?: string
  detail?: string
}

export async function refreshOsmRegion(slug: string): Promise<RefreshOsmRegionResult> {
  return apiFetch('/osm/regions/refresh', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
}

export interface BulkRegionSuggestion {
  slug: string
  name: string
  parent: string | null
  pbfUrl: string
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number }
  photoCount: number
  existing: boolean
  existingStatus: RegionStatus | null
  /** Photos already covered by this tracked region — no new import needed. */
  coveredByExisting: boolean
}

/** A tracked region that is redundant and could be removed. */
export interface RedundantRegion {
  slug: string
  status: RegionStatus
  /**
   * Why slug is redundant:
   * - `superseded_by_children`: all its photos are served by smaller imported sub-regions.
   * - `covered_by_ancestor`: it lies wholly inside a larger tracked region that stays.
   */
  kind: 'superseded_by_children' | 'covered_by_ancestor'
  /** The tracked regions providing the coverage (sub-regions, or the single ancestor). */
  coveringRegions: string[]
  /** PBF size of this region in MB, if known. */
  selfSizeMb: number | null
  /** Comparison size in MB: summed sub-regions, or the ancestor's size. */
  alternativeSizeMb: number | null
  /**
   * Disk-aware verdict on deleting this region:
   * - `delete`: frees space with no coverage loss.
   * - `keep`: the alternatives cost more — keep this one instead.
   * - `unknown`: a PBF size is missing, no verdict.
   */
  recommendation: 'delete' | 'keep' | 'unknown'
}

export interface BulkSuggestResult {
  geotaggedPhotoCount: number
  unmappedPhotoCount: number
  coveredPhotoCount: number
  suggestions: BulkRegionSuggestion[]
  /** Tracked regions safe to delete — all their photos are covered by sub-regions. */
  redundantRegions: RedundantRegion[]
}

export async function bulkSuggestOsmRegions(): Promise<BulkSuggestResult> {
  return apiFetch('/osm/regions/bulk-suggest')
}

export async function reverseGeocodeViaOsm(
  lat: number,
  lon: number,
  acceptLanguage?: string,
): Promise<{ regionSlug: string; result: Record<string, unknown> }> {
  return apiFetch('/osm/reverse', {
    method: 'POST',
    body: JSON.stringify({ lat, lon, acceptLanguage }),
  })
}
