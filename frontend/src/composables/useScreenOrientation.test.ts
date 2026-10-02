import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, nextTick, type Ref } from 'vue'
import { useScreenOrientation, type ScreenOrientation } from './useScreenOrientation'

type Listener = (event: MediaQueryListEvent) => void

/** A `matchMedia` that only knows `(orientation: portrait)` and can be turned. */
function fakeMatchMedia(portrait: boolean) {
  const listeners: Listener[] = []
  const state = { portrait }
  const impl = vi.fn((query: string) => {
    if (query !== '(orientation: portrait)') throw new Error(`unexpected query ${query}`)
    return {
      get matches() { return state.portrait },
      addEventListener: (_: string, fn: Listener) => { listeners.push(fn) },
      removeEventListener: (_: string, fn: Listener) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    } as unknown as MediaQueryList
  })
  return {
    impl,
    listeners,
    rotate(toPortrait: boolean) {
      state.portrait = toPortrait
      for (const fn of listeners) fn({ matches: toPortrait } as MediaQueryListEvent)
    },
  }
}

function mount(): { orientation: Ref<ScreenOrientation>; unmount: () => void } {
  let orientation!: Ref<ScreenOrientation>
  const app = createApp(defineComponent({
    setup() {
      orientation = useScreenOrientation()
      return () => null
    },
  }))
  app.mount(document.createElement('div'))
  return { orientation, unmount: () => app.unmount() }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useScreenOrientation', () => {
  it('reads the orientation up front and follows the screen when it turns', async () => {
    const mm = fakeMatchMedia(true)
    vi.stubGlobal('matchMedia', mm.impl)
    const { orientation, unmount } = mount()
    expect(orientation.value).toBe('portrait')

    mm.rotate(false)
    await nextTick()
    expect(orientation.value).toBe('landscape')

    unmount()
    expect(mm.listeners).toHaveLength(0)
  })

  it('answers landscape where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { orientation, unmount } = mount()
    expect(orientation.value).toBe('landscape')
    unmount()
  })
})
