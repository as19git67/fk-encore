import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProposal } from './assistant'

describe('executeProposal', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('always sends a JSON body, since the endpoint parses one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proposal_id: 7, status: 'executed' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await executeProposal(7)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.endsWith('/assistant/proposals/7/execute')).toBe(true)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')

    await executeProposal(7, { letter: { subject: 'Test' } } as never)
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ edits: { letter: { subject: 'Test' } } })
  })
})
