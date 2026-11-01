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

/** A WebSocket the test drives: it opens, delivers frames and drops on command. */
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  static failToOpen = false
  url: string
  constructor(url: string) {
    super()
    this.url = url
    FakeSocket.all.push(this)
    setTimeout(() => this.dispatchEvent(new Event(FakeSocket.failToOpen ? 'error' : 'open')), 0)
  }
  deliver(event: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  drop() {
    this.dispatchEvent(new Event('close'))
  }
  close() { /* the client closing */ }
}

describe('askStreaming', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeSocket.all = []
    FakeSocket.failToOpen = false
  })

  function stubFetch() {
    const fetchMock = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.endsWith('/ask') ? { answer: 'Gewartet.', blocks: [], message_id: 9, rounds: 1 } : { turnId: 't-12345678' }),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeSocket)
    return fetchMock
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  }

  it('starts the turn without waiting for it and takes the answer from the stream', async () => {
    const fetchMock = stubFetch()
    const { askStreaming } = await import('./assistant')
    const seen: string[] = []
    const answer = askStreaming(3, 'Frage', 't-12345678', (e) => seen.push(e.type))
    await until(() => fetchMock.mock.calls.length === 1)
    expect(String(fetchMock.mock.calls[0]![0]).endsWith('/assistant/conversations/3/turns')).toBe(true)

    const socket = FakeSocket.all[0]!
    socket.deliver({ type: 'ping' })
    socket.deliver({ type: 'token', text: 'Fer' })
    socket.deliver({ type: 'done', answer: 'Fertig.', blocks: [], message_id: 42, rounds: 2 })
    await expect(answer).resolves.toMatchObject({ answer: 'Fertig.', message_id: 42, rounds: 2 })
    expect(seen).toEqual(['token', 'done'])
  })

  it('reconnects a dropped socket and skips what the replay repeats', async () => {
    const fetchMock = stubFetch()
    const { askStreaming } = await import('./assistant')
    const seen: string[] = []
    const answer = askStreaming(3, 'Frage', 't-12345678', (e) => seen.push(e.type))
    await until(() => fetchMock.mock.calls.length === 1)
    await new Promise((r) => setTimeout(r, 0))

    FakeSocket.all[0]!.deliver({ type: 'tool_start', tool: 'list_photos' })
    FakeSocket.all[0]!.drop()
    await until(() => FakeSocket.all.length === 2)
    const second = FakeSocket.all[1]!
    expect(second.url).toContain('resume=true')
    await new Promise((r) => setTimeout(r, 0))
    second.deliver({ type: 'tool_start', tool: 'list_photos' })
    second.deliver({ type: 'tool_result', tool: 'list_photos', row_count: 5 })
    second.deliver({ type: 'done', answer: 'Fünf Fotos.', blocks: [], message_id: 43, rounds: 2 })
    await expect(answer).resolves.toMatchObject({ message_id: 43 })
    expect(seen).toEqual(['tool_start', 'tool_result', 'done'])
  })

  it('reports a turn the server no longer knows as lost', async () => {
    const fetchMock = stubFetch()
    const { askStreaming, TURN_LOST } = await import('./assistant')
    const answer = askStreaming(3, 'Frage', 't-12345678', () => {})
    await until(() => fetchMock.mock.calls.length === 1)
    await new Promise((r) => setTimeout(r, 0))
    FakeSocket.all[0]!.drop()
    await until(() => FakeSocket.all.length === 2)
    await new Promise((r) => setTimeout(r, 0))
    FakeSocket.all[1]!.deliver({ type: 'error', message: 'turn unknown', code: 'not_found' })
    await expect(answer).rejects.toMatchObject({ code: TURN_LOST })
  })

  it('falls back to the waiting ask when no socket opens', async () => {
    FakeSocket.failToOpen = true
    const fetchMock = stubFetch()
    const { askStreaming } = await import('./assistant')
    await expect(askStreaming(3, 'Frage', 't-12345678', () => {})).resolves.toMatchObject({ answer: 'Gewartet.' })
    expect(String(fetchMock.mock.calls[0]![0]).endsWith('/assistant/conversations/3/ask')).toBe(true)
  })
})
