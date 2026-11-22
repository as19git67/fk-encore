/**
 * Lays out the four binder labels in the browser exactly as the server lays
 * them out for the PDF (`utils/binderLayout.ts`, the same file as
 * `label/binder-layout.ts`). Only the measuring differs: a canvas with the
 * same Roboto the PDF embeds. Until the font has loaded the layout uses
 * whatever the canvas falls back to and is redone once it is there.
 */
import { computed, onMounted, ref, type Ref } from 'vue'
import '@fontsource/roboto/latin-400.css'
import '@fontsource/roboto/latin-400-italic.css'
import '@fontsource/roboto/latin-700.css'
import '@fontsource/roboto/latin-700-italic.css'
import {
  layoutLabel,
  type BinderAlign,
  type BinderDirection,
  type LabelLayout,
  type MeasureText,
  type TextStyle,
} from '../utils/binderLayout'

export const BINDER_FONT = 'Roboto'

/** The CSS font for a style; 100 px, scaled by the caller. */
export function cssFont(style: TextStyle, size = 100): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${size}px ${BINDER_FONT}, sans-serif`
}

const STYLES: TextStyle[] = [{}, { bold: true }, { italic: true }, { bold: true, italic: true }]

/** Width measured at 100 px and scaled, so small sizes are not rounded by hinting. */
function canvasMeasure(): MeasureText {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = canvas?.getContext?.('2d') ?? null
  const cache = new Map<string, number>()
  return (text, style, size) => {
    const key = `${style.bold ? 1 : 0}${style.italic ? 1 : 0}${text}`
    let w = cache.get(key)
    if (w === undefined) {
      if (ctx) {
        ctx.font = cssFont(style)
        w = ctx.measureText(text).width
      } else {
        // No canvas (tests): an average Roboto glyph is about half an em.
        w = Array.from(text).length * 52
      }
      cache.set(key, w)
    }
    return (w * size) / 100
  }
}

export function useBinderLayout(
  labels: Ref<string[]>,
  direction: Ref<BinderDirection>,
  align: Ref<BinderAlign>,
) {
  const fontGeneration = ref(0)
  let measure: MeasureText | null = null
  let measuredFor = -1

  onMounted(async () => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts?.load) return
    try {
      await Promise.all(STYLES.map((s) => fonts.load(cssFont(s, 16), 'Steuer')))
      fontGeneration.value++
    } catch {
      /* the fallback font still gives a usable preview */
    }
  })

  const layouts = computed<LabelLayout[]>(() => {
    // A fresh measurer per font generation: widths measured before the font
    // loaded must not stay in the cache.
    if (!measure || measuredFor !== fontGeneration.value) {
      measure = canvasMeasure()
      measuredFor = fontGeneration.value
    }
    const m = measure
    return labels.value.map((md) => layoutLabel(md, direction.value, align.value, m))
  })

  return { layouts }
}
