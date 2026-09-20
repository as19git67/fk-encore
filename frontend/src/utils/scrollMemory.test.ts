import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearPageScroller,
  clearScrollOffset,
  currentScrollTop,
  markNavigation,
  navigatedFromHistory,
  readScrollOffset,
  saveScrollOffset,
  scrollToTop,
  setPageScroller,
} from './scrollMemory'

function fakeScroller(top: number) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true })
  el.scrollTo = vi.fn() as unknown as typeof el.scrollTo
  return el
}

describe('scrollMemory', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setPageScroller(null)
    markNavigation(false)
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  })

  it('remembers an offset per route key', () => {
    saveScrollOffset('/dokumente?q=rechnung', 320)
    saveScrollOffset('/dokumente', 40)
    expect(readScrollOffset('/dokumente?q=rechnung')).toBe(320)
    expect(readScrollOffset('/dokumente')).toBe(40)
    expect(readScrollOffset('/fotos/alben')).toBeNull()
  })

  it('does not store the top of the page', () => {
    saveScrollOffset('/dokumente', 100)
    // Leaving a list the user scrolled back to the top must not restore 100.
    saveScrollOffset('/dokumente', 0)
    expect(readScrollOffset('/dokumente')).toBeNull()
  })

  it('forgets an offset on request', () => {
    saveScrollOffset('/dokumente', 100)
    clearScrollOffset('/dokumente')
    expect(readScrollOffset('/dokumente')).toBeNull()
  })

  it('reads the page’s own scroller when one is registered', () => {
    const el = fakeScroller(250)
    const getter = () => el
    setPageScroller(getter)
    expect(currentScrollTop()).toBe(250)
    scrollToTop(120)
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'instant' })

    clearPageScroller(getter)
    expect(currentScrollTop()).toBe(Math.round(window.scrollY))
  })

  it('keeps the newer registration when an old page unregisters late', () => {
    const first = () => fakeScroller(10)
    const second = fakeScroller(99)
    setPageScroller(first)
    setPageScroller(() => second)
    // The page that left tidies up after the new one registered.
    clearPageScroller(first)
    expect(currentScrollTop()).toBe(99)
  })

  it('tells a restore whether the user came back or picked the page fresh', () => {
    markNavigation(true)
    expect(navigatedFromHistory()).toBe(true)
    markNavigation(false)
    expect(navigatedFromHistory()).toBe(false)
  })
})
