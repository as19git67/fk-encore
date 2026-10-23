/**
 * Eyes and mouth from the facial landmarks, measured against the user's own
 * decisions — the in-app version of scripts/photos/diagnose-eyes-open.mjs,
 * behind the card "Augen und Lächeln" on Fotos › Einstellungen › Ästhetik.
 *
 * Pairs come from reviewed similarity groups: one kept photo against one the
 * user hid. A signal "decides" a pair when its values differ by more than
 * EPS and "hits" when the kept photo has the higher value. Per photo, the
 * faces are averaged weighted by prominence (`computeFaceProminence`), the
 * same weighting the auto-pick uses, not by `min()`.
 *
 * The eye ratios are compared with today's CLIP `eyes_open` on exactly the
 * pairs where both have a value. For the mouth there is no existing signal,
 * so chance (50 %) is the baseline. Nothing here changes the auto-pick.
 */

import { sql } from "drizzle-orm";
import db from "../db/database";
import { MIN_EYE_FACE_PIXELS } from "./face-eyes";
import { computeFaceProminence } from "./group-auto-pick";

/** Difference above which a signal decides a pair. */
export const EPS = 0.01;
/** Decided pairs below which no verdict is given. */
export const MIN_DECIDED_PAIRS = 30;
/** Share of faces with landmarks below which no verdict is given. */
export const MIN_COVERAGE = 0.9;
/** Hit rate on large differences a mouth signal needs to count as above chance. */
export const MOUTH_MIN_STRONG_RATE = 0.55;

export type FaceSignalKey = "eye_aspect" | "eye_aspect_68" | "mouth_lift" | "mouth_width" | "mouth_lift_68" | "mouth_width_68";

export const FACE_SIGNALS: Array<{ key: FaceSignalKey; label: string; kind: "eyes" | "mouth" }> = [
  { key: "eye_aspect", label: "Augenöffnung (106 Punkte)", kind: "eyes" },
  { key: "eye_aspect_68", label: "Augenöffnung (68 Punkte)", kind: "eyes" },
  { key: "mouth_lift", label: "Mundwinkel-Hebung (106 Punkte)", kind: "mouth" },
  { key: "mouth_width", label: "Mundbreite (106 Punkte)", kind: "mouth" },
  { key: "mouth_lift_68", label: "Mundwinkel-Hebung (68 Punkte)", kind: "mouth" },
  { key: "mouth_width_68", label: "Mundbreite (68 Punkte)", kind: "mouth" },
];

export interface FaceRow {
  area: number;
  known: boolean;
  values: Partial<Record<FaceSignalKey, number | null>>;
}

export interface GroupPhoto {
  hidden: boolean;
  /** CLIP `eyes_open` from `photos.ai_quality_details`. */
  clip: number | null;
  faces: FaceRow[];
}

export interface PairCounts {
  pairs: number;
  decided: number;
  hits: number;
  /** Upper half of the decided pairs by size of the difference. */
  strong: number;
  strong_hits: number;
}

export interface SignalResult extends PairCounts {
  key: FaceSignalKey;
  label: string;
  kind: "eyes" | "mouth";
  /** CLIP on the same pairs; eyes only. */
  clip: PairCounts | null;
  verdict: "better" | "not_better" | "too_few" | "no_coverage";
}

export interface FaceSignalsReport {
  coverage: {
    faces: number;
    with_landmarks: number;
    large_enough: number;
    with_eyes: number;
    with_mouth: number;
  };
  reviewed_groups: number;
  pairs: number;
  signals: SignalResult[];
  /** Why no verdict is possible at all, or null. */
  blocked: string | null;
  min_decided_pairs: number;
}

type PhotoValues = { clip: number | null } & Partial<Record<FaceSignalKey, number | null>>;

