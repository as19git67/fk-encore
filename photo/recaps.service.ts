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
  person: 15,
  place: 8,
  theme: 5,
};
// Candidate pool size per kind (fetched via window function). Sized to
// MAX_VISIBLE_RECAPS so that a user with only one populated kind can still
// fill the feed from leftovers after the quota pass.
const RECAP_KIND_POOL = MAX_VISIBLE_RECAPS;
const TRIP_MIN_DISTANCE_KM = 100;
const TRIP_MAX_GAP_DAYS = 2;
const TRIP_LOOKBACK_DAYS = 365 * 3;

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
        // Count of photos actually kept in the recap — the raw candidate
        // count would let the LLM write e.g. "708 Fotos" into the subtitle
        // while the player then shows only MAX_PHOTOS_PER_RECAP.
        photo_count: rankedIds.length,
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
      // location_city / location_country may contain UTF-8-as-Latin-1
      // mojibake from IPTC EXIF fields that lack a CodedCharacterSet
      // marker. Repair at the boundary so both the fallback title and
      // the LLM context see clean strings.
      dominantCity: repairMojibake(mostFrequent(bucket.map((p) => p.location_city))),
      dominantCountry: repairMojibake(mostFrequent(bucket.map((p) => p.location_country))),
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
    const fallbackSubtitle = tripSubtitle(cluster);
    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: tripTitle(cluster), subtitle: fallbackSubtitle },
      ctx: {
        kind: "trip",
        place_city: cluster.dominantCity,
        place_country: cluster.dominantCountry,
        date_range: fallbackSubtitle,
        photo_count: rankedIds.length,
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
// per-year recaps, most of them for peripheral persons. Choosing 15 keeps the
// close-circle covered (family, partners, close friends) without swamping
// the feed or the DB.
const PERSON_MAX_PERSONS = 15;

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
      const { cover, rankedIds } = curatePhotos(recent);
      // "Damals & heute": oldest vs newest photo of this person across the
      // whole library (not just the window) — the players render it as a
      // split-screen compare slide.
      const compare = pickThenAndNow(photosForPerson);
      const sorted = recent
        .map(effectiveDate)
        .filter((d): d is Date => d != null)
        .sort((a, b) => a.getTime() - b.getTime());
      const dedupKey = `person:${person.id}:recent`;
      const resolved = await resolveTitle({
        userId,
        dedupKey,
        fallback: { title: `Mit ${person.name}`, subtitle: "Zuletzt" },
        ctx: {
          kind: "person",
          person_name: person.name,
          photo_count: rankedIds.length,
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
      const { cover, rankedIds } = curatePhotos(list);
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
          photo_count: rankedIds.length,
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

  const { cover, rankedIds } = curatePhotos(recent);
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
      photo_count: rankedIds.length,
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
    if (!city) continue;
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

    const { cover, rankedIds } = curatePhotos(list);
    const slug = city
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    dates.sort((a, b) => a.getTime() - b.getTime());
    const dedupKey = `place:${slug}`;
    const resolved = await resolveTitle({
      userId,
      dedupKey,
      fallback: { title: city, subtitle: `${rankedIds.length} Fotos aus ${city}` },
      ctx: {
        kind: "place",
        place_city: city,
        photo_count: rankedIds.length,
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
        subtitle: `${rankedIds.length} Fotos`,
      },
      ctx: {
        kind: "theme",
        keywords: theme.keywords,
        photo_count: rankedIds.length,
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
// Public API: rebuild + list + get + dismiss
// ────────────────────────────────────────────────────────────────────────────

export interface RebuildResult {
  on_this_day: number;
  trip: number;
  person: number;
  recent_highlights: number;
  place: number;
  theme: number;
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

  return { on_this_day, trip, person, recent_highlights, place, theme };
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
