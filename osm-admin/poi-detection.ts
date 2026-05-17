/**
 * End-to-end POI detection pipeline for one photo (Epic #383).
 *
 *   1. Fetch the photo row (lat/lon/heading + DINOv2 embedding).
 *   2. Pick the regional Overpass shard (via region-router) and
 *      run a POI radius query.
 *   3. Enrich each candidate's wikidata QID through
 *      `poi-reference-cache` (label, image URL, Wikipedia link).
 *   4. Ensure the DINOv2 reference embeddings are populated (lazily
 *      against the embedding_service `/dino/embed` endpoint).
 *   5. Run the scoring matcher with all candidates that have an
 *      embedding.
 *   6. Persist the result into `photo_poi_matches`.
 *
 * The function is the public entry-point of the `poi_detection` scan
 * worker. It treats every external dependency as soft: an unreachable
 * Overpass / Wikidata / embedding service produces an empty match
 * list with a diagnostic reason rather than throwing.
 */

import { eq, sql } from "drizzle-orm";
import dbDefault from "../db/database";
import { photos, photoPoiMatches } from "../db/schema";
import { fetchPoiCandidates, type OverpassCandidate } from "./overpass-client";
import { ensurePoiEmbeddings } from "./poi-embedder";
import { ensurePoiReferences } from "./poi-reference-cache";
import { matchPhotoToPois, type MatchCandidate, type ScoredMatch } from "./poi-matcher";
import { pickRegion } from "./region-router";

export interface DetectionDeps {
  db?: typeof dbDefault;
  fetcher?: typeof fetch;
  /** Override the embedding-service URL (defaults to env). */
  embeddingServiceUrl?: string;
}

export interface DetectionResult {
  matches: ScoredMatch[];
  reason?: string;
}

export async function detectPoisForPhoto(
  photoId: number,
  deps: DetectionDeps = {},
): Promise<DetectionResult> {
  const db = deps.db ?? dbDefault;

  const photo = (
    await db.select().from(photos).where(eq(photos.id, photoId))
  )[0];
  if (!photo) return { matches: [], reason: "photo_not_found" };
  if (photo.latitude === null || photo.longitude === null) {
    return { matches: [], reason: "no_gps" };
  }

  const region = await pickRegion(photo.latitude, photo.longitude, { db });
  if (!region) return { matches: [], reason: "no_region" };

  // 1. Overpass candidates ───────────────────────────────────────────
  const overpassUrl = `http://${region.overpassHost}/api/interpreter`;
  const fetcher = deps.fetcher ?? fetch;
  let overpassCandidates: OverpassCandidate[];
  try {
    const r = await fetchPoiCandidates(
      overpassUrl,
      photo.latitude,
      photo.longitude,
      { fetcher },
    );
    overpassCandidates = r.candidates;
  } catch (err) {
    return {
      matches: [],
      reason: `overpass:${(err as Error).message ?? String(err)}`,
    };
  }
  if (overpassCandidates.length === 0) {
    return { matches: [], reason: "no_overpass_candidates" };
  }

  // 2. Wikidata enrichment for any OSM candidates that carry a QID ──
  const wikidataQids = [
    ...new Set(
      overpassCandidates
        .map((c) => c.wikidataQid)
        .filter((q): q is string => q !== null && /^Q\d+$/.test(q)),
    ),
  ];
  await ensurePoiReferences(wikidataQids, {
    db,
    wikidata: { fetcher },
  });

  // 3. Lazy-fill reference embeddings for those QIDs ─────────────────
  if (wikidataQids.length > 0) {
    await ensurePoiEmbeddings(wikidataQids, {
      db,
      fetcher,
      embeddingServiceUrl: deps.embeddingServiceUrl,
    });
  }

  // 4. Fetch the photo's own DINOv2 embedding from the
  //    embedding-service-side photo table ────────────────────────────
  // The embedding lives in the separate embedding_postgres; we go
  // through the same `/get` endpoint the photo service already uses.
  const photoEmbedding = await fetchPhotoDinoEmbedding(
    photoId,
    deps.embeddingServiceUrl,
    fetcher,
  );
  if (!photoEmbedding) {
    return { matches: [], reason: "photo_embedding_missing" };
  }

  // 5. Build matcher input ────────────────────────────────────────────
  const refs = wikidataQids.length === 0
    ? new Map<string, { embedding: number[] | null; nameDe: string | null; name: string }>()
    : await loadPoiReferenceEmbeddings(db, wikidataQids);

  const candidates: MatchCandidate[] = overpassCandidates.map((c) => {
    const ref = c.wikidataQid ? refs.get(c.wikidataQid) : undefined;
    return {
      qid: c.wikidataQid,
      osmRef: c.osmRef,
      name: ref?.name ?? c.name ?? c.osmRef,
      nameDe: ref?.nameDe ?? c.nameDe,
      lat: c.lat,
      lon: c.lon,
      distanceM: c.distanceM,
      poiEmbedding: ref?.embedding ?? null,
      source: c.wikidataQid && ref ? "both" : c.wikidataQid ? "wikidata" : "osm",
      regionSlug: region.slug,
    };
  });

  const matchResult = matchPhotoToPois({
    photoEmbedding,
    photoHeadingDeg: null, // EXIF heading not yet read; see followup
    photoLat: photo.latitude,
    photoLon: photo.longitude,
    candidates,
  });

  // 6. Persist ────────────────────────────────────────────────────────
  if (matchResult.matches.length > 0) {
    await persistPoiMatches(db, photoId, matchResult.matches);
  }

  return matchResult;
}

