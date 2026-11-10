/**
 * "Augen zu" hint in the compare view: does this photo show the subject
 * with closed eyes, where the partner photo of the pair shows them open?
 *
 * The CLIP `eyes_open` score (a zero-shot prompt on each face crop, the
 * minimum over all faces) is a weak signal: glasses, a talking mouth or a
 * second face in the background move it as much as a blink does. A photo
 * with clearly open eyes behind glasses got the badge while its partner —
 * the same child laughing with squinted eyes — did not.
 *
 * The eyelid landmarks (`faces.eye_aspect_68`, `faces.eye_aspect`, see
 * `photo/face-eyes.ts` in the backend) measure the eye itself. When both
 * photos carry a landmark measurement for their main face, only that
 * decides; CLIP is the fallback for photos without landmarks (faces too
 * small, or the landmark backfill has not run yet).
 *
 * The thresholds below only gate a hint shown to the user, never the score
 * or the pick — those stay with the replay (documentation/auto-pick-face-relevance.md).
 */

export interface EyeFace {
  bbox?: { x: number; y: number; width: number; height: number } | null
  person_id?: number
  ignored?: boolean
  /** Height over width of the eye contours, 106-point set. */
  eye_aspect?: number | null
  /** Textbook eye aspect ratio (EAR), 68-point set. */
  eye_aspect_68?: number | null
}

/** CLIP fallback: the partner must score this much higher. */
export const CLIP_EYES_DELTA = 0.15

/** Landmarks: the eye must be at most this fraction as open as on the
 *  partner photo. A laugh narrows the eye to roughly two thirds; a blink
 *  leaves less than half. */
export const LANDMARK_EYES_RATIO = 0.6

/** EAR (68 points) below which an eye counts as closing. Open eyes sit
 *  around 0.25–0.35, a blink drops towards 0.1 (Soukupová & Čech 2016). */
export const EAR68_CLOSED = 0.2

export type EyesVerdict =
  | { closed: false }
  | { closed: true; source: 'landmarks' | 'clip'; mine: number; partner: number }

function area(f: EyeFace): number {
  const b = f.bbox
  return b ? (Number(b.width) || 0) * (Number(b.height) || 0) : 0
}

function hasEyes(f: EyeFace): boolean {
  return typeof f.eye_aspect_68 === 'number' || typeof f.eye_aspect === 'number'
}

/** The face both photos are about: a person present in both (largest such
 *  face), otherwise the largest measured face of each photo. */
export function mainFaces(
  mine: EyeFace[],
  partner: EyeFace[],
): [EyeFace, EyeFace] | null {
  const a = mine.filter((f) => !f.ignored && hasEyes(f)).sort((x, y) => area(y) - area(x))
  const b = partner.filter((f) => !f.ignored && hasEyes(f)).sort((x, y) => area(y) - area(x))
  const [firstA] = a
  const [firstB] = b
  if (!firstA || !firstB) return null
  for (const fa of a) {
    if (fa.person_id == null) continue
    const fb = b.find((f) => f.person_id === fa.person_id)
    if (fb) return [fa, fb]
  }
  return [firstA, firstB]
}

/**
 * Verdict for one photo of the pair.
 *
 * `mineFaces`/`partnerFaces` are `undefined` while they are still loading;
 * then no badge is shown rather than a CLIP guess that the landmarks might
 * overturn a moment later.
 */
export function closedEyesVerdict(input: {
  mineFaces: EyeFace[] | undefined
  partnerFaces: EyeFace[] | undefined
  mineClip: number | null
  partnerClip: number | null
}): EyesVerdict {
  const { mineFaces, partnerFaces, mineClip, partnerClip } = input
  if (mineFaces === undefined || partnerFaces === undefined) return { closed: false }

  const pair = mainFaces(mineFaces, partnerFaces)
  if (pair) {
    const [m, p] = pair
    if (typeof m.eye_aspect_68 === 'number' && typeof p.eye_aspect_68 === 'number') {
      const closed = m.eye_aspect_68 < EAR68_CLOSED && m.eye_aspect_68 < p.eye_aspect_68 * LANDMARK_EYES_RATIO
      return closed
        ? { closed: true, source: 'landmarks', mine: m.eye_aspect_68, partner: p.eye_aspect_68 }
        : { closed: false }
    }
    if (typeof m.eye_aspect === 'number' && typeof p.eye_aspect === 'number') {
      const closed = m.eye_aspect < p.eye_aspect * LANDMARK_EYES_RATIO
      return closed
        ? { closed: true, source: 'landmarks', mine: m.eye_aspect, partner: p.eye_aspect }
        : { closed: false }
    }
  }
  // A measured face on one side only: the photos do not show the same eyes
  // in a comparable way, and CLIP alone is not trusted against landmarks.
  if (mineFaces.some(hasEyes) || partnerFaces.some(hasEyes)) return { closed: false }

  if (mineClip === null || partnerClip === null) return { closed: false }
  return partnerClip - mineClip > CLIP_EYES_DELTA
    ? { closed: true, source: 'clip', mine: mineClip, partner: partnerClip }
    : { closed: false }
}

/** Tooltip text for a positive verdict. */
export function closedEyesTooltip(v: EyesVerdict): string {
  if (!v.closed) return ''
  if (v.source === 'landmarks') {
    const pct = Math.round((v.mine / v.partner) * 100)
    return `Augen wirken geschlossen — nur ${pct} % so weit offen wie auf dem anderen Foto (gemessen an den Lidern).`
  }
  const mine = Math.round(v.mine * 100)
  const partner = Math.round(v.partner * 100)
  return `Augen wirken geschlossen (${mine}%) — das andere Foto liegt bei ${partner}%.`
}
