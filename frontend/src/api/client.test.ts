import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from './client'

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats an empty success body as success, not as a JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(apiFetch<void>('/finance/forecast/items/1', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('still parses a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    await expect(apiFetch<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true })
  })
})
