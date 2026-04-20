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

import { and, eq, isNotNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbExec, dbFirst, dbInsertReturning } from "../db/adapter";
import { photos, recaps, recapPhotos, photoCuration } from "../db/schema";

const MIN_PHOTOS_PER_RECAP = 4;
const MAX_PHOTOS_PER_RECAP = 30;
const TRIP_MIN_DISTANCE_KM = 100;
const TRIP_MAX_GAP_DAYS = 2;
const TRIP_LOOKBACK_DAYS = 365 * 3;

export type RecapKind =
  | "on_this_day"
  | "trip"
  | "person"
  | "place"
  | "theme"
  | "recent_highlights";

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
}

export interface RecapDetails extends RecapSummary {
  seed: Record<string, unknown>;
  photo_ids: number[];
}

/** Candidate photo as read from the database when building recaps. */
interface CandidatePhoto {
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

/** Pick cover + kuratierte Reihenfolge nach AI-Quality (null-safe). */
function curatePhotos(candidates: CandidatePhoto[]): {
  cover: number | null;
  rankedIds: number[];
} {
  const sorted = [...candidates].sort((a, b) => {
    const qa = a.ai_quality_score ?? 0;
    const qb = b.ai_quality_score ?? 0;
    if (qb !== qa) return qb - qa;
    const da = effectiveDate(a)?.getTime() ?? 0;
    const dd = effectiveDate(b)?.getTime() ?? 0;
    return dd - da;
  });
  const limited = sorted.slice(0, MAX_PHOTOS_PER_RECAP);
  return {
    cover: limited[0]?.id ?? null,
    rankedIds: limited.map((p) => p.id),
  };
}

/**
 * Upsert a recap by (user_id, dedup_key). Replaces the photo membership
 * wholesale. Keeps dismissed_at if the row already existed — a user who has
 * dismissed a recap should not see it re-appear when the cron rebuilds it.
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
          cover_photo_id: input.coverPhotoId,
          period_start: input.periodStart
            ? input.periodStart.toISOString()
            : null,
          period_end: input.periodEnd ? input.periodEnd.toISOString() : null,
          score: input.score,
          seed: input.seed,
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
          cover_photo_id: input.coverPhotoId,
          period_start: input.periodStart
            ? input.periodStart.toISOString()
            : null,
          period_end: input.periodEnd ? input.periodEnd.toISOString() : null,
          score: input.score,
          dedup_key: input.dedupKey,
          seed: input.seed,
        })
        .returning({ id: recaps.id })
    );
    recapId = inserted!.id;
  }

  if (input.photoIds.length > 0) {
    await dbExec(
      db.insert(recapPhotos).values(
        input.photoIds.map((photoId, idx) => ({
          recap_id: recapId,
          photo_id: photoId,
          rank: idx,
        }))
      )
    );
  }

  return recapId;
}

// ────────────────────────────────────────────────────────────────────────────
// Builder: on_this_day
// ────────────────────────────────────────────────────────────────────────────

function buildOnThisDayGroups(
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
    const { cover, rankedIds } = curatePhotos(photosForYear);
    const periodStart = new Date(year, today.getMonth(), today.getDate());
    const periodEnd = new Date(periodStart);
    periodEnd.setHours(23, 59, 59);

    const title =
      yearsAgo === 1
        ? "Vor einem Jahr"
        : `Vor ${yearsAgo} Jahren`;
    const subtitle = periodStart.toLocaleDateString("de-DE", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const dedupKey = `on_this_day:${year}-${mm}-${dd}`;
    const score = 70 + Math.min(photosForYear.length, 20);

    await upsertRecap({
      userId,
      kind: "on_this_day",
      title,
      subtitle,
      dedupKey,
      coverPhotoId: cover,
      periodStart,
      periodEnd,
      score,
      seed: { years_ago: yearsAgo, month: today.getMonth() + 1, day: today.getDate() },
      photoIds: rankedIds,
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

/**
 * Liefert den geografischen Zentroiden der letzten N Tage — vermutlich der
 * Lebensmittelpunkt des Users. Trips werden relativ dazu als "weit weg"
 * erkannt.
 */
function computeHomeCentroid(
  photos: CandidatePhoto[],
  today: Date
): { lat: number; lon: number } | null {
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 30);
  const recent = photos.filter((p) => {
    const d = effectiveDate(p);
    return d && d >= cutoff && p.latitude != null && p.longitude != null;
  });
  if (recent.length < 10) {
    // Fallback: alle GPS-Fotos
    const withGps = photos.filter(
      (p) => p.latitude != null && p.longitude != null
    );
    if (withGps.length === 0) return null;
    return {
      lat: avg(withGps.map((p) => p.latitude!)),
      lon: avg(withGps.map((p) => p.longitude!)),
    };
  }
  return {
    lat: avg(recent.map((p) => p.latitude!)),
    lon: avg(recent.map((p) => p.longitude!)),
  };
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Clustere GPS-Fotos chronologisch: neuer Trip beginnt, sobald eine
 * Zeitluecke > TRIP_MAX_GAP_DAYS auftritt. Nur Cluster mit signifikantem
 * Abstand zum Home-Zentroid werden als Trip akzeptiert.
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

