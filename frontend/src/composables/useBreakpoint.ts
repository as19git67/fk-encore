import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * The widths the app changes layout at (issue #1281).
 *
 * Every number is the first width of the *larger* layout, the way Tailwind
 * and Bootstrap read theirs: `md` is 768, so 767 is still a phone and 768 is
 * already not. `from()` and `upTo()` spell both edges from the same number,
 * which is the point — the pair `(max-width: 768px)` / `(min-width: 769px)`
 * that used to be written by hand disagreed with `(min-width: 768px)` on
 * exactly one width, and at 768px the page hid its "mobile-hidden" elements
 * while already using the desktop gutter.
 *
 * `sm` and `md` carry the app's two real decisions: below `sm` the toolbars
 * drop their labels, below `md` the detail views stack instead of sitting
 * side by side. `lg` and `xl` exist so a view that needs a third step does
 * not invent one.
 *
 * A component-specific threshold (a card grid that needs 560px per column)
 * stays a number in that component. These names are for the page.
 */
export const BREAKPOINTS = {
  xs: 480,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const

export type BreakpointName = keyof typeof BREAKPOINTS

/** `(min-width: …)` — this breakpoint and wider. */
export function from(name: BreakpointName): string {
  return `(min-width: ${BREAKPOINTS[name]}px)`
}

/** `(max-width: …)` — everything narrower than this breakpoint. */
export function upTo(name: BreakpointName): string {
  return `(max-width: ${BREAKPOINTS[name] - 1}px)`
}

/**
 * Whether a media query matches, kept in step with the browser.
 *
 * Read once up front, then listened to from `onMounted`. `matchMedia` answers
 * synchronously, so waiting for the mount hook only bought a first frame laid
 * out for the wrong screen: the gallery measured its virtual grid without the
 * sidebar it was about to get, and a phone rendered the desktop branch of
 * every `useBelow` before correcting itself.
 *
 * Where `matchMedia` does not exist — a server render, a jsdom test that has
 * not stubbed it — the answer is `false` rather than a thrown error, which
 * makes `useAtLeast` the narrow layout and `useBelow` the wide one.
 */
function currentlyMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(currentlyMatches(query))
  let mql: MediaQueryList | null = null

  function apply(event: MediaQueryList | MediaQueryListEvent) {
    matches.value = event.matches
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    mql = window.matchMedia(query)
    apply(mql)
    mql.addEventListener('change', apply)
  })

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', apply)
    mql = null
  })

  return matches
}

/** Whether the viewport is at this breakpoint or wider. */
export function useAtLeast(name: BreakpointName): Ref<boolean> {
  return useMediaQuery(from(name))
}

/** Whether the viewport is narrower than this breakpoint. */
export function useBelow(name: BreakpointName): Ref<boolean> {
  return useMediaQuery(upTo(name))
}
