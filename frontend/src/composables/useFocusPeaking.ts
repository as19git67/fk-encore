/**
 * Focus-peaking state for the photo review (issue #873).
 *
 * Holds the on/off switch (persisted, default ON) and the measured per-face
 * sharpness scores. The measuring itself runs on a throwaway canvas against
 * the `<img>` element that is already on screen — photo files are served from
 * the same origin as the app, so the canvas stays untainted and no extra
 * network request is needed.
 *
 * The scoring maths lives in `utils/focusPeaking.ts` (DOM-free, unit-tested).
 */

import { ref, readonly } from 'vue'
import type { Face } from '../api/photos'
import {
  FACE_SAMPLE_SIZE,
  faceCropRect,
  sharpnessFromRgba,
} from '../utils/focusPeaking'

const STORAGE_KEY = 'focus_peaking_enabled'

function loadEnabled(): boolean {
  try {
    // Default ON — the switch only ever stores an explicit user choice.
    return localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

const enabled = ref(loadEnabled())

/** photoId → (faceId → sharpness score 0..1). */
const scores = ref(new Map<number, Map<number, number>>())

/** Photos whose measurement already ran (successfully or not) — keeps the
 *  canvas work to once per photo per session. */
const measured = new Set<number>()

let sampleCanvas: HTMLCanvasElement | null = null

function getSampleContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = FACE_SAMPLE_SIZE
    sampleCanvas.height = FACE_SAMPLE_SIZE
  }
  // `willReadFrequently` keeps the repeated getImageData calls on the CPU
  // path instead of round-tripping the GPU for every face.
  return sampleCanvas.getContext('2d', { willReadFrequently: true })
}

/**
 * Measure every usable face of `photoId` against the rendered image element.
 * No-op when the photo was measured before, the image isn't decoded yet, or
 * the browser refuses to hand out the pixels (tainted canvas).
 */
function measure(photoId: number, img: HTMLImageElement, faces: Face[]): void {
  if (measured.has(photoId)) return
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height) return

  const ctx = getSampleContext()
  if (!ctx) return

  const perFace = new Map<number, number>()
  for (const face of faces) {
    if (face.ignored) continue
    const rect = faceCropRect(face.bbox, width, height)
    if (!rect) continue
    try {
      ctx.clearRect(0, 0, FACE_SAMPLE_SIZE, FACE_SAMPLE_SIZE)
      ctx.drawImage(
        img,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        FACE_SAMPLE_SIZE,
        FACE_SAMPLE_SIZE,
      )
      const { data } = ctx.getImageData(0, 0, FACE_SAMPLE_SIZE, FACE_SAMPLE_SIZE)
      perFace.set(face.id, sharpnessFromRgba(data, FACE_SAMPLE_SIZE, FACE_SAMPLE_SIZE))
    } catch (err) {
      // A tainted canvas throws on the first getImageData and would throw for
      // every other face too — give up on this photo rather than spam.
      console.warn('[focus-peaking] sharpness measurement failed', photoId, err)
      return
    }
  }

  measured.add(photoId)
  scores.value = new Map(scores.value).set(photoId, perFace)
}

function scoresFor(photoId: number): Map<number, number> | undefined {
  return scores.value.get(photoId)
}

function setEnabled(value: boolean): void {
  enabled.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    /* private mode / quota — the in-memory switch still works */
  }
}

function toggle(): void {
  setEnabled(!enabled.value)
}

/** Drop all measurements — used by tests and after a re-detection of faces. */
function reset(): void {
  measured.clear()
  scores.value = new Map()
}

export function useFocusPeaking() {
  return {
    enabled: readonly(enabled),
    setEnabled,
    toggle,
    measure,
    scoresFor,
    scores: readonly(scores),
    reset,
  }
}