function weighted(faces: FaceRow[], key: FaceSignalKey): number | null {
  let weights = 0;
  let sum = 0;
  for (const f of faces) {
    const v = f.values[key];
    if (v == null) continue;
    const w = computeFaceProminence(f.area, f.known);
    if (w <= 0) continue;
    weights += w;
    sum += w * v;
  }
  return weights > 0 ? sum / weights : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type Pair = { k: PhotoValues; h: PhotoValues };

function count(pairs: Pair[], key: FaceSignalKey | "clip"): PairCounts {
  const diff = (p: Pair) => (p.k[key] as number) - (p.h[key] as number);
  const decided = pairs.filter((p) => Math.abs(diff(p)) > EPS);
  const cut = median(decided.map((p) => Math.abs(diff(p))));
  const strong = cut == null ? [] : decided.filter((p) => Math.abs(diff(p)) >= cut);
  return {
    pairs: pairs.length,
    decided: decided.length,
    hits: decided.filter((p) => diff(p) > 0).length,
    strong: strong.length,
    strong_hits: strong.filter((p) => diff(p) > 0).length,
  };
}

const rate = (hits: number, n: number) => (n > 0 ? hits / n : 0);

/** Pure part: pairs, counts and verdicts from already loaded groups. */
export function evaluateFaceSignals(
  groups: GroupPhoto[][],
  coverageOk: boolean,
): { pairs: number; signals: SignalResult[] } {
  const pairs: Pair[] = [];
  for (const group of groups) {
    const photos: Array<PhotoValues & { hidden: boolean }> = group.map((p) => {
      const values: PhotoValues & { hidden: boolean } = { clip: p.clip, hidden: p.hidden };
      for (const s of FACE_SIGNALS) values[s.key] = weighted(p.faces, s.key);
      return values;
    });
    for (const k of photos.filter((p) => !p.hidden)) {
      for (const h of photos.filter((p) => p.hidden)) pairs.push({ k, h });
    }
  }

  const signals = FACE_SIGNALS.map((s): SignalResult => {
    const has = (p: Pair, key: FaceSignalKey | "clip") => p.k[key] != null && p.h[key] != null;
    if (s.kind === "eyes") {
      const common = pairs.filter((p) => has(p, s.key) && has(p, "clip"));
      const own = count(common, s.key);
      const clip = count(common, "clip");
      const verdict = !coverageOk
        ? "no_coverage"
        : own.decided < MIN_DECIDED_PAIRS
          ? "too_few"
          : rate(own.hits, own.decided) > rate(clip.hits, clip.decided) && own.decided >= clip.decided * 0.5
            ? "better"
            : "not_better";
      return { key: s.key, label: s.label, kind: s.kind, ...own, clip, verdict };
    }
    const own = count(pairs.filter((p) => has(p, s.key)), s.key);
    const verdict = !coverageOk
      ? "no_coverage"
      : own.decided < MIN_DECIDED_PAIRS
        ? "too_few"
        : rate(own.strong_hits, own.strong) >= MOUTH_MIN_STRONG_RATE
          ? "better"
          : "not_better";
    return { key: s.key, label: s.label, kind: s.kind, ...own, clip: null, verdict };
  });
  return { pairs: pairs.length, signals };
}

/** Loads the caller's faces and reviewed groups and evaluates them. */
export async function faceSignalsReport(userId: number): Promise<FaceSignalsReport> {
  const cov = (
    await db.execute<{
      faces: number;
      with_landmarks: number;
      large_enough: number;
      with_eyes: number;
      with_mouth: number;
    }>(sql`
      SELECT COUNT(*)::int AS faces,
             COUNT(f.landmarks)::int AS with_landmarks,
             COUNT(*) FILTER (
               WHERE p.width IS NOT NULL
                 AND COALESCE((f.bbox::jsonb->>'width')::float, 0) * p.width >= ${MIN_EYE_FACE_PIXELS}
             )::int AS large_enough,
             COUNT(*) FILTER (WHERE f.eye_aspect IS NOT NULL OR f.eye_aspect_68 IS NOT NULL)::int AS with_eyes,
             COUNT(*) FILTER (WHERE f.mouth_lift IS NOT NULL OR f.mouth_lift_68 IS NOT NULL)::int AS with_mouth
        FROM faces f
        JOIN photos p ON p.id = f.photo_id
       WHERE p.user_id = ${userId}
    `)
  ).rows[0];
  const coverage = {
    faces: Number(cov?.faces ?? 0),
    with_landmarks: Number(cov?.with_landmarks ?? 0),
    large_enough: Number(cov?.large_enough ?? 0),
    with_eyes: Number(cov?.with_eyes ?? 0),
    with_mouth: Number(cov?.with_mouth ?? 0),
  };

  const rows = (
    await db.execute<{
      group_id: number;
      photo_id: number;
      clip: number | null;
      hidden: boolean;
      bbox: string | null;
      known: boolean;
    } & Record<FaceSignalKey, number | null>>(sql`
      SELECT pg.id AS group_id, gm.photo_id,
             (p.ai_quality_details->>'eyes_open')::float AS clip,
             EXISTS (SELECT 1 FROM photo_curation pc
                      WHERE pc.photo_id = gm.photo_id AND pc.user_id = pg.user_id
                        AND pc.status = 'hidden') AS hidden,
             f.bbox, f.eye_aspect, f.eye_aspect_68,
             f.mouth_lift, f.mouth_width, f.mouth_lift_68, f.mouth_width_68,
             (ufa.person_id IS NOT NULL) AS known
        FROM photo_groups pg
        JOIN photo_group_members gm ON gm.group_id = pg.id
        JOIN photos p ON p.id = gm.photo_id
        LEFT JOIN faces f ON f.photo_id = gm.photo_id
        LEFT JOIN user_face_assignments ufa ON ufa.face_id = f.id AND ufa.user_id = pg.user_id
       WHERE pg.reviewed_at IS NOT NULL
         AND pg.user_id = ${userId}
    `)
  ).rows;

  const groups = new Map<number, Map<number, GroupPhoto>>();
  for (const r of rows) {
    let g = groups.get(r.group_id);
    if (!g) groups.set(r.group_id, (g = new Map()));
    let photo = g.get(r.photo_id);
    if (!photo) {
      photo = { hidden: r.hidden === true, clip: r.clip == null ? null : Number(r.clip), faces: [] };
      g.set(r.photo_id, photo);
    }
    if (r.bbox == null) continue;
    let area = 0;
    try {
      const b = JSON.parse(r.bbox) as { width?: number; height?: number };
      area = (Number(b.width) || 0) * (Number(b.height) || 0);
    } catch {
      area = 0;
    }
    const values: FaceRow["values"] = {};
    for (const s of FACE_SIGNALS) values[s.key] = r[s.key] == null ? null : Number(r[s.key]);
    photo.faces.push({ area, known: r.known === true, values });
  }

  const coverageOk = coverage.faces > 0 && coverage.with_landmarks / coverage.faces >= MIN_COVERAGE;
  const blocked =
    coverage.faces === 0
      ? "Es gibt noch keine erkannten Gesichter."
      : coverage.with_landmarks === 0
        ? "Noch kein Gesicht hat Landmarken. Erst „Gesichtslandmarken nachtragen“ unter Wartung laufen lassen."
        : !coverageOk
          ? `Erst ${Math.round((coverage.with_landmarks / coverage.faces) * 100)} % der Gesichter haben Landmarken. ` +
            `Ein Urteil gibt es ab ${Math.round(MIN_COVERAGE * 100)} %, vorher sind die auswertbaren Paare keine zufällige Auswahl.`
          : null;

  const { pairs, signals } = evaluateFaceSignals(
    [...groups.values()].map((g) => [...g.values()]),
    coverageOk,
  );
  return {
    coverage,
    reviewed_groups: groups.size,
    pairs,
    signals,
    blocked,
    min_decided_pairs: MIN_DECIDED_PAIRS,
  };
}
