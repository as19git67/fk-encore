import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useWindowVirtualizer } from '@tanstack/vue-virtual'

/**
 * A row virtualizer for a grid that scrolls with the document (issue #1674).
 *
 * The grids used to be their own scroll containers. iOS only scrolls to the
 * top on a tap on the status bar when the document itself scrolls, so now
 * every grid lays its rows out in the page and measures against `window`:
 *
 * - `scrollMargin` is the distance from the top of the document to the
 *   grid's rows, re-measured whenever something above them changes height
 *   (the title, a notice, the sticky stack). A row is placed at
 *   `row.start - scrollMargin` inside the grid.
 * - The sticky stack covers the top of the viewport, so it is the scroll
 *   padding: a row scrolled to the `start` lands right below it, and
 *   `scrollToRow(…, 'center')` centres in the part of the viewport that is
 *   actually visible.
 *
 * Rows have a fixed height in every grid here (square cell plus gap), which
 * is what lets the centre be computed without measuring.
 */

export interface PageVirtualizerOptions {
  count: number
  rowHeight: number
  overscan?: number
}

export type RowAlign = 'start' | 'center' | 'end' | 'auto'

/** The height of the app's sticky stack, as `App.vue` publishes it. */
export function stackHeight(): number {
  if (typeof document === 'undefined') return 0
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--app-stack-height')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

/** Distance from the top of the document to `el`. */
function documentTop(el: HTMLElement): number {
  return Math.round(el.getBoundingClientRect().top + window.scrollY)
}

export function usePageVirtualizer(
  rowsEl: Ref<HTMLElement | null>,
  options: Ref<PageVirtualizerOptions>,
) {
  const scrollMargin = ref(0)
  const stack = ref(0)

  function measure() {
    const el = rowsEl.value
    if (!el) return
    const top = documentTop(el)
    if (top !== scrollMargin.value) scrollMargin.value = top
    const height = stackHeight()
    if (height !== stack.value) stack.value = height
  }

  // Whatever moves the grid down also makes the document taller, so watching
  // <body> catches a notice appearing above it as well as the stack growing.
  let observer: ResizeObserver | null = null
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(document.body)
      if (rowsEl.value) observer.observe(rowsEl.value)
    }
    window.addEventListener('resize', measure)
  })
  // The rows may only appear once their data has arrived (`v-else` after a
  // spinner); measure them the moment they do.
  watch(rowsEl, (el) => {
    measure()
    if (el) observer?.observe(el)
  }, { flush: 'post' })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    window.removeEventListener('resize', measure)
  })

  const virtualizer = useWindowVirtualizer(
    computed(() => {
      const { count, rowHeight, overscan } = options.value
      return {
        count,
        estimateSize: () => rowHeight,
        overscan: overscan ?? 4,
        scrollMargin: scrollMargin.value,
        scrollPaddingStart: stack.value,
      }
    }),
  )

  /** Where row `index` begins, in document coordinates. */
  function rowStart(index: number): number {
    return scrollMargin.value + index * options.value.rowHeight
  }

  /**
   * Bring row `index` into view. `center` centres it in the part of the
   * viewport below the stack; the library's own `center` would use the whole
   * viewport and leave the row half a stack too low.
   */
  function scrollToRow(index: number, align: RowAlign = 'auto') {
    measure()
    if (align !== 'center') {
      virtualizer.value.scrollToIndex(index, { align })
      return
    }
    const visible = window.innerHeight - stack.value
    const top = rowStart(index) - stack.value - (visible - options.value.rowHeight) / 2
    virtualizer.value.scrollToOffset(Math.max(0, top))
  }

  /** The grid-relative offset to place a virtual row at. */
  function rowOffset(start: number): number {
    return start - scrollMargin.value
  }

  return { virtualizer, scrollToRow, rowOffset, scrollMargin, measure }
}

