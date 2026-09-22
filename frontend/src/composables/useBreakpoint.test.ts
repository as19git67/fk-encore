import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, nextTick, type Ref } from 'vue'
import { BREAKPOINTS, from, upTo, useAtLeast, useBelow, useMediaQuery } from './useBreakpoint'

/**
 * The pair of edges is the whole point: a width must belong to exactly one
 * side. These tests exist because the hand-written queries they replace did
 * not agree at 768px.
 */

type Listener = (event: MediaQueryListEvent) => void

/** A `matchMedia` that answers for one viewport width and can be resized. */
function fakeMatchMedia(width: number) {
  const lists: { query: string; matches: boolean; listeners: Listener[] }[] = []

  function evaluate(query: string, w: number): boolean {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    if (min && w < Number(min[1])) return false
    if (max && w > Number(max[1])) return false
    return true
  }

  const impl = vi.fn((query: string) => {
    const entry = { query, matches: evaluate(query, width), listeners: [] as Listener[] }
    lists.push(entry)
    return {
      get matches() { return entry.matches },
      addEventListener: (_: string, fn: Listener) => { entry.listeners.push(fn) },
      removeEventListener: (_: string, fn: Listener) => {
        entry.listeners = entry.listeners.filter((l) => l !== fn)
      },
    } as unknown as MediaQueryList
  })

  return {
    impl,
    resize(to: number) {
      for (const entry of lists) {
        const now = evaluate(entry.query, to)
        if (now === entry.matches) continue
        entry.matches = now
        for (const fn of entry.listeners) fn({ matches: now } as MediaQueryListEvent)
      }
    },
  }
}

function mountWith<T>(setup: () => T): { exposed: T; unmount: () => void } {
  let exposed!: T
  const app = createApp(
    defineComponent({
      setup() {
        exposed = setup()
        return () => null
      },
    }),
  )
  app.mount(document.createElement('div'))
  return { exposed, unmount: () => app.unmount() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('breakpoint queries', () => {
  it('splits every width onto exactly one side', () => {
    for (const name of Object.keys(BREAKPOINTS) as (keyof typeof BREAKPOINTS)[]) {
      const value = BREAKPOINTS[name]
      expect(from(name)).toBe(`(min-width: ${value}px)`)
      expect(upTo(name)).toBe(`(max-width: ${value - 1}px)`)
    }
  })
})

describe('useMediaQuery', () => {
  it('starts false where there is no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { exposed, unmount } = mountWith(() => useMediaQuery('(min-width: 768px)'))
    expect(exposed.value).toBe(false)
    unmount()
  })

  it('knows the width before the first render, not one frame later', () => {
    // `matchMedia` answers on the spot, so waiting for `onMounted` only ever
    // bought a first frame laid out for the wrong screen: the gallery
    // measured its grid without the sidebar it was about to get, and a phone
    // rendered the desktop branch of every `useBelow` before correcting it.
    for (const [width, wide] of [[1000, true], [390, false]] as const) {
      const media = fakeMatchMedia(width)
      vi.stubGlobal('matchMedia', media.impl)

      let duringSetup: { wide: boolean; narrow: boolean } | undefined
      const { unmount } = mountWith(() => {
        const atLeast = useAtLeast('md')
        const below = useBelow('md')
        duringSetup = { wide: atLeast.value, narrow: below.value }
        return atLeast
      })

      expect(duringSetup, `${width}px`).toEqual({ wide, narrow: !wide })
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('reads the current width on mount and follows a resize', async () => {
    const media = fakeMatchMedia(1000)
    vi.stubGlobal('matchMedia', media.impl)

    const { exposed, unmount } = mountWith(() => ({
      wide: useAtLeast('md'),
      narrow: useBelow('md'),
    })) as { exposed: { wide: Ref<boolean>; narrow: Ref<boolean> }; unmount: () => void }

    expect(exposed.wide.value).toBe(true)
    expect(exposed.narrow.value).toBe(false)

    media.resize(500)
    await nextTick()
    expect(exposed.wide.value).toBe(false)
    expect(exposed.narrow.value).toBe(true)

    unmount()
  })

  it('leaves 768px to the wide side and 767px to the narrow one', async () => {
    for (const [width, wide] of [[767, false], [768, true]] as const) {
      const media = fakeMatchMedia(width)
      vi.stubGlobal('matchMedia', media.impl)
      const { exposed, unmount } = mountWith(() => ({
        wide: useAtLeast('md'),
        narrow: useBelow('md'),
      })) as { exposed: { wide: Ref<boolean>; narrow: Ref<boolean> }; unmount: () => void }

      expect(exposed.wide.value, `${width}px`).toBe(wide)
      expect(exposed.narrow.value, `${width}px`).toBe(!wide)
      unmount()
    }
  })

  it('stops listening when the component goes away', () => {
    const media = fakeMatchMedia(1000)
    vi.stubGlobal('matchMedia', media.impl)

    const { exposed, unmount } = mountWith(() => useAtLeast('md'))
    expect(exposed.value).toBe(true)
    unmount()

    // No listener left to write into a ref nobody renders any more.
    media.resize(400)
    expect(exposed.value).toBe(true)
  })
})
