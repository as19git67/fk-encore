// Sharing library photos: what reaches the share sheet, in what order, and
// what happens on the paths where the sheet is not available or refuses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const getPhotoDetailsBatch = vi.fn()
vi.mock('../api/photos', () => ({
  getPhotoUrl: (filename: string) => `https://example.test/photos/file/${filename}?token=t`,
  getPhotoDetailsBatch: (ids: number[]) => getPhotoDetailsBatch(ids),
}))

import { sharePhotos } from './sharePhotos'

function photo(id: number, filename: string, originalName = filename) {
  return { id, filename, original_name: originalName }
}

/** Minimal fetch stub: every URL resolves to a one-byte JPEG blob. */
function okFetch(type = 'image/jpeg') {
  return vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1])], { type }),
  }))
}

let share: ReturnType<typeof vi.fn>
let canShare: ReturnType<typeof vi.fn>
let clicked: { name: string }[]

beforeEach(() => {
  clicked = []
  share = vi.fn(async () => undefined)
  canShare = vi.fn(() => true)
  vi.stubGlobal('fetch', okFetch())
  Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true })
  Object.defineProperty(navigator, 'userAgent', { value: 'Chrome/120', configurable: true })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
  })
  // Record download attempts instead of navigating the jsdom document.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ name: this.download })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  getPhotoDetailsBatch.mockReset()
})

describe('sharePhotos', () => {
  it('does nothing without photos', async () => {
    expect(await sharePhotos([])).toEqual({ shared: false, downloaded: false })
    expect(getPhotoDetailsBatch).not.toHaveBeenCalled()
  })

  it('shares a single photo through the share sheet', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg', 'Strand.jpg')] })

    expect(await sharePhotos([1])).toEqual({ shared: true, downloaded: false })

    const data = share.mock.calls[0][0]
    expect(data.title).toBe('Foto')
    expect(data.files).toHaveLength(1)
    expect(data.files[0].name).toBe('Strand.jpg')
  })

  it('keeps the requested order and drops ids the server did not return', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(2, 'b.jpg'), photo(1, 'a.jpg')] })

    await sharePhotos([1, 2, 3])

    const data = share.mock.calls[0][0]
    expect(data.files.map((f: File) => f.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(data.title).toBe('Fotos')
  })

  it('reports a cancelled share sheet as neither shared nor downloaded', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg')] })
    share.mockRejectedValue(new DOMException('cancelled', 'AbortError'))

    expect(await sharePhotos([1])).toEqual({ shared: false, downloaded: false })
    expect(clicked).toEqual([])
  })

  it('saves the photo when the platform refuses the share after the fetch', async () => {
    // iOS revokes the transient activation while the photo is downloading.
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg', 'Strand.jpg')] })
    share.mockRejectedValue(new DOMException('not allowed', 'NotAllowedError'))

    expect(await sharePhotos([1])).toEqual({ shared: false, downloaded: true })
    expect(clicked).toEqual([{ name: 'Strand.jpg' }])
  })

  it('surfaces any other share failure', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg')] })
    share.mockRejectedValue(new Error('boom'))

    await expect(sharePhotos([1])).rejects.toThrow('boom')
  })

  it('downloads when the platform cannot share files', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg'), photo(2, 'b.jpg')] })
    canShare.mockReturnValue(false)

    expect(await sharePhotos([1, 2])).toEqual({ shared: false, downloaded: true })
    expect(clicked.map(c => c.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(share).not.toHaveBeenCalled()
  })

  it('requests a JPEG for a HEIC original outside Safari and fixes the name', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.heic', 'Berg.HEIC')] })

    await sharePhotos([1])

    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain('convert=true')
    expect(share.mock.calls[0][0].files[0].name).toBe('Berg.jpg')
  })

  it('retries with conversion when the original request fails', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.heic')] })
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Version/17.0 Safari/605.1.15',
      configurable: true,
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) })
    vi.stubGlobal('fetch', fetchMock)

    await sharePhotos([1])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('convert=true')
  })

  it('fails with the photo name when it cannot be loaded at all', async () => {
    getPhotoDetailsBatch.mockResolvedValue({ photos: [photo(1, 'a.jpg', 'Strand.jpg')] })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))

    await expect(sharePhotos([1])).rejects.toThrow('Strand.jpg')
  })
})
