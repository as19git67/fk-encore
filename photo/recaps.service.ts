/**
 * Rueckblicke (Recaps) — automatisch generierte Foto-Retrospektiven.
 *
 * MVP umfasst zwei Builder-Typen:
 *   - on_this_day: Fotos vom heutigen Tag (month+day) aus frueheren Jahren.
 *   - trip:         zeitlich+geografisch gruppierte Aufnahmen an Orten, die
 *                   vom Lebensmittelpunkt des Users abweichen.
 *
 * Alle Recaps werden per Cron taeglich neu aufgebaut. Idempotenz wird ueber
 * den `dedup_key` in der `recaps`-Tabelle sichergestellt — existiert der Key
 * bereits, aktualisiert der Builder nur Cover/Titel/Photo-Set.
 */

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import {
  photos,
  recaps,
  recapPhotos,
  recapExcludedPhotos,
  photoCuration,
  persons,
  faces,
  userFaceAssignments,
} from "../db/schema";
import { generateRecapTitle, type RecapTitleContext } from "./recaps-llm-client";
import { RECAP_THEMES, type RecapTheme } from "./recap-themes";
import { repairMojibake } from "./text-encoding";

const MIN_PHOTOS_PER_RECAP = 4;
const MAX_PHOTOS_PER_RECAP = 30;
// How many next-best candidates (beyond the chosen set) are kept per recap in
// `seed.reserve_ids` to backfill slots when the user excludes a photo.
const RECAP_RESERVE_SIZE = 30;
// Visible feed is capped so the page stays snappy for libraries with thousands
// of recaps (e.g. users with many assigned persons generate hundreds of
// per-year person-recaps). The underlying rows remain in the DB — only the
// user-facing listing is trimmed.
const MAX_VISIBLE_RECAPS = 50;
// Per-kind quotas prevent one noisy kind (typically `person`) from crowding
// out the rest of the feed. Each kind first takes up to its quota by score;
// any leftover slots are then filled from the remaining top-scoring recaps
// across all kinds. Quotas sum to MAX_VISIBLE_RECAPS.
const RECAP_KIND_QUOTA: Record<RecapKind, number> = {
  recent_highlights: 4,
  on_this_day: 8,
  trip: 10,
  person: 12,
  place: 8,
  theme: 5,
  scene_then_now: 3,
};
// Candidate pool size per kind (fetched via window function). Sized to
// MAX_VISIBLE_RECAPS so that a user with only one populated kind can still
// fill the feed from leftovers after the quota pass.
const RECAP_KIND_POOL = MAX_VISIBLE_RECAPS;
const TRIP_MIN_DISTANCE_KM = 100;
const TRIP_MAX_GAP_DAYS = 2;
const TRIP_LOOKBACK_DAYS = 365 * 3;
// Within a time-contiguous trip bucket, photos further apart than this form
// separate sub-trips (e.g. Berlin → Prague in the same week).
const TRIP_GEO_SPLIT_KM = 50;

const EMBEDDING_SERVICE_URL = (
  process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001"
).replace(/\/$/, "");
const THEME_DEFAULT_THRESHOLD = 0.22;
const THEME_DEFAULT_MIN_PHOTOS = 12;
const THEME_SEARCH_K = 300;
const THEME_HTTP_TIMEOUT_MS = parseInt(
  process.env.RECAPS_THEME_TIMEOUT_MS ?? "15000",
  10
);
const THEMES_ENABLED = (process.env.RECAPS_THEMES_ENABLED ?? "1") !== "0";

// ── Diverse photo selection (visual + geographic) ─────────────────────────────
// Recap curation offloads photo selection to the embedding service's
// /select-diverse endpoint: it keeps high-quality shots while thinning out
// visually near-identical ones (DINOv2 cosine) and spreading the picks across
// location clusters. Falls back to local burst-dedup when disabled/unavailable.
const DIVERSITY_ENABLED = (process.env.RECAPS_DIVERSITY_ENABLED ?? "1") !== "0";
// Cosine similarity at/above which two photos count as "too similar". Lower
// than the 0.90 near-duplicate threshold so we also thin out shots that are
// merely similar (same scene, slightly different framing).
const DIVERSITY_SIMILARITY_THRESHOLD = parseFloat(
  process.env.RECAPS_DIVERSITY_THRESHOLD ?? "0.82"
);
// Cap on candidates sent to the service per recap. We pre-trim to the top of
// the pool by quality so clustering + payload stay bounded even for places
// with hundreds of photos.
const DIVERSITY_POOL_LIMIT = 150;
// Photos within this distance of a cluster centroid join it. ~500 m keeps a
// city walk spread across several spots without shattering a single viewpoint.
const LOCATION_CLUSTER_RADIUS_KM = 0.5;
const DIVERSITY_HTTP_TIMEOUT_MS = parseInt(
  process.env.RECAPS_DIVERSITY_TIMEOUT_MS ?? "15000",
  10
);

export type RecapKind =
  | "on_this_day"
  | "trip"
  | "person"
  | "place"
  | "theme"
  | "recent_highlights"
  | "scene_then_now";

export interface RecapSummary {
  id: number;
  kind: RecapKind;
  title: string;
  subtitle: string | null;
  cover_photo_id: number | null;
  period_start: string | null;
  period_end: string | null;
  photo_count: number;
  created_at: string;
  dismissed_at: string | null;
  seen_at: string | null;
}

export interface RecapDetails extends RecapSummary {
  seed: Record<string, unknown>;
  photo_ids: number[];
}

/** Candidate photo as read from the database when building recaps. */
export interface CandidatePhoto {
  id: number;
  taken_at: string | null;
  created_at: string | null;
  latitude: number | null;
  longitude: number | null;
  location_city: string | null;
  location_country: string | null;
  ai_quality_score: number | null;
  curation_status: string | null;
}

/**
 * Effective timestamp a photo belongs to (EXIF date preferred, upload date as
 * fallback). Matches photo.service `photoDateOrder`.
 */
function effectiveDate(p: CandidatePhoto): Date | null {
  const iso = p.taken_at ?? p.created_at;
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * OSM/Nominatim reverse-geocoding often puts a generic neighbourhood or
 * district name — "Innere Stadt", "Altstadt", "Neustadt", "Zentrum",
 * "Innenstadt", … — into `location_city`. As a recap title or map label
 * these are useless and misleading (every city has an "Altstadt"), so we
 * treat them as "no city" when titling. The photos still belong to the
 * recap; only the name is suppressed in favour of the country or a generic
 * fallback. Matched case-insensitively after trimming.
 */
const GENERIC_PLACE_NAMES = new Set<string>([
  "innere stadt",
  "innenstadt",
  "altstadt",
  "neustadt",
  "zentrum",
  "stadtzentrum",
  "stadtmitte",
  "old town",
  "new town",
  "city centre",
  "city center",
  "downtown",
  "centre",
  "center",
]);

export function isGenericPlaceName(name: string | null | undefined): boolean {
  if (!name) return false;
  return GENERIC_PLACE_NAMES.has(name.trim().toLowerCase());
}

/** Haversine distance between two (lat, lon) points in kilometres. */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Load all curation-visible photos for a user. Hidden photos never appear in
 * recaps. Fields are kept minimal — detail rendering uses the regular
 * /photos/details batch endpoint on the frontend.
 */
async function loadVisiblePhotos(userId: number): Promise<CandidatePhoto[]> {
  return dbAll<CandidatePhoto>(
    db
      .select({
        id: photos.id,
        taken_at: photos.taken_at,
        created_at: photos.created_at,
        latitude: photos.latitude,
        longitude: photos.longitude,
        location_city: photos.location_city,
        location_country: photos.location_country,
        ai_quality_score: photos.ai_quality_score,
        curation_status: photoCuration.status,
      })
      .from(photos)
      .leftJoin(
        photoCuration,
        and(
          eq(photoCuration.photo_id, photos.id),
          eq(photoCuration.user_id, userId)
        )
      )
      .where(
        and(
          eq(photos.user_id, userId),
          sql`COALESCE(${photoCuration.status}, 'visible') <> 'hidden'`
        )
      )
  );
}

const BURST_GAP_MS = 60_000;

function dedupBursts(photos: CandidatePhoto[]): CandidatePhoto[] {
  if (photos.length <= 1) return photos;
  const sorted = [...photos].sort((a, b) => {
    const da = effectiveDate(a)?.getTime() ?? 0;
    const db = effectiveDate(b)?.getTime() ?? 0;
    return da - db;
  });
  const result: CandidatePhoto[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1]!;
    const curr = sorted[i]!;
    const tPrev = effectiveDate(prev)?.getTime();
    const tCurr = effectiveDate(curr)?.getTime();
    if (
      tPrev != null &&
      tCurr != null &&
      tCurr - tPrev < BURST_GAP_MS
    ) {
      const qPrev = prev.ai_quality_score ?? 0;
      const qCurr = curr.ai_quality_score ?? 0;
      if (qCurr > qPrev) result[result.length - 1] = curr;
    } else {
      result.push(curr);
    }
  }
  return result;
}

/** Quality descending, newest first as a tiebreak. */
function byQualityDesc(a: CandidatePhoto, b: CandidatePhoto): number {
  const qa = a.ai_quality_score ?? 0;
  const qb = b.ai_quality_score ?? 0;
  if (qb !== qa) return qb - qa;
  const da = effectiveDate(a)?.getTime() ?? 0;
  const dd = effectiveDate(b)?.getTime() ?? 0;
  return dd - da;
}

function byChronological(a: CandidatePhoto, b: CandidatePhoto): number {
  const da = effectiveDate(a)?.getTime() ?? 0;
  const db = effectiveDate(b)?.getTime() ?? 0;
  return da - db;
}

