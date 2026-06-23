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
}

/** A fresh, centred, medium overlay with no text. */
export function defaultTextOverlay(): CollageTextOverlay {
  return { text: '', x: 0.5, y: 0.5, fontKey: 'medium', align: 'center' }
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
