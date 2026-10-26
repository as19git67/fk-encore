/**
 * What a photo shows, for the photo book's subject weighting
 * (documentation/plans/fotobuch.md, stage 4), and which photos of a series
 * of near-duplicates go in.
 *
 * Four subjects — people, landscape, nature, buildings — each a share 0..1:
 *   - people from the faces (a recognisable face counts fully, a small or
 *     blurred one a little) and the CLIP prompts, the stronger of the two;
 *   - landscape, nature and buildings from zero-shot CLIP prompts on the
 *     photo's stored vector (`/zero-shot/score` of the embedding service),
 *     with a fifth catch-all label so a plate of food need not be a mountain;
 *   - buildings also from a confident landmark match (`photo_poi_matches`).
 * The weights (-1 fewer … 1 more) move a photo's score by at most
 * `SUBJECT_WEIGHT_POINTS` per subject, which decides what the narrowing to N
 * photos keeps and which photos open a chapter or get a page of their own.
 *
 * Without the embedding service the CLIP shares are missing and only faces
 * and landmarks count; the book is still built.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { faces, photoGroupMembers, photoGroups, photoPoiMatches, type PhotoBookWeights } from "../db/schema";
import { fetchWithTimeout } from "./rpc-timeout";
import { RECOGNISABLE_FACE_MIN_AREA, RECOGNISABLE_FACE_MIN_SHARPNESS, type BookPhoto } from "./photo-book-layout";

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8001";
/** Photo ids per `/zero-shot/score` request (the service takes up to 2000). */
const ZERO_SHOT_BATCH = 1_000;
const ZERO_SHOT_TIMEOUT_MS = 60_000;

export const PHOTO_BOOK_SUBJECTS = ["people", "landscape", "nature", "buildings"] as const;
export type PhotoBookSubject = (typeof PHOTO_BOOK_SUBJECTS)[number];
export type SubjectShares = Record<PhotoBookSubject, number>;

/** A full weight moves a photo that is all one subject by this many points (of 100). */
export const SUBJECT_WEIGHT_POINTS = 30;
/** A face too small or blurred to recognise still says "people" a little. */
const SMALL_FACE_PEOPLE = 0.35;
/** A confident landmark match says "building" at least this much. */
const LANDMARK_BUILDINGS = 0.7;
const LANDMARK_MIN_SCORE = 0.5;

/** CLIP prompts per label; English, which the model reads best. */
export const ZERO_SHOT_LABELS: { key: PhotoBookSubject | "other"; prompts: string[] }[] = [
  { key: "people", prompts: ["a photo of people", "a portrait of a person", "a group of friends smiling"] },
  { key: "landscape", prompts: ["a landscape photo", "a wide view of mountains and valleys", "a view over the sea and the coast"] },
  { key: "nature", prompts: ["a photo of plants and flowers", "a photo of an animal in nature", "a forest with trees"] },
  { key: "buildings", prompts: ["a photo of a building", "a photo of a church or a castle", "a city street with houses"] },
  { key: "other", prompts: ["a photo of food on a table", "a photo of an object", "a photo of a room indoors"] },
];

export function hasWeights(w: PhotoBookWeights | null | undefined): boolean {
  return !!w && PHOTO_BOOK_SUBJECTS.some((k) => (w[k] ?? 0) !== 0);
}

/** Weights clamped to -1..1, zeros left out; null when nothing is weighted. */
export function cleanWeights(w: PhotoBookWeights | null | undefined): PhotoBookWeights | null {
  if (!w) return null;
  const out: PhotoBookWeights = {};
  for (const k of PHOTO_BOOK_SUBJECTS) {
    const v = Number(w[k] ?? 0);
    if (Number.isFinite(v) && v !== 0) out[k] = Math.max(-1, Math.min(1, v));
  }
  return Object.keys(out).length ? out : null;
}

/** A photo's score moved by its subjects, kept within 0..100. */
export function weightedScore(score: number, shares: Partial<SubjectShares> | undefined, w: PhotoBookWeights | null | undefined): number {
  if (!shares || !w) return score;
  let delta = 0;
  for (const k of PHOTO_BOOK_SUBJECTS) delta += (w[k] ?? 0) * (shares[k] ?? 0) * SUBJECT_WEIGHT_POINTS;
  return Math.max(0, Math.min(100, score + delta));
}

export interface FaceSignal {
  recognisable: boolean;
  any: boolean;
}

/** The shares of one photo from its CLIP labels, faces and landmark. */
export function combineShares(clip: Partial<Record<string, number>> | undefined, face: FaceSignal | undefined, landmark: boolean): SubjectShares {
  const c = (k: string) => clip?.[k] ?? 0;
  const facePeople = face?.recognisable ? 1 : face?.any ? SMALL_FACE_PEOPLE : 0;
  return {
    people: Math.max(c("people"), facePeople),
    landscape: c("landscape"),
    nature: c("nature"),
    buildings: Math.max(c("buildings"), landmark ? LANDMARK_BUILDINGS : 0),
  };
}

// ── what the subjects are read from ─────────────────────────────────────

export type ZeroShotScorer = (photoIds: number[]) => Promise<Map<number, Record<string, number>>>;

