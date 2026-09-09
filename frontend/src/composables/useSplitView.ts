import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * When a screen is wide enough to show a list and a detail side by side.
 *
 * The threshold is a media query rather than a resize listener: the browser
 * already evaluates it, and it is the same mechanism the stylesheet uses, so
 * the layout and the component that fills it can never disagree about whether
 * the split is on. Landscape is part of the condition because a 1300px-wide
 * *portrait* window is a tall narrow phone-like shape where a 600px column
 * beside a preview leaves neither enough room.
 *
 * Exported as a constant so the CSS breakpoint and the JS can be checked
 * against each other in one place — a stylesheet that split at a different
 * width than the script would render an empty pane or a missing one.
 */
export const SPLIT_VIEW_MEDIA_QUERY = '(min-width: 1300px) and (orientation: landscape)'

/**
 * Whether a viewport of this size takes the split layout. The rule the media
 * query encodes, in a form a test can state without a browser.
 */
export function viewportTakesSplit(width: number, height: number): boolean {
  return width >= 1300 && width > height
}

/**
 * Reactive "is the split layout active right now".
 *
 * Starts `false` and only turns on once mounted: server-side or test
 * environments without `matchMedia` must render the single-column layout
 * rather than throw, and a wrongly-split first paint on a narrow screen is
 * worse than a single frame of single-column on a wide one.
 */
export function useSplitView(): { isSplit: Ref<boolean> } {
  const isSplit = ref(false)
  let mql: MediaQueryList | null = null

  function apply(event: MediaQueryList | MediaQueryListEvent) {
    isSplit.value = event.matches
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    mql = window.matchMedia(SPLIT_VIEW_MEDIA_QUERY)
    apply(mql)
    mql.addEventListener('change', apply)
  })

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', apply)
    mql = null
  })

  return { isSplit }
}
