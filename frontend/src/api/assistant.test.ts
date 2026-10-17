import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeProposal, getTaxWorksheet, storeTaxWorksheetPdf } from './assistant'

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

describe('tax worksheet', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the worksheet of a year and a Steuerakte, and stores its PDF', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ year: 2025 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await getTaxWorksheet(2025)
    await getTaxWorksheet(2025, 4)
    await storeTaxWorksheetPdf(2025)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0]![0].endsWith('/assistant/tax-worksheet?year=2025')).toBe(true)
    expect(calls[1]![0].endsWith('/assistant/tax-worksheet?year=2025&person_id=4')).toBe(true)
    expect(calls[2]![0].endsWith('/assistant/tax-worksheet/pdf')).toBe(true)
    expect(calls[2]![1].body).toBe('{"year":2025}')
  })
})
