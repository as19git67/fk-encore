import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/vue-virtual'
import type { Virtualizer } from '@tanstack/vue-virtual'

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
 *
 * The exception: the big photo grids (gallery, a person's photos, the shared
 * album) pass a `scroller` and scroll inside it again. With tens of thousands
 * of photos the document grew millions of pixels tall, and a jump from one
 * end to the other — or a tap on the status bar — made Safari's GPU process
 * allocate past its limit (10 GB in the jetsam log) and the page crashed,
 * from about 6,000 photos on. An inner scroller does not hit that. The price
 * is the status-bar tap, which iOS only gives the document. With a scroller
 * the rows are measured against it: `scrollMargin` is their offset inside
 * it, there is no sticky stack to keep clear of, and scrolling moves it.
 */

export interface PageVirtualizerOptions {
  count: number
  rowHeight: number
  overscan?: number
}

export type RowAlign = 'start' | 'center' | 'end' | 'auto'

/** How long the page must be still before a grid loads its images again. */
export const SETTLE_MS = 150

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
  scroller?: Ref<HTMLElement | null>,
) {
  const scrollMargin = ref(0)
  const stack = ref(0)

  /** How far the grid has scrolled: the scroller's offset, else the page's. */
  function scrollTop(): number {
    return scroller ? (scroller.value?.scrollTop ?? 0) : window.scrollY
  }

  /** The height of what the scroller (or the window) shows. */
  function viewportHeight(): number {
    return scroller ? (scroller.value?.clientHeight ?? 0) : window.innerHeight
  }

  function scrollToOffset(top: number) {
    const target = scroller ? scroller.value : window
    target?.scrollTo({ top: Math.max(0, Math.round(top)), behavior: 'instant' })
  }

  function measure() {
    const el = rowsEl.value
    if (!el) return
    let top: number
    if (scroller) {
      const box = scroller.value
      if (!box) return
      top = Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop)
    } else {
      top = documentTop(el)
    }
    if (top !== scrollMargin.value) scrollMargin.value = top
    const height = scroller ? 0 : stackHeight()
    if (height !== stack.value) stack.value = height
  }

  // Whatever moves the grid down also makes the document taller, so watching
  // <body> catches a notice appearing above it as well as the stack growing.
  let observer: ResizeObserver | null = null
  // ── Flying past ────────────────────────────────────────────────────────
  // A tap on the iPhone's status bar, or a jump to the other end, moves the
  // page by more than a screen per frame through thousands of rows. Every
  // frame mounts a new set of rows, and each one used to start its
  // thumbnails: on 7,000 photos that was hundreds of decoded images in under
  // a second, enough for Safari to kill the page and reload it — which
  // looked like the gallery scrolling back to the photo it opened on. While
  // `flying` is true a grid shows its cells without images and fetches
  // nothing; it turns false once the page has been still for a moment.
  const flying = ref(false)
  let lastScrollY = 0
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  function onScroll() {
    const y = scrollTop()
    if (Math.abs(y - lastScrollY) > viewportHeight()) flying.value = true
    lastScrollY = y
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      flying.value = false
    }, SETTLE_MS)
  }

  let scrollTarget: HTMLElement | Window | null = null
  function listenTo(target: HTMLElement | Window | null) {
    if (target === scrollTarget) return
    scrollTarget?.removeEventListener('scroll', onScroll)
    scrollTarget = target
    scrollTarget?.addEventListener('scroll', onScroll, { passive: true })
    lastScrollY = scrollTop()
  }

  onMounted(() => {
    measure()
    listenTo(scroller ? scroller.value : window)
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(document.body)
      if (rowsEl.value) observer.observe(rowsEl.value)
      if (scroller?.value) observer.observe(scroller.value)
    }
    window.addEventListener('resize', measure)
  })
  if (scroller) {
    watch(scroller, (el) => {
      listenTo(el)
      if (el) observer?.observe(el)
      measure()
    }, { flush: 'post' })
  }
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
    listenTo(null)
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  })

  function rowOptions() {
    const { count, rowHeight, overscan } = options.value
    return {
      count,
      estimateSize: () => rowHeight,
      overscan: overscan ?? 4,
      scrollMargin: scrollMargin.value,
      scrollPaddingStart: stack.value,
    }
  }
  // Both kinds only ever get read (`getVirtualItems`, `getTotalSize`), so the
  // callers see one type.
  const virtualizer = (scroller
    ? useVirtualizer(computed(() => ({ ...rowOptions(), getScrollElement: () => scroller.value })))
    : useWindowVirtualizer(computed(rowOptions))) as Ref<Virtualizer<HTMLElement | Window, Element>>

  /** Where row `index` begins, in the scroller's (or the document's) coordinates. */
  function rowStart(index: number): number {
    return scrollMargin.value + index * options.value.rowHeight
  }

  /**
   * Bring row `index` into view, below the sticky stack. `center` centres it
   * in the part of the viewport the stack leaves visible; `auto` scrolls
   * only as far as needed and not at all when the row is already in view.
   *
   * One `window.scrollTo`, never the library's `scrollToIndex`: that one
   * keeps steering towards its target for up to five seconds and moves the
   * page back whenever the target shifts. On the iPhone the target shifts
   * the moment Safari's toolbar comes back, so a tap on the status bar
   * scrolled to the top and then straight back to the photo. Rows here have
   * a fixed height, so there is nothing to steer after the first jump.
   */
  function scrollToRow(index: number, align: RowAlign = 'auto') {
    measure()
    const top = rowStart(index)
    const { rowHeight } = options.value
    const height = viewportHeight()
    const visible = height - stack.value
    const start = top - stack.value
    const end = top + rowHeight - height
    let offset: number
    if (align === 'start') offset = start
    else if (align === 'end') offset = end
    else if (align === 'center') offset = start - (visible - rowHeight) / 2
    else {
      const current = scrollTop()
      if (start < current) offset = start
      else if (end > current) offset = end
      else return
    }
    scrollToOffset(offset)
  }

  /** The grid-relative offset to place a virtual row at. */
  function rowOffset(start: number): number {
    return start - scrollMargin.value
  }

  /**
   * The band of the grid's own rows that is visible right now, below the
   * sticky stack, in the grid's coordinates (0 = its first row).
   */
  function visibleBand(): { top: number; bottom: number } {
    const at = scrollTop() - scrollMargin.value
    return { top: at + stack.value, bottom: at + viewportHeight() }
  }

  return { virtualizer, scrollToRow, rowOffset, scrollMargin, measure, flying, scrollTop, viewportHeight, visibleBand }
}

