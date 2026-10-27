import { afterEach, describe, expect, it, vi } from 'vitest'
import { rebuildPhotoBook } from './photoBooks'

describe('rebuildPhotoBook', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function stubFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return () => (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
  }

  it('sends an empty JSON object without a new narrowing, never an empty body', async () => {
    const init = stubFetch()
    await rebuildPhotoBook(7)
    expect(init().method).toBe('POST')
    expect(init().body).toBe('{}')
  })

  it('sends the new narrowing', async () => {
    const init = stubFetch()
    await rebuildPhotoBook(7, { maxPhotos: 40 })
    expect(JSON.parse(String(init().body))).toEqual({ narrowing: { maxPhotos: 40 } })
  })
})
