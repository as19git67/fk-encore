import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearScrollOffset,
  currentScrollTop,
  markNavigation,
  navigatedFromHistory,
  readScrollOffset,
  saveScrollOffset,
  scrollToTop,
} from './scrollMemory'

describe('scrollMemory', () => {
  beforeEach(() => {
    sessionStorage.clear()
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

  it('reads and sets the document’s offset', () => {
    // The document is the only scroller (issue #1674).
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true })
    expect(currentScrollTop()).toBe(250)
    scrollToTop(120)
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'instant' })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  })

  it('tells a restore whether the user came back or picked the page fresh', () => {
    markNavigation(true)
    expect(navigatedFromHistory()).toBe(true)
    markNavigation(false)
    expect(navigatedFromHistory()).toBe(false)
  })
})