  const flush = () => {
    if (bucket.length < MIN_PHOTOS_PER_RECAP) {
      bucket = [];
      return;
    }
    const lats = bucket.map((p) => p.latitude!);
    const lons = bucket.map((p) => p.longitude!);
    const cLat = avg(lats);
    const cLon = avg(lons);
    const distance = haversineKm(home.lat, home.lon, cLat, cLon);
    if (distance < TRIP_MIN_DISTANCE_KM) {
      bucket = [];
      return;
    }
    const start = effectiveDate(bucket[0])!;
    const end = effectiveDate(bucket[bucket.length - 1])!;
    clusters.push({
      photos: bucket,
      start,
      end,
      centroidLat: cLat,
      centroidLon: cLon,
      dominantCity: mostFrequent(bucket.map((p) => p.location_city)),
      dominantCountry: mostFrequent(bucket.map((p) => p.location_country)),
    });
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
  if (cluster.dominantCity) return cluster.dominantCity;
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

async function buildTripRecaps(
  userId: number,
  allPhotos: CandidatePhoto[],
  today: Date
): Promise<number> {
  const home = computeHomeCentroid(allPhotos, today);
  const clusters = buildTripClusters(allPhotos, home, today);
  let built = 0;

  for (const cluster of clusters) {
    const { cover, rankedIds } = curatePhotos(cluster.photos);
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

    await upsertRecap({
      userId,
      kind: "trip",
      title: tripTitle(cluster),
      subtitle: tripSubtitle(cluster),
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
        duration_days: durationDays,
      },
      photoIds: rankedIds,
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
}

export async function rebuildRecapsForUser(
  userId: number,
  now: Date = new Date()
): Promise<RebuildResult> {
  const candidates = await loadVisiblePhotos(userId);
  const on_this_day = await buildOnThisDayRecaps(userId, candidates, now);
  const trip = await buildTripRecaps(userId, candidates, now);
  return { on_this_day, trip };
}

export async function rebuildRecapsForAllUsers(
  now: Date = new Date()
): Promise<{ users: number; total: RebuildResult }> {
  const rows = await dbAll<{ user_id: number }>(
    db
      .selectDistinct({ user_id: photos.user_id })
      .from(photos)
      .where(isNotNull(photos.user_id))
  );
  const total: RebuildResult = { on_this_day: 0, trip: 0 };
  for (const row of rows) {
    try {
      const r = await rebuildRecapsForUser(row.user_id, now);
      total.on_this_day += r.on_this_day;
      total.trip += r.trip;
    } catch (err: any) {
      console.error(
        `[recaps] rebuild failed for user ${row.user_id}:`,
        err?.message ?? err
      );
    }
  }
  return { users: rows.length, total };
}

export async function listRecapsForUser(
  userId: number,
  includeDismissed = false
): Promise<RecapSummary[]> {
  const conditions = [eq(recaps.user_id, userId)];
  if (!includeDismissed) {
    conditions.push(sql`${recaps.dismissed_at} IS NULL` as any);
  }

  const rows = await dbAll<{
    id: number;
    kind: RecapKind;
    title: string;
    subtitle: string | null;
    cover_photo_id: number | null;
    period_start: string | null;
    period_end: string | null;
    created_at: string;
    dismissed_at: string | null;
    photo_count: number;
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
        photo_count: sql<number>`(SELECT COUNT(*)::int FROM ${recapPhotos} WHERE ${recapPhotos.recap_id} = ${recaps.id})`,
      })
      .from(recaps)
      .where(and(...conditions))
      .orderBy(sql`${recaps.score} DESC`, sql`${recaps.created_at} DESC`)
  );

  return rows.map((r) => ({
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
    seed: row.seed ?? {},
    photo_count: photoRows.length,
    photo_ids: photoRows.map((p) => p.photo_id),
  };
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