async function zeroShotFromService(photoIds: number[]): Promise<Map<number, Record<string, number>>> {
  const out = new Map<number, Record<string, number>>();
  for (let i = 0; i < photoIds.length; i += ZERO_SHOT_BATCH) {
    const batch = photoIds.slice(i, i + ZERO_SHOT_BATCH);
    try {
      const res = await fetchWithTimeout(`${EMBEDDING_SERVICE_URL}/zero-shot/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_ids: batch.map(String), labels: ZERO_SHOT_LABELS }),
        timeoutMs: ZERO_SHOT_TIMEOUT_MS,
        queue: "embedding",
      });
      if (!res.ok) throw new Error(`embedding service returned ${res.status}`);
      const body = (await res.json()) as { scores: { photo_id: string; values: Record<string, number> }[] };
      for (const s of body.scores) out.set(Number(s.photo_id), s.values);
    } catch (err) {
      // The book is built without the CLIP shares rather than not at all.
      console.warn("[photo-book] zero-shot subjects unavailable:", (err as Error).message);
      return out;
    }
  }
  return out;
}

let scorer: ZeroShotScorer = zeroShotFromService;

/** Tests hand in their own scorer; `null` restores the embedding service. */
export function setZeroShotScorer(next: ZeroShotScorer | null): void {
  scorer = next ?? zeroShotFromService;
}

async function faceSignals(photoIds: number[]): Promise<Map<number, FaceSignal>> {
  const out = new Map<number, FaceSignal>();
  if (!photoIds.length) return out;
  const rows = await dbAll<{ photo_id: number; recognisable: boolean }>(
    db.select({
      photo_id: faces.photo_id,
      recognisable: sql<boolean>`BOOL_OR(
        COALESCE((${faces.bbox}::jsonb->>'width')::float8, 0) * COALESCE((${faces.bbox}::jsonb->>'height')::float8, 0) >= ${RECOGNISABLE_FACE_MIN_AREA}
        AND (${faces.sharpness} IS NULL OR ${faces.sharpness} >= ${RECOGNISABLE_FACE_MIN_SHARPNESS})
      )`,
    }).from(faces).where(inArray(faces.photo_id, photoIds)).groupBy(faces.photo_id),
  );
  for (const r of rows) out.set(r.photo_id, { recognisable: !!r.recognisable, any: true });
  return out;
}

async function landmarkPhotos(photoIds: number[]): Promise<Set<number>> {
  if (!photoIds.length) return new Set();
  const rows = await dbAll<{ photo_id: number }>(
    db.selectDistinct({ photo_id: photoPoiMatches.photo_id }).from(photoPoiMatches).where(and(
      inArray(photoPoiMatches.photo_id, photoIds),
      eq(photoPoiMatches.ambiguous, false),
      sql`${photoPoiMatches.match_score} >= ${LANDMARK_MIN_SCORE}`,
    )),
  );
  return new Set(rows.map((r) => r.photo_id));
}

/** The subject shares of `photoIds`. */
export async function loadSubjectShares(photoIds: number[]): Promise<Map<number, SubjectShares>> {
  const [clip, face, landmark] = await Promise.all([scorer(photoIds), faceSignals(photoIds), landmarkPhotos(photoIds)]);
  const out = new Map<number, SubjectShares>();
  for (const id of photoIds) out.set(id, combineShares(clip.get(id), face.get(id), landmark.has(id)));
  return out;
}

// ── series of near-duplicates ───────────────────────────────────────────

export interface SeriesMember {
  group_id: number;
  photo_id: number;
  /** The model's picks of an unreviewed group; null when it has none. */
  picks: number[] | null;
}

/**
 * The photos of `list` that stay when a series contributes only its pick.
 * A series the owner reviewed already hid what it does not keep (the
 * selection leaves hidden photos out), so only unreviewed series are thinned:
 * to the model's picks where it made some, else to the best photo of the
 * series in the list. A photo in several series must survive each of them.
 */
export function keepSeriesPicks<T extends BookPhoto>(list: T[], members: SeriesMember[]): T[] {
  const byGroup = new Map<number, SeriesMember[]>();
  for (const m of members) byGroup.set(m.group_id, [...(byGroup.get(m.group_id) ?? []), m]);
  const inList = new Map(list.map((p) => [p.id, p]));
  const drop = new Set<number>();
  for (const group of byGroup.values()) {
    const present = group.filter((m) => inList.has(m.photo_id));
    if (present.length < 2) continue;
    const picks = group[0].picks;
    const keep = picks?.length && present.some((m) => picks.includes(m.photo_id))
      ? new Set(picks)
      : new Set([present.map((m) => inList.get(m.photo_id)!).sort((a, b) => b.score - a.score || a.id - b.id)[0].id]);
    for (const m of present) if (!keep.has(m.photo_id)) drop.add(m.photo_id);
  }
  return list.filter((p) => !drop.has(p.id));
}

/** The owner's unreviewed series that hold any of `photoIds`, with all their members. */
export async function loadSeries(userId: number, photoIds: number[]): Promise<SeriesMember[]> {
  if (!photoIds.length) return [];
  return dbAll<SeriesMember>(
    db.select({ group_id: photoGroupMembers.group_id, photo_id: photoGroupMembers.photo_id, picks: photoGroups.ai_picked_photo_ids })
      .from(photoGroupMembers)
      .innerJoin(photoGroups, eq(photoGroups.id, photoGroupMembers.group_id))
      .where(and(
        eq(photoGroups.user_id, userId),
        isNull(photoGroups.reviewed_at),
        inArray(photoGroupMembers.group_id,
          db.select({ id: photoGroupMembers.group_id }).from(photoGroupMembers).where(inArray(photoGroupMembers.photo_id, photoIds))),
      )),
  );
}
