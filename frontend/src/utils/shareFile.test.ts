import { afterEach, describe, expect, it, vi } from 'vitest'
import { canShareFiles, shareFile, triggerDownload } from './shareFile'

const file = () => new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' })

afterEach(() => {
  vi.restoreAllMocks()
  // Remove any stubbed share APIs between tests.
  delete (navigator as Record<string, unknown>).canShare
  delete (navigator as Record<string, unknown>).share
})

function stubShare(canShare: boolean, share?: () => Promise<void>) {
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: () => canShare,
  })
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: share ?? (() => Promise.resolve()),
  })
}

describe('canShareFiles', () => {
  it('is false when the Web Share API is absent', () => {
    expect(canShareFiles()).toBe(false)
  })

  it('is true when canShare accepts files', () => {
    stubShare(true)
    expect(canShareFiles()).toBe(true)
  })

  it('is false when canShare rejects files', () => {
    stubShare(false)
    expect(canShareFiles()).toBe(false)
  })
})

describe('triggerDownload', () => {
  it('synthesizes an <a download> click', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    triggerDownload('https://example.test/x.mp4', 'clip.mp4')
    expect(click).toHaveBeenCalledOnce()
  })
})

describe('shareFile', () => {
  it('uses the native share sheet when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubShare(true, share)
    const used = await shareFile(file(), 'https://example.test/x.mp4')
    expect(used).toBe(true)
    expect(share).toHaveBeenCalledOnce()
  })

  it('does not download when the user cancels the share', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    stubShare(true, () => Promise.reject(abort))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const used = await shareFile(file(), 'https://example.test/x.mp4')
    expect(used).toBe(true)
    expect(click).not.toHaveBeenCalled()
  })

  it('falls back to a download when sharing is unsupported', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const used = await shareFile(file(), 'https://example.test/x.mp4')
    expect(used).toBe(false)
    expect(click).toHaveBeenCalledOnce()
  })
})
