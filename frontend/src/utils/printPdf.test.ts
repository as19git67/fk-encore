import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIosLike, printPdfBlob } from './printPdf'

function nav(userAgent: string, platform = '', maxTouchPoints = 0): Navigator {
  return { userAgent, platform, maxTouchPoints } as Navigator
}

describe('isIosLike', () => {
  it('knows iPhone and iPad by their user agent', () => {
    expect(isIosLike(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'))).toBe(true)
    expect(isIosLike(nav('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'))).toBe(true)
  })

  it('knows iPadOS, which reports a Mac with touch', () => {
    expect(isIosLike(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5))).toBe(true)
  })

  it('leaves desktop browsers alone', () => {
    expect(isIosLike(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0))).toBe(false)
    expect(isIosLike(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0))).toBe(false)
  })
})

describe('printPdfBlob', () => {
  afterEach(() => {
    // Lets the module drop the frame it keeps from the test before.
    vi.advanceTimersByTime(10 * 60 * 1000)
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.querySelectorAll('iframe').forEach((f) => f.remove())
  })

  function stubUrls() {
    let n = 0
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { created.push(b as Blob); return `blob:test/${++n}` })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { created, revoke }
  }

  async function loadAndPrint(blob: Blob) {
    const promise = printPdfBlob(blob)
    const frame = document.querySelector('iframe')!
    const print = vi.fn()
    const focus = vi.fn()
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { print, focus } })
    frame.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(100)
    await promise
    return { frame, print, focus }
  }

  it('prints the PDF from a frame out of sight, not the page', async () => {
    vi.useFakeTimers()
    stubUrls()
    const { frame, print, focus } = await loadAndPrint(new Blob(['%PDF'], { type: 'application/pdf' }))
    expect(frame.getAttribute('src')).toBe('blob:test/1')
    expect(frame.getAttribute('aria-hidden')).toBe('true')
    expect(frame.style.display).not.toBe('none')
    expect(focus).toHaveBeenCalled()
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('gives an untyped blob the PDF type', async () => {
    vi.useFakeTimers()
    const { created } = stubUrls()
    await loadAndPrint(new Blob(['%PDF']))
    expect(created[0].type).toBe('application/pdf')
  })

  it('keeps the frame while the dialog is open and drops it with the next print', async () => {
    vi.useFakeTimers()
    const { revoke } = stubUrls()
    const first = await loadAndPrint(new Blob(['%PDF'], { type: 'application/pdf' }))
    expect(first.frame.isConnected).toBe(true)
    expect(revoke).not.toHaveBeenCalled()
    await loadAndPrint(new Blob(['%PDF'], { type: 'application/pdf' }))
    expect(first.frame.isConnected).toBe(false)
    expect(revoke).toHaveBeenCalledWith('blob:test/1')
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('cleans up after ten minutes', async () => {
    vi.useFakeTimers()
    const { revoke } = stubUrls()
    const { frame } = await loadAndPrint(new Blob(['%PDF'], { type: 'application/pdf' }))
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(frame.isConnected).toBe(false)
    expect(revoke).toHaveBeenCalledWith('blob:test/1')
  })
})
