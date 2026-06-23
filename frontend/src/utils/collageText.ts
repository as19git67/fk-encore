// Text-overlay model + layout helpers for the photo collage.
//
// A collage can carry one free text caption laid over the whole canvas. The
// overlay is positioned by its centre point, normalized (0..1) inside the
// collage canvas, so it survives layout switches (which change the canvas
// aspect but not the normalized geometry) and renders identically in the DOM
// preview and the exported JPEG.
//
// Font sizes are expressed as a fraction of the canvas *height* so the same
// preset looks the same whether the preview stage is 300 px or the export is
// 2000 px tall: the preview multiplies the fraction by the rendered stage
// height (via container-query `cqh` units), the export by the canvas height.

export type CollageTextAlign = 'left' | 'center' | 'right'

export interface CollageTextFontPreset {
  key: 'small' | 'medium' | 'large'
  label: string
  /** Font size as a fraction of the collage canvas height. */
  heightFraction: number
}

export const COLLAGE_TEXT_FONTS: CollageTextFontPreset[] = [
  { key: 'small', label: 'Klein', heightFraction: 0.05 },
  { key: 'medium', label: 'Mittel', heightFraction: 0.08 },
  { key: 'large', label: 'Groß', heightFraction: 0.13 },
]

export interface CollageTextOverlay {
  text: string
  /** Normalized centre position within the canvas (0..1). */
  x: number
  y: number
  fontKey: CollageTextFontPreset['key']
  align: CollageTextAlign
  /** Fill colour as a CSS hex string, e.g. `"#ffffff"`. */
  color: string
}

/** A fresh, centred, medium overlay with no text. */
export function defaultTextOverlay(): CollageTextOverlay {
  return { text: '', x: 0.5, y: 0.5, fontKey: 'medium', align: 'center', color: '#ffffff' }
}

/** The preset for `key`, falling back to the medium preset. */
export function collageFontPreset(key: CollageTextFontPreset['key']): CollageTextFontPreset {
  return COLLAGE_TEXT_FONTS.find((f) => f.key === key) ?? COLLAGE_TEXT_FONTS[1]!
}

/** Clamp `v` to [0, 1]; non-finite input collapses to the centre (0.5). */
export function clampUnit(v: number | undefined | null): number {
  if (v == null || !Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * Extract up to `maxColors` visually distinct, vivid colours from a set of
 * images. Each image is drawn onto a tiny off-screen canvas; pixels are
 * quantised into 16-step buckets and scored by frequency × saturation² so
 * that frequently occurring vivid hues win. Similar colours (Euclidean RGB
 * distance < 60) are deduplicated so the result is visually diverse.
 *
 * Not unit-tested — requires the Canvas API (unavailable in jsdom).
 */
export function extractDominantColors(imgs: HTMLImageElement[], maxColors = 6): string[] {
  const SIZE = 64
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  const scores = new Map<string, number>()

  for (const img of imgs) {
    ctx.clearRect(0, 0, SIZE, SIZE)
    try {
      ctx.drawImage(img, 0, 0, SIZE, SIZE)
    } catch {
      continue
    }
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE)
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      // 16-step quantisation (step of 16)
      const qr = Math.round(r / 16) * 16
      const qg = Math.round(g / 16) * 16
      const qb = Math.round(b / 16) * 16
      // HSV-style saturation: (max−min)/max
      const max = Math.max(qr, qg, qb)
      const min = Math.min(qr, qg, qb)
      const sat = max === 0 ? 0 : (max - min) / max
      // Skip near-grey and very dark pixels — they make poor text colours
      if (sat < 0.2 || max < 40) continue
      const key = `${qr},${qg},${qb}`
      scores.set(key, (scores.get(key) ?? 0) + sat * sat)
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const result: string[] = []

  for (const [key] of sorted) {
    if (result.length >= maxColors) break
    const parts = key.split(',')
    const r = Number(parts[0])
    const g = Number(parts[1])
    const b = Number(parts[2])
    const tooClose = result.some((hex) => {
      const pr = parseInt(hex.slice(1, 3), 16)
      const pg = parseInt(hex.slice(3, 5), 16)
      const pb = parseInt(hex.slice(5, 7), 16)
      return Math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2) < 60
    })
    if (!tooClose) {
      result.push(
        `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
      )
    }
  }

  return result
}

/**
 * Word-wrap `text` into lines no wider than `maxWidth`, honouring explicit
 * newlines (each `\n` always starts a new line, blank lines preserved).
 * `measure` returns the rendered pixel width of a string. A single word wider
 * than `maxWidth` is kept on its own line rather than broken mid-word, matching
 * the CSS `word-break: normal` / `white-space: pre-wrap` preview.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (line && maxWidth > 0 && measure(candidate) > maxWidth) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}
