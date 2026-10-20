/**
 * Pure helpers of the nightly aesthetic job (documentation/plans/
 * foto-aesthetik.md, stage 3): the time window, the scale of a Q-Align
 * score, and the composite quality score rebuilt from its parts.
 */

/** The scorer version the job scores towards; `aesthetic-service/scorer.py` reports the same. */
export const AESTHETIC_MODEL = "qalign_v1";

/** Suffix that marks a photo the scorer could not read, so it is not retried every night. */
export const FAILED_SUFFIX = ":failed";

/** Q-Align answers on the 1–5 scale of its model card. */
const QALIGN_MIN = 1;
const QALIGN_MAX = 5;

/** A Q-Align value as 0–1, the scale of the CLIP signal it replaces. */
export function scaleQAlign(value: number): number {
  const scaled = (value - QALIGN_MIN) / (QALIGN_MAX - QALIGN_MIN);
  return Math.round(Math.min(1, Math.max(0, scaled)) * 100) / 100;
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for "HH:MM", or null when the text is not a time. */
export function parseHm(text: string): number | null {
  const m = HM.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The time zone the window is read in: the container's TZ, else Berlin. */
export function windowTimeZone(): string {
  return process.env.TZ?.trim() || "Europe/Berlin";
}

/** Minutes after local midnight of `now` in `timeZone`. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * Whether `now` lies in the window from `start` to `end` (local time, end
 * exclusive). A window may cross midnight (22:00–05:00). Equal ends make no
 * window, and an unreadable time makes none either: a broken setting must
 * never lend the GPU in the middle of the day.
 */
export function inWindow(now: Date, start: string, end: string, timeZone = windowTimeZone()): boolean {
  const from = parseHm(start);
  const to = parseHm(end);
  if (from === null || to === null || from === to) return false;
  const t = localMinutes(now, timeZone);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/**
 * The composite quality score from the parts kept in `ai_quality_details`,
 * the same formula as `/quality` in `embedding_service/app/api/endpoints.py`
 * plus the face-composition blend `indexPhotoQuality` adds. Null when a part
 * the formula needs is missing, i.e. the quality job has not run yet; the
 * composite then stays what it was.
 */
export function compositeFromDetails(details: Record<string, number>): number | null {
  const need = ["clip_aesthetics", "clip_composition", "clip_technical", "sharpness", "contrast", "exposure"];
  if (need.some((k) => typeof details[k] !== "number")) return null;
  const blur =
    typeof details.face_sharpness === "number"
      ? 0.35 * details.sharpness + 0.65 * details.face_sharpness
      : details.sharpness;
  let score =
    0.3 * details.clip_aesthetics +
    0.2 * details.clip_composition +
    0.1 * details.clip_technical +
    0.25 * blur +
    0.1 * details.contrast +
    0.05 * details.exposure;
  if (typeof details.eyes_open === "number") {
    score = Math.min(1, score * (0.75 + 0.25 * details.eyes_open));
  }
  if (typeof details.face_composition === "number") {
    score = score * 0.85 + details.face_composition * 0.15;
  }
  return score;
}

/** What the scorer answered for one photo, on its own 1–5 scale. */
export interface AestheticScores {
  aesthetics: number;
  quality: number;
}

/**
 * The details with the scorer's values in: `clip_aesthetics` takes the
 * aesthetic score under the same key, so the auto-pick and the calibration
 * replay read it unchanged, and `qalign_quality` is added beside it.
 */
export function withAestheticScores(
  details: Record<string, number> | null,
  scores: AestheticScores,
): Record<string, number> {
  return {
    ...(details ?? {}),
    clip_aesthetics: scaleQAlign(scores.aesthetics),
    qalign_quality: scaleQAlign(scores.quality),
  };
}

/** Whether `model` is a successful score by a Q-Align version (not a failure mark). */
export function isAestheticScore(model: string | null | undefined): boolean {
  return !!model && model.startsWith("qalign") && !model.endsWith(FAILED_SUFFIX);
}