/**
 * Local fallback curation: collapse temporal bursts, keep the top photos by
 * AI-quality, then order them chronologically. Used when diverse selection is
 * disabled or the embedding service is unavailable.
 */
function curatePhotosLocal(candidates: CandidatePhoto[]): {
  cover: number | null;
  rankedIds: number[];
  reserveIds: number[];
} {
  const deduped = dedupBursts(candidates);
  const byQuality = [...deduped].sort(byQualityDesc);
  const cover = byQuality[0]?.id ?? null;
  const limited = byQuality.slice(0, MAX_PHOTOS_PER_RECAP);
  // Reserve = the next-best shots not chosen, kept quality-desc so a later
  // exclusion backfills with the strongest remaining candidate.
  const reserveIds = byQuality
    .slice(MAX_PHOTOS_PER_RECAP, MAX_PHOTOS_PER_RECAP + RECAP_RESERVE_SIZE)
    .map((p) => p.id);
  limited.sort(byChronological);
  return {
    cover,
    rankedIds: limited.map((p) => p.id),
    reserveIds,
  };
}

/**
 * Greedy geographic clustering of candidate photos. Returns a cluster label
 * per input photo (aligned to the input order). Photos without GPS all share
 * one extra label so they still receive a selection budget. Mirrors the spirit
 * of the album map view's stop clustering, at a coarser ~500 m radius.
 */
export function clusterByLocation(photos: CandidatePhoto[]): number[] {
  const centroids: { lat: number; lon: number; count: number }[] = [];
  const labels: number[] = [];
  for (const p of photos) {
    if (p.latitude == null || p.longitude == null) {
      labels.push(-1); // resolved to a shared no-GPS label below
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i]!;
      const d = haversineKm(p.latitude, p.longitude, c.lat, c.lon);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= LOCATION_CLUSTER_RADIUS_KM) {
      const c = centroids[best]!;
      c.lat = (c.lat * c.count + p.latitude) / (c.count + 1);
      c.lon = (c.lon * c.count + p.longitude) / (c.count + 1);
      c.count++;
      labels.push(best);
    } else {
      centroids.push({ lat: p.latitude, lon: p.longitude, count: 1 });
      labels.push(centroids.length - 1);
    }
  }
  // All no-GPS photos share one label placed after the geographic clusters.
  const noGpsLabel = centroids.length;
  return labels.map((l) => (l === -1 ? noGpsLabel : l));
}

/**
 * Ask the embedding service for a high-quality, visually diverse, geographically
 * spread subset. Returns chosen photo ids (best-first) or null on any failure
 * so the caller can fall back to local curation.
 */
async function selectDiverseRemote(
  items: { photo_id: string; quality: number; cluster: number }[]
): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIVERSITY_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBEDDING_SERVICE_URL}/select-diverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        count: MAX_PHOTOS_PER_RECAP,
        similarity_threshold: DIVERSITY_SIMILARITY_THRESHOLD,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { photo_ids?: string[] };
    return data.photo_ids ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the photos that go into a recap. Prefers visual + geographic diversity
 * via the embedding service; the cover is always the highest-quality shot and
 * the returned ids are ordered chronologically for playback. Falls back to
 * local burst-dedup curation when diversity is disabled or the service fails.
 */
async function curatePhotos(candidates: CandidatePhoto[]): Promise<{
  cover: number | null;
  rankedIds: number[];
  reserveIds: number[];
}> {
  if (!DIVERSITY_ENABLED || candidates.length <= MIN_PHOTOS_PER_RECAP) {
    return curatePhotosLocal(candidates);
  }
  // Collapse rapid-fire bursts, then pre-trim to the strongest candidates by
  // quality so clustering and the request payload stay bounded.
  const pool = dedupBursts(candidates)
    .sort(byQualityDesc)
    .slice(0, DIVERSITY_POOL_LIMIT);
  if (pool.length <= MIN_PHOTOS_PER_RECAP) {
    return curatePhotosLocal(candidates);
  }

  const labels = clusterByLocation(pool);
  const items = pool.map((p, i) => ({
    photo_id: String(p.id),
    quality: p.ai_quality_score ?? 0,
    cluster: labels[i]!,
  }));

  const chosen = await selectDiverseRemote(items);
  if (!chosen || chosen.length === 0) return curatePhotosLocal(candidates);

  const byId = new Map(pool.map((p) => [p.id, p]));
  const chosenPhotos = chosen
    .map((id) => byId.get(parseInt(id, 10)))
    .filter((p): p is CandidatePhoto => p != null);
  if (chosenPhotos.length === 0) return curatePhotosLocal(candidates);

  const cover = chosenPhotos[0]!.id; // service returns best-first
  const ordered = [...chosenPhotos].sort(byChronological);
  // Reserve = strongest pool photos the diversity pass didn't choose, so an
  // exclusion can backfill without another round-trip. Kept quality-desc.
  const chosenIds = new Set(chosenPhotos.map((p) => p.id));
  const reserveIds = pool
    .filter((p) => !chosenIds.has(p.id))
    .slice(0, RECAP_RESERVE_SIZE)
    .map((p) => p.id);
  return {
    cover,
    rankedIds: ordered.map((p) => p.id),
    reserveIds,
  };
}

/**
 * Apply a recap's persistent photo exclusions to a freshly curated photo set,
 * backfilling emptied slots from the ranked reserve. Pure so the exclusion +
 * backfill semantics stay unit-testable independent of the DB.
 *
 * - Excluded photos are dropped from both the chosen set and the reserve.
 * - Slots freed by exclusions are refilled from the (quality-desc) reserve,
 *   up to the original photo count.
 * - If the cover was excluded, it moves to the first surviving photo.
 * - The returned reserve has the used backfill removed, ready to persist.
 */
export function applyExclusionsAndBackfill(opts: {
  chosen: number[];
  reserve: number[];
  excluded: Set<number>;
  coverPhotoId: number | null;
  targetCount: number;
}): { photoIds: number[]; reserve: number[]; coverPhotoId: number | null } {
  const { excluded } = opts;
  const keptChosen = opts.chosen.filter((id) => !excluded.has(id));
  const chosenSet = new Set(keptChosen);
  const availableReserve = opts.reserve.filter(
    (id) => !excluded.has(id) && !chosenSet.has(id)
  );
  const need = Math.max(0, opts.targetCount - keptChosen.length);
  const backfill = availableReserve.slice(0, need);
  const backfillSet = new Set(backfill);
  const photoIds = [...keptChosen, ...backfill];
  const reserve = availableReserve.filter((id) => !backfillSet.has(id));
  const coverPhotoId =
    opts.coverPhotoId != null && !excluded.has(opts.coverPhotoId)
      ? opts.coverPhotoId
      : (photoIds[0] ?? null);
  return { photoIds, reserve, coverPhotoId };
}

/** Photo ids the user has excluded from the recap with the given id. */
async function loadExclusionSet(recapId: number): Promise<Set<number>> {
  const rows = await dbAll<{ photo_id: number }>(
    db
      .select({ photo_id: recapExcludedPhotos.photo_id })
      .from(recapExcludedPhotos)
      .where(eq(recapExcludedPhotos.recap_id, recapId))
  );
  return new Set(rows.map((r) => r.photo_id));
}

/**
 * Upsert a recap by (user_id, dedup_key). Replaces the photo membership
 * wholesale. Keeps dismissed_at if the row already existed — a user who has
 * dismissed a recap should not see it re-appear when the cron rebuilds it.
 *
 * Honours persistent per-recap photo exclusions: excluded photos are removed
 * from the freshly curated set and their slots backfilled from `reserveIds`;
 * the leftover reserve is stored in `seed.reserve_ids` for the live exclude
 * endpoint to draw on between rebuilds.
 */
async function upsertRecap(input: {
  userId: number;
  kind: RecapKind;
  title: string;
  subtitle: string | null;
  dedupKey: string;
  coverPhotoId: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  score: number;
  seed: Record<string, unknown>;
  photoIds: number[];
  reserveIds?: number[];
}): Promise<number> {
  const existing = await dbFirst<{ id: number }>(
    db
      .select({ id: recaps.id })
      .from(recaps)
      .where(
        and(eq(recaps.user_id, input.userId), eq(recaps.dedup_key, input.dedupKey))
      )
      .limit(1)
  );

  // Brand-new recaps can't have exclusions yet; existing ones may.
  const excluded = existing ? await loadExclusionSet(existing.id) : new Set<number>();
  const { photoIds, reserve, coverPhotoId } = applyExclusionsAndBackfill({
    chosen: input.photoIds,
    reserve: input.reserveIds ?? [],
    excluded,
    coverPhotoId: input.coverPhotoId,
    targetCount: input.photoIds.length,
  });
  const seed = { ...input.seed, reserve_ids: reserve };

  let recapId: number;
  if (existing) {
    recapId = existing.id;
    await dbExec(
      db
        .update(recaps)
        .set({
          kind: input.kind,
          title: input.title,
          subtitle: input.subtitle,
          cover_photo_id: coverPhotoId,
          period_start: input.periodStart
            ? input.periodStart.toISOString()
            : null,
          period_end: input.periodEnd ? input.periodEnd.toISOString() : null,
          score: input.score,
          seed,
        })
        .where(eq(recaps.id, recapId))
    );
    await dbExec(db.delete(recapPhotos).where(eq(recapPhotos.recap_id, recapId)));
  } else {
    const inserted = await dbInsertReturning<{ id: number }>(
      db
        .insert(recaps)
        .values({
          user_id: input.userId,
          kind: input.kind,
          title: input.title,
          subtitle: input.subtitle,
          cover_photo_id: coverPhotoId,
          period_start: input.periodStart
            ? input.periodStart.toISOString()
            : null,
          period_end: input.periodEnd ? input.periodEnd.toISOString() : null,
          score: input.score,
          dedup_key: input.dedupKey,
          seed,
        })
        .returning({ id: recaps.id })
    );
    recapId = inserted!.id;
  }

  if (photoIds.length > 0) {
    await dbExec(
      db.insert(recapPhotos).values(
        photoIds.map((photoId, idx) => ({
          recap_id: recapId,
          photo_id: photoId,
          rank: idx,
        }))
      )
    );
  }

  return recapId;
}

