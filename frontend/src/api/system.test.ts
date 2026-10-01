import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL } from './client'
import { getBuildInfo } from './system'

describe('getBuildInfo', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks for /api/build-info on top of the base URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ build: '42-abc' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await getBuildInfo()).toEqual({ build: '42-abc' })
    const url = String((fetchMock.mock.calls[0] as unknown[])[0])
    // The endpoint path itself starts with /api (web/static.ts); the base
    // URL is the dev proxy's prefix or empty in production.
    expect(url.startsWith(`${API_BASE_URL}/api/build-info?_=`)).toBe(true)
  })

  it('reads "unbekannt" when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    expect(await getBuildInfo()).toEqual({ build: 'unbekannt' })
  })
})
