import { describe, it, expect, afterEach, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { stackHeight, usePageVirtualizer } from './usePageVirtualizer'

/**
 * The grids scroll with the document (issue #1674). What has to hold: rows
 * are placed relative to the grid, not the document, and a row centred by
 * the grid lands in the middle of what the sticky stack leaves visible.
 */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
  document.documentElement.style.removeProperty('--app-stack-height')
})

function mountGrid(gridTop: number) {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  let api: ReturnType<typeof usePageVirtualizer> | null = null
  const Comp = defineComponent({
    setup() {
      const rows = ref<HTMLElement | null>(null)
      api = usePageVirtualizer(rows, computed(() => ({ count: 100, rowHeight: 50 })))
      return () => h('div', { ref: rows })
    },
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  // jsdom lays nothing out: put the rows where a real page would.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: gridTop, bottom: gridTop, left: 0, right: 0, width: 0, height: 0, x: 0, y: gridTop, toJSON: () => ({}),
  } as DOMRect)
  app = createApp(Comp)
  app.mount(el)
  return api!
}

describe('usePageVirtualizer', () => {
  it('reads the sticky stack height App.vue publishes', () => {
    expect(stackHeight()).toBe(0)
    document.documentElement.style.setProperty('--app-stack-height', '120px')
    expect(stackHeight()).toBe(120)
  })

  it('places rows relative to the grid and centres below the stack', async () => {
    document.documentElement.style.setProperty('--app-stack-height', '100px')
    const api = mountGrid(300)
    await nextTick()
    expect(api.scrollMargin.value).toBe(300)
    // Row 0 begins where the grid begins, so it sits at the grid's own top.
    expect(api.rowOffset(300)).toBe(0)

    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    api.scrollToRow(20, 'center')
    // Row 20 starts at 300 + 20 * 50 = 1300. Visible band is 900 - 100 = 800
    // tall; centring the 50px row leaves 375px of it above the row.
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1300 - 100 - 375, behavior: 'instant' })
    api.scrollToRow(20, 'start')
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: 'instant' })
    api.scrollToRow(20, 'end')
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1300 + 50 - 900, behavior: 'instant' })
    vi.restoreAllMocks()
  })

  it('scrolls once and leaves the page alone afterwards', async () => {
    // The library's own scrollToIndex keeps steering for seconds and pulled
    // the page back after a tap on the iPhone's status bar.
    document.documentElement.style.setProperty('--app-stack-height', '100px')
    const api = mountGrid(300)
    await nextTick()
    const steer = vi.spyOn(api.virtualizer.value, 'scrollToIndex')
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    vi.mocked(window.scrollTo).mockClear() // the library's mount-time no-op
    api.scrollToRow(59, 'start')
    expect(steer).not.toHaveBeenCalled()
    expect(window.scrollTo).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('does not scroll when the row is already in view', async () => {
    document.documentElement.style.setProperty('--app-stack-height', '100px')
    const api = mountGrid(300)
    await nextTick()
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    // At scrollY 0 the band below the stack reaches to 900: row 0 (300–350)
    // is in it, row 20 (1300–1350) is below it.
    vi.mocked(window.scrollTo).mockClear() // the library's mount-time no-op
    api.scrollToRow(0, 'auto')
    expect(window.scrollTo).not.toHaveBeenCalled()
    api.scrollToRow(20, 'auto')
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1350 - 900, behavior: 'instant' })
    vi.restoreAllMocks()
  })
})
