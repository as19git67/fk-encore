import { describe, it, expect, vi } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { SPLIT_VIEW_MEDIA_QUERY, useSplitView, viewportTakesSplit } from './useSplitView'

function mountComposable<T>(setup: () => T): { exposed: T; unmount: () => void } {
  let exposed!: T
  const Comp = defineComponent({
    setup() {
      exposed = setup()
      return () => null
    },
  })
  const app = createApp(Comp)
  const el = document.createElement('div')
  app.mount(el)
  return { exposed, unmount: () => app.unmount() }
}

/** A matchMedia stub whose `matches` can be flipped, as a rotation would. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: initial,
    media: SPLIT_VIEW_MEDIA_QUERY,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
  }
  const matchMedia = vi.fn(() => mql as unknown as MediaQueryList)
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true })
  return {
    matchMedia,
    listenerCount: () => listeners.size,
    change(matches: boolean) {
      mql.matches = matches
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent)
    },
  }
}

describe('viewportTakesSplit', () => {
  it('takes the split on a wide landscape screen', () => {
    expect(viewportTakesSplit(1300, 800)).toBe(true)
    expect(viewportTakesSplit(1920, 1080)).toBe(true)
  })

  it('does not take it below the width threshold', () => {
    expect(viewportTakesSplit(1299, 800)).toBe(false)
  })

  it('does not take it in portrait, however wide', () => {
    // A tall narrow window that happens to clear 1300px leaves neither the
    // 600px list column nor the preview beside it enough room.
    expect(viewportTakesSplit(1400, 1600)).toBe(false)
    expect(viewportTakesSplit(1400, 1400)).toBe(false)
  })

  it('states the same rule the media query does', () => {
    expect(SPLIT_VIEW_MEDIA_QUERY).toBe('(min-width: 1300px) and (orientation: landscape)')
  })
})

describe('useSplitView', () => {
  it('reports the layout the viewport currently matches', async () => {
    stubMatchMedia(true)
    const { exposed, unmount } = mountComposable(() => useSplitView())
    await nextTick()
    expect(exposed.isSplit.value).toBe(true)
    unmount()
  })

  it('follows a resize or rotation', async () => {
    const media = stubMatchMedia(true)
    const { exposed, unmount } = mountComposable(() => useSplitView())
    await nextTick()

    // Shrinking below the threshold: the details are dismissed, per the issue.
    media.change(false)
    expect(exposed.isSplit.value).toBe(false)

    media.change(true)
    expect(exposed.isSplit.value).toBe(true)
    unmount()
  })

  it('stops listening once the view is gone', async () => {
    const media = stubMatchMedia(true)
    const { unmount } = mountComposable(() => useSplitView())
    await nextTick()
    expect(media.listenerCount()).toBe(1)
    unmount()
    expect(media.listenerCount()).toBe(0)
  })

  it('renders single-column where matchMedia does not exist', async () => {
    // Rather than throwing: an environment that cannot answer the question
    // gets the layout that works everywhere.
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true, writable: true })
    const { exposed, unmount } = mountComposable(() => useSplitView())
    await nextTick()
    expect(exposed.isSplit.value).toBe(false)
    unmount()
  })
})