/**
 * Resolves the user-facing title for a recap, preferring an LLM-generated
 * one. The result is cached in `recap.seed.llm_title = true`, so subsequent
 * rebuilds (triggered incrementally by scan-worker) skip the LLM call.
 *
 * Returns both the chosen title/subtitle and whether it came from the LLM,
 * so the caller can persist the cache flag in `seed`.
 */
async function resolveTitle(opts: {
  userId: number;
  dedupKey: string;
  fallback: { title: string; subtitle: string | null };
  ctx: RecapTitleContext;
}): Promise<{ title: string; subtitle: string | null; llmUsed: boolean }> {
  const existing = await dbFirst<{
    title: string;
    subtitle: string | null;
    seed: unknown;
  }>(
    db
      .select({
        title: recaps.title,
        subtitle: recaps.subtitle,
        seed: recaps.seed,
      })
      .from(recaps)
      .where(
        and(eq(recaps.user_id, opts.userId), eq(recaps.dedup_key, opts.dedupKey))
      )
      .limit(1)
  );

  if (existing) {
    const seed = existing.seed as Record<string, unknown> | null | undefined;
    if (seed && seed.llm_title === true) {
      return {
        title: existing.title,
        subtitle: existing.subtitle,
        llmUsed: true,
      };
    }
  }

  try {
    const llm = await generateRecapTitle(opts.ctx);
    if (llm && llm.title) {
      return {
        title: repairMojibake(llm.title),
        subtitle: repairMojibake(llm.subtitle),
        llmUsed: true,
      };
    }
  } catch (err: any) {
    console.warn(
      `[recaps] LLM title generation failed for ${opts.dedupKey}: ${err?.message ?? err}`
    );
  }
  return {
    title: repairMojibake(opts.fallback.title),
    subtitle: repairMojibake(opts.fallback.subtitle),
    llmUsed: false,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: on_this_day
// ────────────────────────────────────────────────────────────────────────────

// Only these round anniversaries get an "on this day" recap. Without this,
// every past year with enough photos produces a recap — a decade-old library
// would show up to 10 near-identical "Vor N Jahren" cards per day.
const ON_THIS_DAY_MILESTONE_YEARS = new Set([1, 5, 10, 20, 25]);

export function buildOnThisDayGroups(
  photos: CandidatePhoto[],
  today: Date
): Map<number, CandidatePhoto[]> {
  const targetMonth = today.getMonth();
  const targetDay = today.getDate();
  const currentYear = today.getFullYear();

  const byYear = new Map<number, CandidatePhoto[]>();
  for (const p of photos) {
    const d = effectiveDate(p);
    if (!d) continue;
    if (d.getMonth() !== targetMonth || d.getDate() !== targetDay) continue;
    const year = d.getFullYear();
    if (year >= currentYear) continue; // only past years
    if (!ON_THIS_DAY_MILESTONE_YEARS.has(currentYear - year)) continue;
    const arr = byYear.get(year) ?? [];
    arr.push(p);
    byYear.set(year, arr);
  }
  return byYear;
}

async function buildOnThisDayRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const groups = buildOnThisDayGroups(allPhotos, today);
  const currentYear = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  let built = 0;

  for (const [year, photosForYear] of groups.entries()) {
    if (photosForYear.length < MIN_PHOTOS_PER_RECAP) continue;
    const yearsAgo = currentYear - year;
    const { cover, rankedIds, reserveIds } = await curatePhotos(photosForYear);
    const periodStart = new Date(year, today.getMonth(), today.getDate());
    const periodEnd = new Date(periodStart);
    periodEnd.setHours(23, 59, 59);

    const fallbackTitle =
      yearsAgo === 1
        ? "Vor einem Jahr"
        : `Vor ${yearsAgo} Jahren`;
    const fallbackSubtitle = periodStart.toLocaleDateString("de-DE", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const dedupKey = `on_this_day:${year}-${mm}-${dd}`;
    const score = 70 + Math.min(photosForYear.length, 20);
    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: fallbackTitle, subtitle: fallbackSubtitle },
      ctx: {
        kind: "on_this_day",
        years_ago: yearsAgo,
        date_range: fallbackSubtitle,
      },
    });

    await upsertRecap({
      userId,
      kind: "on_this_day",
      title: resolved.title,
      subtitle: resolved.subtitle,
      dedupKey,
      coverPhotoId: cover,
      periodStart,
      periodEnd,
      score,
      seed: {
        years_ago: yearsAgo,
        month: today.getMonth() + 1,
        day: today.getDate(),
        ...(resolved.llmUsed ? { llm_title: true } : {}),
      },
      photoIds: rankedIds,
      reserveIds,
    });
    built++;
  }

  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: trip
// ────────────────────────────────────────────────────────────────────────────

interface TripCluster {
  photos: CandidatePhoto[];
  start: Date;
  end: Date;
  centroidLat: number;
  centroidLon: number;
  dominantCity: string | null;
  dominantCountry: string | null;
}

// Grid cell size for home detection, in degrees (~5.5 km latitude). Coarse
// enough that a town and its surroundings fall into one cell, fine enough to
// separate home from a holiday region.
const HOME_CELL_DEG = 0.05;

/**
 * Liefert den Lebensmittelpunkt des Users. Trips werden relativ dazu als
 * "weit weg" erkannt.
 *
 * Der Wohnort ist die Gitterzelle mit den meisten *distinkten Fototagen*
 * ueber die gesamte Bibliothek — nicht der Koordinaten-Mittelwert. Ein
 * Mittelwert wird von Reisefotos weggezogen (viele Japan-Fotos schieben
 * das "Zuhause" in Richtung Asien, wodurch der echte Wohnort ploetzlich
 * als Trip erkannt wird). Distinkte Tage sind robust: zuhause fotografiert
 * man an vielen Tagen ueber Jahre, ein Urlaub liefert hoechstens ein paar
 * Wochen, egal wie viele Fotos dabei entstehen.
 */
