import { computed, type Ref } from 'vue'
import { useMediaQuery } from './useBreakpoint'

export type ScreenOrientation = 'portrait' | 'landscape'

/**
 * Which way the screen is turned right now (.claude/plans/orientierungs-varianten.md).
 *
 * One composable for the whole app: the gallery grid, the fullscreen viewer
 * and the slideshow all ask the same question and must get the same answer,
 * so none of them reads `matchMedia` on its own. Built on `useMediaQuery`,
 * which keeps the value in step with the browser and cleans up its listener.
 *
 * `(orientation: portrait)` is true while the viewport is at least as tall
 * as it is wide; a square window counts as portrait, the same way CSS sees
 * it. Where `matchMedia` is missing (a server render, a bare jsdom) the
 * answer is `landscape` — the layout every desktop starts from.
 */
export function useScreenOrientation(): Ref<ScreenOrientation> {
  const portrait = useMediaQuery('(orientation: portrait)')
  return computed(() => (portrait.value ? 'portrait' : 'landscape'))
}