/**
 * Look up the photo's DINOv2 vector via the embedding service's
 * `/get` endpoint. Returns null on any error or if the photo has not
 * been embedded yet (poi_detection should retry on the next tick).
 */
async function fetchPhotoDinoEmbedding(
  photoId: number,
  serviceUrl: string | undefined,
  fetcher: typeof fetch,
): Promise<number[] | null> {
  const base = serviceUrl ?? process.env.EMBEDDING_SERVICE_URL ?? "http://localhost:8001";
  try {
    const res = await fetcher(`${base}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo_ids: [String(photoId)] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      photos?: Array<{ embedding_dino?: number[] }>;
    };
    const row = body.photos?.[0];
    if (!row || !Array.isArray(row.embedding_dino)) return null;
    return row.embedding_dino;
  } catch {
    return null;
  }
}

async function loadPoiReferenceEmbeddings(
  db: typeof dbDefault,
  qids: string[],
): Promise<Map<string, { embedding: number[] | null; nameDe: string | null; name: string }>> {
  if (qids.length === 0) return new Map();
  // pgvector::text returns `[v1,v2,…]` which we parse back to numbers.
  const rows = await db.execute<{
    qid: string;
    name: string;
    name_de: string | null;
    embedding_text: string | null;
  }>(sql`
    SELECT qid, name, name_de, embedding::text AS embedding_text
    FROM poi_references
    WHERE qid = ANY(${qids})
  `);
  const out = new Map<string, { embedding: number[] | null; nameDe: string | null; name: string }>();
  for (const r of rows.rows) {
    out.set(r.qid, {
      embedding: parsePgvector(r.embedding_text),
      nameDe: r.name_de,
      name: r.name,
    });
  }
  return out;
}

function parsePgvector(text: string | null): number[] | null {
  if (!text) return null;
  // pgvector text repr: "[0.1,0.2,…]"
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const parts = trimmed.slice(1, -1).split(",");
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

async function persistPoiMatches(
  db: typeof dbDefault,
  photoId: number,
  matches: ScoredMatch[],
): Promise<void> {
  // Replace any prior matches for this photo so a re-scan doesn't
  // double-write.
  await db.delete(photoPoiMatches).where(eq(photoPoiMatches.photo_id, photoId));
  await db.insert(photoPoiMatches).values(
    matches.map((m) => ({
      photo_id: photoId,
      qid: m.qid,
      osm_ref: m.osmRef,
      name: m.name,
      name_de: m.nameDe,
      distance_m: m.distanceM,
      heading_match: m.headingMatch,
      match_score: m.matchScore,
      ambiguous: m.ambiguous,
      source: m.source,
      region_slug: m.regionSlug,
    })),
  );
}