export function computeHomeCentroid(
  photos: CandidatePhoto[],
  _today: Date
): { lat: number; lon: number } | null {
  const cells = new Map<
    string,
    { days: Set<string>; lats: number[]; lons: number[] }
  >();
  for (const p of photos) {
    if (p.latitude == null || p.longitude == null) continue;
    const d = effectiveDate(p);
    if (!d) continue;
    const key = `${Math.round(p.latitude / HOME_CELL_DEG)}:${Math.round(
      p.longitude / HOME_CELL_DEG
    )}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { days: new Set(), lats: [], lons: [] };
      cells.set(key, cell);
    }
    cell.days.add(d.toISOString().slice(0, 10));
    cell.lats.push(p.latitude);
    cell.lons.push(p.longitude);
  }
  if (cells.size === 0) return null;

  let best: { days: Set<string>; lats: number[]; lons: number[] } | null = null;
  for (const cell of cells.values()) {
    if (!best || cell.days.size > best.days.size) best = cell;
  }
  if (!best) return null;
  return { lat: avg(best.lats), lon: avg(best.lons) };
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Split a time-contiguous bucket of trip photos into geographic sub-groups.
 * Photos within TRIP_GEO_SPLIT_KM of each other stay together; distant
 * clusters (e.g. Berlin vs Prague on the same week-long trip) become separate
 * sub-buckets. Each sub-bucket preserves chronological order.
 */
export function splitBucketByGeo(bucket: CandidatePhoto[]): CandidatePhoto[][] {
  if (bucket.length === 0) return [];
  const centroids: { lat: number; lon: number; count: number }[] = [];
  const labels: number[] = [];
  for (const p of bucket) {
    if (p.latitude == null || p.longitude == null) {
      labels.push(-1);
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i]!;
      const d = haversineKm(p.latitude, p.longitude, c.lat, c.lon);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= TRIP_GEO_SPLIT_KM) {
      const c = centroids[best]!;
      c.lat = (c.lat * c.count + p.latitude) / (c.count + 1);
      c.lon = (c.lon * c.count + p.longitude) / (c.count + 1);
      c.count++;
      labels.push(best);
    } else {
      centroids.push({ lat: p.latitude, lon: p.longitude, count: 1 });
      labels.push(centroids.length - 1);
    }
  }
  // Find the largest geo cluster so no-GPS photos can join it.
  const groups = new Map<number, CandidatePhoto[]>();
  for (let i = 0; i < bucket.length; i++) {
    const l = labels[i]!;
    if (l === -1) continue; // handle below
    const arr = groups.get(l) ?? [];
    arr.push(bucket[i]!);
    groups.set(l, arr);
  }
  let largestLabel = 0;
  let largestSize = 0;
  for (const [l, arr] of groups) {
    if (arr.length > largestSize) {
      largestSize = arr.length;
      largestLabel = l;
    }
  }
  for (let i = 0; i < bucket.length; i++) {
    if (labels[i] !== -1) continue;
    const arr = groups.get(largestLabel) ?? [];
    arr.push(bucket[i]!);
    groups.set(largestLabel, arr);
  }
  return Array.from(groups.values());
}

/**
 * Clustere GPS-Fotos chronologisch: neuer Trip beginnt, sobald eine
 * Zeitluecke > TRIP_MAX_GAP_DAYS auftritt. Innerhalb eines Zeit-Buckets
 * werden Fotos zusätzlich nach Entfernung aufgesplittet, sodass z.B.
 * Berlin und Prag auf der gleichen Wochenreise separate Recaps ergeben.
 * Nur Cluster mit signifikantem Abstand zum Home-Zentroid werden als Trip
 * akzeptiert.
 */
function buildTripClusters(
  candidates: CandidatePhoto[],
  home: { lat: number; lon: number } | null,
  today: Date
): TripCluster[] {
  if (!home) return [];
  const lookbackCutoff = new Date(today);
  lookbackCutoff.setDate(lookbackCutoff.getDate() - TRIP_LOOKBACK_DAYS);

  const withGps = candidates
    .filter((p) => {
      if (p.latitude == null || p.longitude == null) return false;
      const d = effectiveDate(p);
      return d != null && d >= lookbackCutoff;
    })
    .sort((a, b) => {
      const da = effectiveDate(a)!.getTime();
      const db_ = effectiveDate(b)!.getTime();
      return da - db_;
    });

  const clusters: TripCluster[] = [];
  let bucket: CandidatePhoto[] = [];
  let lastDate: Date | null = null;

  const flushGroup = (group: CandidatePhoto[]) => {
    if (group.length < MIN_PHOTOS_PER_RECAP) return;
    const lats = group.map((p) => p.latitude!);
    const lons = group.map((p) => p.longitude!);
    const cLat = avg(lats);
    const cLon = avg(lons);
    const distance = haversineKm(home.lat, home.lon, cLat, cLon);
    if (distance < TRIP_MIN_DISTANCE_KM) return;
    group = group.filter(
      (p) =>
        p.latitude != null &&
        p.longitude != null &&
        haversineKm(home.lat, home.lon, p.latitude, p.longitude) >=
          TRIP_MIN_DISTANCE_KM
    );
    if (group.length < MIN_PHOTOS_PER_RECAP) return;
    const start = effectiveDate(group[0])!;
    const end = effectiveDate(group[group.length - 1])!;
    clusters.push({
      photos: group,
      start,
      end,
      centroidLat: cLat,
      centroidLon: cLon,
      dominantCity: repairMojibake(mostFrequent(group.map((p) => p.location_city))),
      dominantCountry: repairMojibake(mostFrequent(group.map((p) => p.location_country))),
    });
  };

  const flush = () => {
    if (bucket.length < MIN_PHOTOS_PER_RECAP) {
      bucket = [];
      return;
    }
    const geoGroups = splitBucketByGeo(bucket);
    for (const group of geoGroups) {
      flushGroup(group);
    }
    bucket = [];
  };

  for (const p of withGps) {
    const d = effectiveDate(p)!;
    if (lastDate) {
      const gapDays = (d.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
      if (gapDays > TRIP_MAX_GAP_DAYS) flush();
    }
    bucket.push(p);
    lastDate = d;
  }
  flush();
  return clusters;
}

function mostFrequent(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

function formatMonthYear(d: Date): string {
  return d.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}

function tripTitle(cluster: TripCluster): string {
  if (cluster.dominantCity && !isGenericPlaceName(cluster.dominantCity)) {
    return cluster.dominantCity;
  }
  if (cluster.dominantCountry) return cluster.dominantCountry;
  return "Unterwegs";
}

function tripSubtitle(cluster: TripCluster): string {
  const start = cluster.start;
  const end = cluster.end;
  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  if (sameMonth) return formatMonthYear(start);
  const a = start.toLocaleDateString("de-DE", { month: "short", year: "numeric" });
  const b = end.toLocaleDateString("de-DE", { month: "short", year: "numeric" });
  return `${a} – ${b}`;
}

/**
 * Delete recaps of `kind` whose dedup_key the current rebuild no longer
 * produced. Covers clusters that shifted (new photos change trip boundaries →
 * new dedup key) and recaps built from a since-corrected home location.
 * Dismissed recaps are kept: their dedup_key must survive so a later rebuild
 * that produces the same key doesn't resurface the memory as "neu".
 */
async function pruneStaleRecaps(
  userId: number,
  kind: RecapKind,
  builtKeys: Set<string>
): Promise<void> {
  await dbExec(
    db.delete(recaps).where(
      and(
        eq(recaps.user_id, userId),
        eq(recaps.kind, kind),
        sql`${recaps.dismissed_at} IS NULL`,
        builtKeys.size > 0
          ? sql`${recaps.dedup_key} NOT IN (${sql.join(
              Array.from(builtKeys).map((k) => sql`${k}`),
              sql`, `
            )})`
          : sql`TRUE`
      )
    )
  );
}

/**
 * The user's home centroid (see `computeHomeCentroid`), for clients that need
 * "is the device back home" outside of recap building — currently the iOS
 * Trip Mode auto-end suggestion (`GET /trips/home-location`). `null` when the
 * user has no geotagged photos yet.
 */
export async function getHomeCentroidForUser(
  userId: number
): Promise<{ lat: number; lon: number } | null> {
  const photos = await loadVisiblePhotos(userId);
  return computeHomeCentroid(photos, new Date());
}

async function buildTripRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const home = computeHomeCentroid(allPhotos, today);
  const clusters = buildTripClusters(allPhotos, home, today);
  let built = 0;
  const builtKeys = new Set<string>();

  for (const cluster of clusters) {
    const { cover, rankedIds, reserveIds } = await curatePhotos(cluster.photos);
    const startIso = cluster.start.toISOString().slice(0, 10);
    const endIso = cluster.end.toISOString().slice(0, 10);
    const placeSlug = (cluster.dominantCity ?? cluster.dominantCountry ?? "trip")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const dedupKey = `trip:${placeSlug}:${startIso}:${endIso}`;
    const durationDays = Math.max(
      1,
      Math.round(
        (cluster.end.getTime() - cluster.start.getTime()) /
          (1000 * 60 * 60 * 24)
      ) + 1
    );
    const score = 40 + Math.min(cluster.photos.length, 40) + durationDays;
    const fallbackSubtitle = tripSubtitle(cluster);
    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: tripTitle(cluster), subtitle: fallbackSubtitle },
      ctx: {
        kind: "trip",
        place_city: isGenericPlaceName(cluster.dominantCity)
          ? null
          : cluster.dominantCity,
        place_country: cluster.dominantCountry,
        date_range: fallbackSubtitle,
        duration_days: durationDays,
      },
    });

    await upsertRecap({
      userId,
      kind: "trip",
      title: resolved.title,
      subtitle: resolved.subtitle,
      dedupKey,
      coverPhotoId: cover,
      periodStart: cluster.start,
      periodEnd: cluster.end,
      score,
      seed: {
        location_city: cluster.dominantCity,
        location_country: cluster.dominantCountry,
        centroid_lat: cluster.centroidLat,
        centroid_lon: cluster.centroidLon,
        // Home location at build time — the players draw the animated
        // "von zuhause zum Ziel" map intro from these.
        ...(home ? { home_lat: home.lat, home_lon: home.lon } : {}),
        duration_days: durationDays,
        ...(resolved.llmUsed ? { llm_title: true } : {}),
      },
      photoIds: rankedIds,
      reserveIds,
    });
    builtKeys.add(dedupKey);
    built++;
  }

  await pruneStaleRecaps(userId, "trip", builtKeys);
  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: person
// ────────────────────────────────────────────────────────────────────────────

interface PersonInfo {
  id: number;
  name: string;
}

// Default name for auto-detected faces that the user has not yet labelled.
// These are skipped everywhere in the recap pipeline — an "Unbenannt"-recap
// carries no memory value for the user.
const UNNAMED_PERSON = "Unbenannt";

async function loadPersonsForUser(userId: number): Promise<PersonInfo[]> {
  return dbAll<PersonInfo>(
    db
      .select({ id: persons.id, name: persons.name })
      .from(persons)
      .where(and(eq(persons.user_id, userId), ne(persons.name, UNNAMED_PERSON)))
  );
}

/**
 * Map personId -> set of photoIds for photos that contain at least one face
 * assigned to the person (and not ignored).
 */
async function loadPersonPhotoMap(userId: number): Promise<Map<number, Set<number>>> {
  const rows = await dbAll<{ person_id: number; photo_id: number }>(
    db
      .select({ person_id: userFaceAssignments.person_id, photo_id: faces.photo_id })
      .from(userFaceAssignments)
      .innerJoin(faces, eq(faces.id, userFaceAssignments.face_id))
      .where(
        and(
          eq(userFaceAssignments.user_id, userId),
          eq(userFaceAssignments.ignored, false),
          isNotNull(userFaceAssignments.person_id)
        )
      )
  );
  const map = new Map<number, Set<number>>();
  for (const row of rows) {
    if (row.person_id == null) continue;
    let set = map.get(row.person_id);
    if (!set) {
      set = new Set<number>();
      map.set(row.person_id, set);
    }
    set.add(row.photo_id);
  }
  return map;
}

const PERSON_RECENT_DAYS = 90;
const PERSON_MIN_PHOTOS = 8;
// Minimum year span between the oldest and newest photo of a person before
// the "Damals & heute" compare slide carries any wow — below this the two
// photos look near-identical and the slide is skipped.
const COMPARE_MIN_YEAR_SPAN = 2;
// Only the top-N most-photographed persons per user get dedicated recaps.
// Without this cap, a user with many recognised faces generates hundreds of
// per-year recaps, most of them for peripheral persons. Choosing 6 keeps the
// closest circle covered (family, partner, closest friends) without swamping
// the feed or the DB.
const PERSON_MAX_PERSONS = 6;

export interface ThenAndNow {
  then: CandidatePhoto;
  thenYear: number;
  now: CandidatePhoto;
  nowYear: number;
}

/**
 * Pick the "Damals & heute" pair for a person: the best-quality photo from
 * the oldest year with photos vs. the best from the newest year. Returns
 * null when the span is below COMPARE_MIN_YEAR_SPAN — a two-month-apart
 * comparison carries no memory value.
 */
export function pickThenAndNow(photos: CandidatePhoto[]): ThenAndNow | null {
  let minYear = Infinity;
  let maxYear = -Infinity;
  const dated: Array<{ photo: CandidatePhoto; year: number }> = [];
  for (const p of photos) {
    const d = effectiveDate(p);
    if (!d) continue;
    const year = d.getFullYear();
    dated.push({ photo: p, year });
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
  }
  if (dated.length < 2 || maxYear - minYear < COMPARE_MIN_YEAR_SPAN) return null;

  const bestOfYear = (year: number): CandidatePhoto | null => {
    let best: CandidatePhoto | null = null;
    for (const { photo, year: y } of dated) {
      if (y !== year) continue;
      if (!best || (photo.ai_quality_score ?? 0) > (best.ai_quality_score ?? 0)) {
        best = photo;
      }
    }
    return best;
  };

  const then = bestOfYear(minYear);
  const now = bestOfYear(maxYear);
  if (!then || !now || then.id === now.id) return null;
  return { then, thenYear: minYear, now, nowYear: maxYear };
}

async function buildPersonRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const personList = await loadPersonsForUser(userId);
  const personPhotos =
    personList.length > 0 ? await loadPersonPhotoMap(userId) : new Map();

  // Rank persons by total assigned photo count and keep only the top-N that
  // also clear the PERSON_MIN_PHOTOS threshold. Persons below the threshold
  // cannot produce a recap anyway, so excluding them here also lets the
  // cleanup query below prune their stale recaps in a single pass.
  const rankedPersons = personList
    .map((p) => ({ person: p, count: personPhotos.get(p.id)?.size ?? 0 }))
    .filter((x) => x.count >= PERSON_MIN_PHOTOS)
    .sort((a, b) => b.count - a.count)
    .slice(0, PERSON_MAX_PERSONS)
    .map((x) => x.person);
  const rankedIds = new Set(rankedPersons.map((p) => p.id));

  // Prune any person-recap whose referenced person is no longer in the
  // selected set — covers unnamed persons, persons that dropped out of the
  // top-N, deleted persons and renamed persons. Without this, old recaps
  // would persist forever because dedup keys are per-person.
  await dbExec(
    db.delete(recaps).where(
      and(
        eq(recaps.user_id, userId),
        eq(recaps.kind, "person"),
        rankedIds.size > 0
          ? sql`(${recaps.seed} ->> 'person_id')::int NOT IN (${sql.join(
              Array.from(rankedIds).map((id) => sql`${id}`),
              sql`, `
            )})`
          : sql`TRUE`
      )
    )
  );

  if (rankedPersons.length === 0) return 0;

  const photosById = new Map(allPhotos.map((p) => [p.id, p]));
  const recentCutoff = new Date(today);
  recentCutoff.setDate(recentCutoff.getDate() - PERSON_RECENT_DAYS);
  const currentYear = today.getFullYear();
  let built = 0;

  for (const person of rankedPersons) {
    const photoIds = personPhotos.get(person.id);
    if (!photoIds || photoIds.size === 0) continue;
    const photosForPerson: CandidatePhoto[] = [];
    for (const pid of photoIds) {
      const p = photosById.get(pid);
      if (p) photosForPerson.push(p);
    }

    // Window 1: last 90 days.
    const recent = photosForPerson.filter((p) => {
      const d = effectiveDate(p);
      return d != null && d >= recentCutoff;
    });
    if (recent.length >= PERSON_MIN_PHOTOS) {
      const { cover, rankedIds, reserveIds } = await curatePhotos(recent);
      // "Damals & heute": oldest vs newest photo of this person across the
      // whole library (not just the window) — the players render it as a
      // split-screen compare slide.
      const compare = pickThenAndNow(photosForPerson);
      const sorted = recent
        .map(effectiveDate)
        .filter((d): d is Date => d != null)
        .sort((a, b) => a.getTime() - b.getTime());
      const dedupKey = `person:${person.id}:recent`;
      const dateRangeLabel =
        sorted.length >= 2
          ? `${sorted[0]!.toLocaleDateString("de-DE", { month: "long", year: "numeric" })} – ${sorted[sorted.length - 1]!.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}`
          : "Zuletzt";
      const resolved = await resolveTitle({
        userId,
        dedupKey,
        fallback: { title: `Mit ${person.name}`, subtitle: dateRangeLabel },
        ctx: {
          kind: "person",
          person_name: person.name,
          date_range: dateRangeLabel,
        },
      });
      await upsertRecap({
        userId,
        kind: "person",
        title: resolved.title,
        subtitle: resolved.subtitle,
        dedupKey,
        coverPhotoId: cover,
        periodStart: sorted[0] ?? null,
        periodEnd: sorted[sorted.length - 1] ?? null,
        score: 55 + Math.min(recent.length, 25),
        seed: {
          person_id: person.id,
          window: "recent",
          days: PERSON_RECENT_DAYS,
          ...(compare
            ? {
                then_photo_id: compare.then.id,
                then_year: compare.thenYear,
                now_photo_id: compare.now.id,
                now_year: compare.nowYear,
              }
            : {}),
          ...(resolved.llmUsed ? { llm_title: true } : {}),
        },
        photoIds: rankedIds,
        reserveIds,
      });
      built++;
    }

    // Window 2: yearly recaps for past calendar years with enough photos.
    const byYear = new Map<number, CandidatePhoto[]>();
    for (const p of photosForPerson) {
      const d = effectiveDate(p);
      if (!d) continue;
      const year = d.getFullYear();
      if (year >= currentYear) continue;
      const arr = byYear.get(year) ?? [];
      arr.push(p);
      byYear.set(year, arr);
    }
    for (const [year, list] of byYear) {
      if (list.length < PERSON_MIN_PHOTOS) continue;
      const { cover, rankedIds, reserveIds } = await curatePhotos(list);
      const start = new Date(year, 0, 1);
      const end = new Date(year, 11, 31, 23, 59, 59);
      const dedupKey = `person:${person.id}:year:${year}`;
      const resolved = await resolveTitle({
        userId,
        dedupKey,
        fallback: {
          title: `${person.name} · ${year}`,
          subtitle: `Jahresrückblick ${year}`,
        },
        ctx: {
          kind: "person",
          person_name: person.name,
          year,
          date_range: String(year),
        },
      });
      await upsertRecap({
        userId,
        kind: "person",
        title: resolved.title,
        subtitle: resolved.subtitle,
        dedupKey,
        coverPhotoId: cover,
        periodStart: start,
        periodEnd: end,
        score: 45 + Math.min(list.length, 30),
        seed: {
          person_id: person.id,
          window: "year",
          year,
          ...(resolved.llmUsed ? { llm_title: true } : {}),
        },
        photoIds: rankedIds,
        reserveIds,
      });
      built++;
    }
  }
  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: recent_highlights (monthly best)
// ────────────────────────────────────────────────────────────────────────────

const RECENT_HIGHLIGHTS_DAYS = 28;
const RECENT_HIGHLIGHTS_MIN_PHOTOS = 6;
const RECENT_HIGHLIGHTS_MIN_DAYS = 3;

async function buildRecentHighlightsRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - RECENT_HIGHLIGHTS_DAYS);
  const recent = allPhotos.filter((p) => {
    const d = effectiveDate(p);
    return d != null && d >= cutoff && d <= today;
  });
  if (recent.length < RECENT_HIGHLIGHTS_MIN_PHOTOS) return 0;
  const distinctDays = new Set(
    recent.map((p) => effectiveDate(p)!.toISOString().slice(0, 10))
  );
  if (distinctDays.size < RECENT_HIGHLIGHTS_MIN_DAYS) return 0;

  const { cover, rankedIds, reserveIds } = await curatePhotos(recent);
  const yyyyMm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const monthLabel = today.toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
  });

  const dedupKey = `recent_highlights:${yyyyMm}`;
  const resolved = await resolveTitle({
    userId,
    dedupKey,
    fallback: { title: "Zuletzt", subtitle: `Deine Highlights im ${monthLabel}` },
    ctx: {
      kind: "recent_highlights",
      month_label: monthLabel,
    },
  });

  await upsertRecap({
    userId,
    kind: "recent_highlights",
    title: resolved.title,
    subtitle: resolved.subtitle,
    dedupKey,
    coverPhotoId: cover,
    periodStart: cutoff,
    periodEnd: today,
    score: 90, // always prominently at the top of the feed
    seed: {
      month: yyyyMm,
      distinct_days: distinctDays.size,
      ...(resolved.llmUsed ? { llm_title: true } : {}),
    },
    photoIds: rankedIds,
    reserveIds,
  });
  return 1;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: place
// ────────────────────────────────────────────────────────────────────────────

const PLACE_MIN_PHOTOS = 20;
const PLACE_MIN_DISTINCT_DAYS = 3;

async function buildPlaceRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const byCity = new Map<string, CandidatePhoto[]>();
  for (const p of allPhotos) {
    // Repair IPTC Latin-1-mojibake city names at the grouping boundary so
    // "Brüssel" and "BrÃ¼ssel" aren't treated as different cities.
    const city = repairMojibake(p.location_city?.trim() ?? "");
    // Skip generic district names ("Altstadt", "Zentrum", …): a place recap
    // titled after them is meaningless, and every city has one.
    if (!city || isGenericPlaceName(city)) continue;
    const arr = byCity.get(city) ?? [];
    arr.push(p);
    byCity.set(city, arr);
  }

  let built = 0;
  const builtKeys = new Set<string>();
  for (const [city, list] of byCity) {
    if (list.length < PLACE_MIN_PHOTOS) continue;
    const dates = list
      .map(effectiveDate)
      .filter((d): d is Date => d != null);
    const distinctDays = new Set(dates.map((d) => d.toISOString().slice(0, 10)));
    if (distinctDays.size < PLACE_MIN_DISTINCT_DAYS) continue;

    const { cover, rankedIds, reserveIds } = await curatePhotos(list);
    const slug = city
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    dates.sort((a, b) => a.getTime() - b.getTime());
    const dedupKey = `place:${slug}`;
    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: city, subtitle: null },
      ctx: {
        kind: "place",
        place_city: city,
      },
    });

    await upsertRecap({
      userId,
      kind: "place",
      title: resolved.title,
      subtitle: resolved.subtitle,
      dedupKey,
      coverPhotoId: cover,
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      score: 30 + Math.min(list.length / 2, 40),
      seed: {
        location_city: city,
        photo_count: list.length,
        distinct_days: distinctDays.size,
        ...(resolved.llmUsed ? { llm_title: true } : {}),
      },
      photoIds: rankedIds,
      reserveIds,
    });
    builtKeys.add(dedupKey);
    built++;
  }
  await pruneStaleRecaps(userId, "place", builtKeys);
  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: theme (CLIP text-prompt search)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Query the embedding_service for photos that match a single CLIP prompt.
 * Returns a map from numeric photo ID to best cosine score seen for this
 * prompt. Returns `null` on network/HTTP failure so the caller can decide
 * whether to continue with the remaining prompts or bail out.
 */
async function queryThemePrompt(
  query: string,
  threshold: number
): Promise<Map<number, number> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THEME_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBEDDING_SERVICE_URL}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: THEME_SEARCH_K, threshold }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ photo_id: string; score: number }>;
    };
    const out = new Map<number, number>();
    for (const r of data.results ?? []) {
      const id = parseInt(r.photo_id, 10);
      if (!Number.isFinite(id)) continue;
      const prev = out.get(id) ?? 0;
      if (r.score > prev) out.set(id, r.score);
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildThemeRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  _today: Date
): Promise<number> {
  if (!THEMES_ENABLED) return 0;
  if (allPhotos.length < THEME_DEFAULT_MIN_PHOTOS) return 0;

  const userPhotosById = new Map(allPhotos.map((p) => [p.id, p]));
  let built = 0;

  for (const theme of RECAP_THEMES) {
    const threshold = theme.threshold ?? THEME_DEFAULT_THRESHOLD;
    const minPhotos = theme.minPhotos ?? THEME_DEFAULT_MIN_PHOTOS;

    // Union scores across all prompt variants. A single failed prompt
    // doesn't kill the whole theme — but if every prompt fails (service
    // down) we skip this theme entirely.
    const scored = new Map<number, number>();
    let anySuccess = false;
    for (const q of theme.queries) {
      const res = await queryThemePrompt(q, threshold);
      if (res == null) continue;
      anySuccess = true;
      for (const [id, score] of res) {
        const prev = scored.get(id) ?? 0;
        if (score > prev) scored.set(id, score);
      }
    }
    if (!anySuccess) {
      console.warn(
        `[recaps] theme builder: embedding_service unreachable for "${theme.slug}", skipping`
      );
      continue;
    }

    const ranked = Array.from(scored.entries())
      .filter(([id]) => userPhotosById.has(id))
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length < minPhotos) continue;

    const rankedIds = ranked
      .slice(0, MAX_PHOTOS_PER_RECAP)
      .map(([id]) => id);
    const cover = rankedIds[0] ?? null;
    const dates = rankedIds
      .map((id) => userPhotosById.get(id))
      .filter((p): p is CandidatePhoto => p != null)
      .map(effectiveDate)
      .filter((d): d is Date => d != null)
      .sort((a, b) => a.getTime() - b.getTime());
    const periodStart = dates[0] ?? null;
    const periodEnd = dates[dates.length - 1] ?? null;
    const dedupKey = `theme:${theme.slug}`;

    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: {
        title: theme.title,
        subtitle: null,
      },
      ctx: {
        kind: "theme",
        keywords: theme.keywords,
      },
    });

    await upsertRecap({
      userId,
      kind: "theme",
      title: resolved.title,
      subtitle: resolved.subtitle,
      dedupKey,
      coverPhotoId: cover,
      periodStart,
      periodEnd,
      score: 35 + Math.min(ranked.length, 30),
      seed: {
        theme: theme.slug,
        keywords: theme.keywords,
        photo_count: ranked.length,
        threshold,
        ...(resolved.llmUsed ? { llm_title: true } : {}),
      },
      photoIds: rankedIds,
    });
    built++;
  }

  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: scene_then_now (same scene photographed years apart)
// ────────────────────────────────────────────────────────────────────────────

const SCENE_ENABLED = (process.env.RECAPS_SCENE_ENABLED ?? "1") !== "0";
const SCENE_MIN_TIME_GAP_DAYS = 730; // 2 years
const SCENE_SIMILARITY_THRESHOLD = 0.70;
const SCENE_MAX_PAIRS = 10;
const SCENE_SAMPLE_SIZE = 1000;
const SCENE_HTTP_TIMEOUT_MS = parseInt(
  process.env.RECAPS_SCENE_TIMEOUT_MS ?? "20000",
  10
);

interface ScenePairResult {
  photo_id_then: string;
  photo_id_now: string;
  similarity: number;
  time_gap_days: number;
}

async function findScenePairsRemote(
  candidates: { photo_id: string; timestamp: number; quality: number }[]
): Promise<ScenePairResult[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCENE_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${EMBEDDING_SERVICE_URL}/find-scene-pairs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidates,
        min_time_gap_days: SCENE_MIN_TIME_GAP_DAYS,
        similarity_threshold: SCENE_SIMILARITY_THRESHOLD,
        max_pairs: SCENE_MAX_PAIRS,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pairs?: ScenePairResult[] };
    return data.pairs ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildSceneRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  _today: Date
): Promise<number> {
  if (!SCENE_ENABLED) return 0;
  if (allPhotos.length < 20) return 0;

  // Sample the highest-quality photos to keep payload and compute bounded.
  const withTimestamp = allPhotos
    .filter((p) => effectiveDate(p) != null)
    .sort(byQualityDesc)
    .slice(0, SCENE_SAMPLE_SIZE);
  if (withTimestamp.length < 10) return 0;

  const candidates = withTimestamp.map((p) => ({
    photo_id: String(p.id),
    timestamp: effectiveDate(p)!.getTime() / 1000,
    quality: p.ai_quality_score ?? 0,
  }));

  const pairs = await findScenePairsRemote(candidates);
  if (!pairs || pairs.length === 0) return 0;

  const photosById = new Map(allPhotos.map((p) => [p.id, p]));
  let built = 0;

  for (const pair of pairs) {
    const thenId = parseInt(pair.photo_id_then, 10);
    const nowId = parseInt(pair.photo_id_now, 10);
    const thenPhoto = photosById.get(thenId);
    const nowPhoto = photosById.get(nowId);
    if (!thenPhoto || !nowPhoto) continue;

    const thenDate = effectiveDate(thenPhoto);
    const nowDate = effectiveDate(nowPhoto);
    if (!thenDate || !nowDate) continue;

    const thenYear = thenDate.getFullYear();
    const nowYear = nowDate.getFullYear();
    const dedupKey = `scene_then_now:${thenId}:${nowId}`;
    const coverPhoto =
      (thenPhoto.ai_quality_score ?? 0) >= (nowPhoto.ai_quality_score ?? 0)
        ? thenPhoto
        : nowPhoto;

    const rawLocationCity =
      nowPhoto.location_city ?? thenPhoto.location_city ?? null;
    // Drop generic district names so they never surface as title/subtitle.
    const locationCity =
      rawLocationCity && !isGenericPlaceName(repairMojibake(rawLocationCity))
        ? rawLocationCity
        : null;
    const locationCountry =
      nowPhoto.location_country ?? thenPhoto.location_country ?? null;

    const fallbackTitle =
      thenYear === nowYear - 1
        ? "Vor einem Jahr"
        : `${nowYear - thenYear} Jahre dazwischen`;
    const fallbackSubtitle = locationCity
      ? repairMojibake(locationCity)
      : repairMojibake(locationCountry);

    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: fallbackTitle, subtitle: fallbackSubtitle },
      ctx: {
        kind: "scene_then_now",
        place_city: locationCity ? repairMojibake(locationCity) : undefined,
        place_country: locationCountry
          ? repairMojibake(locationCountry)
          : undefined,
        year_then: thenYear,
        year_now: nowYear,
      },
    });

    await upsertRecap({
      userId,
      kind: "scene_then_now",
      title: resolved.title,
      subtitle: resolved.subtitle,
      dedupKey,
      coverPhotoId: coverPhoto.id,
      periodStart: thenDate,
      periodEnd: nowDate,
      score: 60 + Math.min(pair.time_gap_days / 365, 10),
      seed: {
        then_photo_id: thenId,
        then_year: thenYear,
        now_photo_id: nowId,
        now_year: nowYear,
        similarity: pair.similarity,
        time_gap_days: pair.time_gap_days,
        ...(locationCity ? { location_city: repairMojibake(locationCity) } : {}),
        ...(resolved.llmUsed ? { llm_title: true } : {}),
      },
      photoIds: [thenId, nowId],
    });
    built++;
  }
  return built;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API: rebuild + list + get + dismiss
// ────────────────────────────────────────────────────────────────────────────

export interface RebuildResult {
  on_this_day: number;
  trip: number;
  person: number;
  recent_highlights: number;
  place: number;
  theme: number;
  scene_then_now: number;
}

export interface RebuildOptions {
  /**
   * Run the theme builder, which makes several HTTP calls to the
   * embedding_service. Disabled for the incremental scheduler path (each
   * scan-worker completion would otherwise cause 16–24 HTTP calls); the
   * daily cron and manual rebuilds keep it on.
   */
  includeThemes?: boolean;
}

export async function rebuildRecapsForUser(
  userId: number,
  now: Date = new Date(),
  options: RebuildOptions = {}
): Promise<RebuildResult> {
  const includeThemes = options.includeThemes ?? true;
  const candidates = await loadVisiblePhotos(userId);
  const on_this_day = await buildOnThisDayRecaps(userId, candidates, now);
  const trip = await buildTripRecaps(userId, candidates, now);
  const person = await buildPersonRecaps(userId, candidates, now);
  const recent_highlights = await buildRecentHighlightsRecaps(userId, candidates, now);
  const place = await buildPlaceRecaps(userId, candidates, now);
  const theme = includeThemes
    ? await buildThemeRecaps(userId, candidates, now)
    : 0;
  const scene_then_now = includeThemes
    ? await buildSceneRecaps(userId, candidates, now)
    : 0;

  // Orphan cleanup: photo deletions cascade through recap_photos, which can
  // leave a recap row with zero members ("0 Fotos" in the feed). The listing
  // also filters these out, but pruning here keeps the table tidy.
  await dbExec(
    db.delete(recaps).where(
      and(
        eq(recaps.user_id, userId),
        sql`NOT EXISTS (SELECT 1 FROM ${recapPhotos}
              WHERE ${recapPhotos.recap_id} = ${recaps.id})`
      )
    )
  );

  return { on_this_day, trip, person, recent_highlights, place, theme, scene_then_now };
}

// Promise-lock guarding rebuildRecapsForAllUsers. See the comment in the
// function body for why this exists.
let allUsersRebuildRunning:
  | Promise<{ users: number; total: RebuildResult }>
  | null = null;

export async function rebuildRecapsForAllUsers(
  now: Date = new Date(),
  options: RebuildOptions = {}
): Promise<{ users: number; total: RebuildResult; skipped?: boolean }> {
  // Encore's cron scheduler fires every 24h regardless of whether the
  // previous run has finished. If a rebuild ever overruns (e.g. a slow
  // embedding/llm service multiplied across many users), we don't want
  // two passes hammering the same DB rows and HTTP backends. A simple
  // in-process promise lock collapses a second trigger into a no-op.
  if (allUsersRebuildRunning) {
    console.warn(
      "[recaps] rebuildRecapsForAllUsers already running — skipping duplicate trigger"
    );
    return {
      users: 0,
      total: {
        on_this_day: 0,
        trip: 0,
        person: 0,
        recent_highlights: 0,
        place: 0,
        theme: 0,
        scene_then_now: 0,
      },
      skipped: true,
    };
  }
  allUsersRebuildRunning = (async () => {
    const rows = await dbAll<{ user_id: number }>(
      db
        .selectDistinct({ user_id: photos.user_id })
        .from(photos)
        .where(isNotNull(photos.user_id))
    );
    const total: RebuildResult = {
      on_this_day: 0,
      trip: 0,
      person: 0,
      recent_highlights: 0,
      place: 0,
      theme: 0,
      scene_then_now: 0,
    };
    for (const row of rows) {
      try {
        const r = await rebuildRecapsForUser(row.user_id, now, options);
        total.on_this_day += r.on_this_day;
        total.trip += r.trip;
        total.person += r.person;
        total.recent_highlights += r.recent_highlights;
        total.place += r.place;
        total.theme += r.theme;
        total.scene_then_now += r.scene_then_now;
      } catch (err: any) {
        console.error(
          `[recaps] rebuild failed for user ${row.user_id}:`,
          err?.message ?? err
        );
      }
    }
    return { users: rows.length, total };
  })();
  try {
    return await allUsersRebuildRunning;
  } finally {
    allUsersRebuildRunning = null;
  }
}

export async function listRecapsForUser(
  userId: number,
  includeDismissed = false
): Promise<RecapSummary[]> {
  // Two-phase selection to keep the feed balanced across recap kinds:
  //   1. SQL: fetch top RECAP_KIND_POOL candidates per kind using a window
  //      function, ranked by (unseen first, score DESC, created_at DESC).
  //   2. TS: apply per-kind quotas, then fill remaining slots from leftover
  //      candidates by the same ranking.
  //
  // Without quotas, a user with many assigned persons can end up with all 50
  // visible slots occupied by person-recaps, hiding trips, places, themes etc.
  const dismissedFilter = includeDismissed
    ? sql``
    : sql`AND dismissed_at IS NULL`;

  type Row = {
    id: number;
    kind: RecapKind;
    title: string;
    subtitle: string | null;
    cover_photo_id: number | null;
    period_start: string | null;
    period_end: string | null;
    created_at: string;
    dismissed_at: string | null;
    seen_at: string | null;
    score: number;
    photo_count: number;
  };

  const result = await db.execute<Row>(sql`
    SELECT id, kind, title, subtitle, cover_photo_id,
           period_start, period_end, created_at, dismissed_at, seen_at, score,
           (SELECT COUNT(*)::int FROM ${recapPhotos}
              WHERE ${recapPhotos.recap_id} = r.id) AS photo_count
    FROM (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY kind
               ORDER BY (seen_at IS NOT NULL),
                        score DESC,
                        created_at DESC
             ) AS rn
      FROM recaps
      WHERE user_id = ${userId}
            ${dismissedFilter}
            -- Orphaned recaps (all photos cascade-deleted) would show up as
            -- "0 Fotos" cards; hide them until the next rebuild prunes them.
            AND EXISTS (SELECT 1 FROM recap_photos rp
                          WHERE rp.recap_id = recaps.id)
    ) r
    WHERE rn <= ${RECAP_KIND_POOL}
  `);
  const candidates = result.rows;

  const rankOrder = (a: Row, b: Row): number => {
    const aSeen = a.seen_at ? 1 : 0;
    const bSeen = b.seen_at ? 1 : 0;
    if (aSeen !== bSeen) return aSeen - bSeen;
    if (a.score !== b.score) return b.score - a.score;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  };

  // Phase 1: bucket candidates by kind, each bucket already sorted via SQL.
  const byKind = new Map<RecapKind, Row[]>();
  for (const row of candidates) {
    const list = byKind.get(row.kind) ?? [];
    list.push(row);
    byKind.set(row.kind, list);
  }
  for (const list of byKind.values()) list.sort(rankOrder);

  // Phase 2a: take up to quota from each kind.
  const picked: Row[] = [];
  const pickedIds = new Set<number>();
  for (const [kind, quota] of Object.entries(RECAP_KIND_QUOTA) as [
    RecapKind,
    number,
  ][]) {
    const pool = byKind.get(kind) ?? [];
    for (const row of pool.slice(0, quota)) {
      picked.push(row);
      pickedIds.add(row.id);
    }
  }

  // Phase 2b: fill remaining slots from leftover candidates, best-scoring first.
  if (picked.length < MAX_VISIBLE_RECAPS) {
    const leftovers = candidates
      .filter((r) => !pickedIds.has(r.id))
      .sort(rankOrder);
    for (const row of leftovers) {
      if (picked.length >= MAX_VISIBLE_RECAPS) break;
      picked.push(row);
      pickedIds.add(row.id);
    }
  }

  // Final ordering shown in the UI.
  picked.sort(rankOrder);

  return picked.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    subtitle: r.subtitle,
    cover_photo_id: r.cover_photo_id,
    period_start: r.period_start,
    period_end: r.period_end,
    photo_count: r.photo_count ?? 0,
    created_at: r.created_at,
    dismissed_at: r.dismissed_at,
    seen_at: r.seen_at,
  }));
}

export async function getRecapForUser(
  userId: number,
  recapId: number
): Promise<RecapDetails | null> {
  const row = await dbFirst<{
    id: number;
    kind: RecapKind;
    title: string;
    subtitle: string | null;
    cover_photo_id: number | null;
    period_start: string | null;
    period_end: string | null;
    created_at: string;
    dismissed_at: string | null;
    seen_at: string | null;
    seed: Record<string, unknown> | null;
  }>(
    db
      .select({
        id: recaps.id,
        kind: recaps.kind,
        title: recaps.title,
        subtitle: recaps.subtitle,
        cover_photo_id: recaps.cover_photo_id,
        period_start: recaps.period_start,
        period_end: recaps.period_end,
        created_at: recaps.created_at,
        dismissed_at: recaps.dismissed_at,
        seen_at: recaps.seen_at,
        seed: recaps.seed,
      })
      .from(recaps)
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
      .limit(1)
  );
  if (!row) return null;

  const photoRows = await dbAll<{ photo_id: number }>(
    db
      .select({ photo_id: recapPhotos.photo_id })
      .from(recapPhotos)
      .where(eq(recapPhotos.recap_id, recapId))
      .orderBy(recapPhotos.rank)
  );

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subtitle: row.subtitle,
    cover_photo_id: row.cover_photo_id,
    period_start: row.period_start,
    period_end: row.period_end,
    created_at: row.created_at,
    dismissed_at: row.dismissed_at,
    seen_at: row.seen_at,
    seed: row.seed ?? {},
    photo_count: photoRows.length,
    photo_ids: photoRows.map((p) => p.photo_id),
  };
}

/**
 * Mark a recap as seen. Idempotent — the first call stamps `seen_at`,
 * subsequent calls are no-ops. Returns `true` if the recap exists for
 * this user (regardless of whether it was already seen), so the frontend
 * can distinguish "not found" from "already seen".
 */
export async function markRecapSeen(
  userId: number,
  recapId: number
): Promise<boolean> {
  const existing = await dbFirst<{ seen_at: string | null }>(
    db
      .select({ seen_at: recaps.seen_at })
      .from(recaps)
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
      .limit(1)
  );
  if (!existing) return false;
  if (existing.seen_at) return true;
  await dbExec(
    db
      .update(recaps)
      .set({ seen_at: new Date().toISOString() })
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
  );
  return true;
}

export async function dismissRecap(userId: number, recapId: number): Promise<boolean> {
  const result = await dbExec(
    db
      .update(recaps)
      .set({ dismissed_at: new Date().toISOString() })
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
  );
  return result.changes > 0;
}

export async function restoreRecap(userId: number, recapId: number): Promise<boolean> {
  const result = await dbExec(
    db
      .update(recaps)
      .set({ dismissed_at: null })
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
  );
  return result.changes > 0;
}

export type ExcludeRecapPhotoResult =
  | {
      status: "ok";
      /** The removed photo id. */
      removed: number;
      /** The backfilled replacement, or null if the reserve was exhausted. */
      added: number | null;
      /** New ordered photo ids for the recap. */
      photo_ids: number[];
      cover_photo_id: number | null;
    }
  | { status: "not_found" }
  | { status: "would_empty" };

type RecapExclusionRow = {
  id: number;
  cover_photo_id: number | null;
  seed: Record<string, unknown> | null;
};

async function fetchRecapForExclusion(
  userId: number,
  recapId: number
): Promise<RecapExclusionRow | null> {
  return dbFirst<RecapExclusionRow>(
    db
      .select({
        id: recaps.id,
        cover_photo_id: recaps.cover_photo_id,
        seed: recaps.seed,
      })
      .from(recaps)
      .where(and(eq(recaps.id, recapId), eq(recaps.user_id, userId)))
      .limit(1)
  );
}

function parseReserveIds(seed: Record<string, unknown> | null | undefined): number[] {
  const raw = seed?.reserve_ids;
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
}

/**
 * Whether `seed` has ever been written by the reserve-aware `upsertRecap`
 * (i.e. carries a `reserve_ids` key at all, even an empty array). False for
 * recaps built before this feature shipped — those need one self-heal
 * rebuild. Deliberately distinct from "reserve is currently empty": once a
 * recap has a real (possibly exhausted) reserve, further exclusions accept
 * the shrink rather than forcing a rebuild on every call.
 */
function hasReserveKey(seed: Record<string, unknown> | null | undefined): boolean {
  return !!seed && Object.prototype.hasOwnProperty.call(seed, "reserve_ids");
}

/**
 * Persistently exclude a photo from a recap and backfill its slot from the
 * ranked reserve (`seed.reserve_ids`). Idempotent per (recap, photo). The
 * exclusion survives the daily rebuild because it is keyed by the stable
 * recap id, and `upsertRecap` re-applies it on every rebuild.
 *
 * Returns the new membership so clients can update in place. Refuses to remove
 * the last remaining photo when there is nothing to backfill with.
 */
export async function excludeRecapPhoto(
  userId: number,
  recapId: number,
  photoId: number
): Promise<ExcludeRecapPhotoResult> {
  let recap = await fetchRecapForExclusion(userId, recapId);
  if (!recap) return { status: "not_found" };

  const photoRows = await dbAll<{ photo_id: number }>(
    db
      .select({ photo_id: recapPhotos.photo_id })
      .from(recapPhotos)
      .where(eq(recapPhotos.recap_id, recapId))
      .orderBy(recapPhotos.rank)
  );
  const currentIds = photoRows.map((r) => r.photo_id);

  // Photo isn't part of the recap (already removed / stale client) — no-op.
  if (!currentIds.includes(photoId)) {
    return {
      status: "ok",
      removed: photoId,
      added: null,
      photo_ids: currentIds,
      cover_photo_id: recap.cover_photo_id,
    };
  }

  // Record the exclusion first so nothing downstream (fast backfill, the
  // rebuild fallback, or the manual fallback below) can re-pick this photo.
  await dbExec(
    db
      .insert(recapExcludedPhotos)
      .values({ recap_id: recapId, photo_id: photoId })
      .onConflictDoNothing()
  );

  const excludedSet = await loadExclusionSet(recapId);
  const currentSet = new Set(currentIds);
  let reserve = parseReserveIds(recap.seed);
  let replacement =
    reserve.find((id) => !excludedSet.has(id) && !currentSet.has(id)) ?? null;

  if (replacement == null && !hasReserveKey(recap.seed)) {
    // This recap predates the reserve mechanism (built before this feature
    // shipped), so there is nothing to draw from yet. Recompute the user's
    // recaps for real (the same cost as the manual "Aktualisieren" rebuild),
    // just this once — upsertRecap re-reads recap_excluded_photos itself, so
    // a rebuilt recap already reflects this exclusion with a freshly
    // backfilled membership and a real `reserve_ids`. Once a recap has that
    // key (even empty), later exclusions accept an exhausted reserve as
    // final instead of forcing a rebuild on every call.
    await rebuildRecapsForUser(userId);
    const after = await fetchRecapForExclusion(userId, recapId);
    if (!after) {
      // The rebuild pruned the now-empty recap (orphan cleanup) — nothing
      // left to exclude from, and the row itself is gone.
      return { status: "would_empty" };
    }
    recap = after;
    reserve = parseReserveIds(after.seed);

    const rebuiltIds = await dbAll<{ photo_id: number }>(
      db
        .select({ photo_id: recapPhotos.photo_id })
        .from(recapPhotos)
        .where(eq(recapPhotos.recap_id, recapId))
        .orderBy(recapPhotos.rank)
    );
    if (!rebuiltIds.some((r) => r.photo_id === photoId)) {
      // upsertRecap ran for this recap this pass and already applied the
      // removal + backfill — nothing more to do.
      const photoIds = rebuiltIds.map((r) => r.photo_id);
      return {
        status: "ok",
        removed: photoId,
        added: photoIds.find((id) => !currentSet.has(id)) ?? null,
        photo_ids: photoIds,
        cover_photo_id: recap.cover_photo_id,
      };
    }
    // The recap's candidate pool no longer meets its kind's minimum
    // threshold, so the builder skipped upserting it this pass and
    // recap_photos still holds the excluded photo. Fall through to the
    // direct removal below so the exclusion is honoured regardless.
    replacement =
      reserve.find((id) => !excludedSet.has(id) && !currentSet.has(id)) ?? null;
  }

  const newIds = currentIds.filter((id) => id !== photoId);
  if (replacement != null) newIds.push(replacement);

  if (newIds.length === 0) {
    // Nothing left and nothing to backfill — roll back the exclusion.
    await dbExec(
      db
        .delete(recapExcludedPhotos)
        .where(
          and(
            eq(recapExcludedPhotos.recap_id, recapId),
            eq(recapExcludedPhotos.photo_id, photoId)
          )
        )
    );
    return { status: "would_empty" };
  }

  await dbExec(db.delete(recapPhotos).where(eq(recapPhotos.recap_id, recapId)));
  await dbExec(
    db.insert(recapPhotos).values(
      newIds.map((pid, idx) => ({ recap_id: recapId, photo_id: pid, rank: idx }))
    )
  );

  const newReserve = reserve.filter(
    (id) => id !== replacement && !excludedSet.has(id)
  );
  const newCover =
    recap.cover_photo_id != null && !excludedSet.has(recap.cover_photo_id)
      ? recap.cover_photo_id
      : (newIds[0] ?? null);
  await dbExec(
    db
      .update(recaps)
      .set({
        seed: { ...(recap.seed ?? {}), reserve_ids: newReserve },
        cover_photo_id: newCover,
      })
      .where(eq(recaps.id, recapId))
  );

  return {
    status: "ok",
    removed: photoId,
    added: replacement,
    photo_ids: newIds,
    cover_photo_id: newCover,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Incremental rebuild scheduler
// ────────────────────────────────────────────────────────────────────────────
//
// Scan jobs (embedding, quality, geocoding, face_assignment) complete at
// variable latency as photos flow through the pipeline. Each completion can
// invalidate a user's recaps — e.g. a newly geocoded photo may belong to an
// existing trip, or a reassigned face may add photos to a person-recap.
//
// Running the full `rebuildRecapsForUser` per completion would be wasteful
// during bulk imports (hundreds of jobs finish in seconds). The scheduler
// below mirrors the `scheduleRegroup` pattern in photo.service.ts:
//   - per-user mutex: at most one rebuild in flight
//   - coalescing: repeated triggers during a run collapse into a single
//     follow-up pass that sees the latest state
//   - debounce after each pass so a burst of scan completions only causes
//     one rebuild once the burst settles

const RECAPS_DEBOUNCE_MS = 60_000;

const recapsRebuildRunning = new Map<number, Promise<void>>();
const recapsRebuildPending = new Set<number>();

export function scheduleRecapsRebuild(userId: number): Promise<void> {
  const existing = recapsRebuildRunning.get(userId);
  if (existing) {
    recapsRebuildPending.add(userId);
    return existing;
  }
  const run = (async () => {
    try {
      do {
        recapsRebuildPending.delete(userId);
        try {
          // Incremental path: skip the theme builder to avoid hammering the
          // embedding_service with prompt queries on every scan completion.
          // The daily cron refreshes themes.
          await rebuildRecapsForUser(userId, new Date(), {
            includeThemes: false,
          });
        } catch (err: any) {
          console.error(
            `[recaps] incremental rebuild failed for user ${userId}:`,
            err?.message ?? err
          );
        }
        if (recapsRebuildPending.has(userId)) {
          await new Promise((r) => setTimeout(r, RECAPS_DEBOUNCE_MS));
        }
      } while (recapsRebuildPending.has(userId));
    } finally {
      recapsRebuildRunning.delete(userId);
    }
  })();
  recapsRebuildRunning.set(userId, run);
  return run;
}
