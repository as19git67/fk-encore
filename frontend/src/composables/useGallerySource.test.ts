import { beforeEach, describe, expect, it, vi } from 'vitest'

const getGalleryGrid = vi.fn()

vi.mock('../api/gallery', () => ({
  getGalleryGrid: (...args: unknown[]) => getGalleryGrid(...args),
}))

import { useGallerySource } from './useGallerySource'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const query = {
  sortBy: 'taken_at' as const,
  sortDir: 'asc' as const,
  photoIds: null,
}

describe('useGallerySource query races', () => {
  beforeEach(() => getGalleryGrid.mockReset())

  it('does not let an older filter response overwrite the latest total', async () => {
    const oldRequest = deferred<any>()
    const newRequest = deferred<any>()
    getGalleryGrid
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise)

    const source = useGallerySource()
    const oldInit = source.init({ ...query, filter: {} })
    const newInit = source.init({ ...query, filter: { hiddenMode: 'only' } })

    newRequest.resolve({
      total: 2,
      offset: 0,
      photos: [
        { id: 10, filename: 'hidden-a.jpg', curation: 'hidden' },
        { id: 11, filename: 'hidden-b.jpg', curation: 'hidden' },
      ],
    })
    await newInit
    expect(source.total.value).toBe(2)
    expect(source.entries.value.filter(Boolean)).toHaveLength(2)

    // Simulate a transport that ignored abort and delivered the old response
    // afterwards. It must not replace the hidden-only result with 97 rows.
    oldRequest.resolve({
      total: 97,
      offset: 0,
      photos: [{ id: 1, filename: 'old.jpg', curation: 'visible' }],
    })
    await oldInit
    expect(source.total.value).toBe(2)
    expect(source.entries.value).toHaveLength(2)
    expect(source.entries.value.map((entry) => entry?.id)).toEqual([10, 11])
  })
})
