import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import PrimeVue from 'primevue/config'
import AssistantMessage from './AssistantMessage.vue'
import type { ResultBlock } from '../../api/assistant'

vi.mock('../DocumentThumbnail.vue', () => ({ default: defineComponent({ render: () => h('span') }) }))
vi.mock('../../api/gallery', () => ({ getThumbUrl: (name: string) => `/thumb/${name}` }))

// A RouterLink that renders an anchor: the row's attributes and click land
// on it like on the real link.
const RouterLink = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup: (props, { slots, attrs }) => () => h('a', { href: '#', 'data-to': typeof props.to === 'string' ? props.to : JSON.stringify(props.to), ...attrs }, slots.default?.()),
})

function docs(tool: string, ids: number[], subtitle?: string): ResultBlock {
  return {
    kind: 'documents', tool, subtitle,
    rows: ids.map((id) => ({ id, title: `Dokument ${id}`, doc_date: '2026-01-01', from: 'Beispiel GmbH' })),
  } as ResultBlock
}

function mount(blocks: ResultBlock[], messageId?: number, content = 'Antwort'): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({ render: () => h(AssistantMessage, { role: 'assistant', content, blocks, messageId }) })
    .use(PrimeVue)
    .component('RouterLink', RouterLink)
    .mount(el)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
})

describe('AssistantMessage', () => {
  it('links an item the answer names by id to its page', () => {
    const el = mount([], undefined, 'Aus dem Dokument mit der ID 123, siehe auch **Buchung 4711**.')
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.text--rich a.entity-link')]
    expect(links.map((a) => [a.textContent, a.dataset.to])).toEqual([
      ['Dokument mit der ID 123', '/dokumente/123'],
      ['Buchung 4711', '/finanzen/umsaetze/4711'],
    ])
    expect(links[1]!.querySelector('strong')).not.toBeNull()
  })

  it('renders a table in the answer as a real table, its cells as text', async () => {
    const el = mount([], undefined, 'Stand:\n\n| Konto | Saldo |\n|---|---:|\n| Giro | 1.234,56 € |\n| <img src=x onerror=alert(1)> | 2 |')
    await nextTick()
    const table = el.querySelector('table')
    expect(table).not.toBeNull()
    expect([...table!.querySelectorAll('th')].map((c) => c.textContent?.trim())).toEqual(['Konto', 'Saldo'])
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table!.querySelector('tbody td.align-right')?.textContent?.trim()).toBe('1.234,56 €')
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('folds the earlier lists of a kind and keeps the last one open', async () => {
    const el = mount([docs('tax_documents', [1, 2, 3], 'Steuer 2025'), docs('search_documents', [2, 4]), docs('get_document_summary', [2])], 5)
    const sections = [...el.querySelectorAll('section.block')]
    expect(sections).toHaveLength(3)
    // Folded: header only, with a button to open it.
    expect(sections[0]!.querySelectorAll('a.row')).toHaveLength(0)
    expect(sections[1]!.querySelectorAll('a.row')).toHaveLength(0)
    expect(sections[2]!.querySelectorAll('a.row')).toHaveLength(1)
    expect(sections[2]!.querySelector('button[aria-label="Liste ausklappen"]')).toBeNull()

    const toggle = sections[0]!.querySelector<HTMLButtonElement>('button[aria-label="Liste ausklappen"]')
    expect(toggle).not.toBeNull()
    toggle!.click()
    await nextTick()
    expect(sections[0]!.querySelectorAll('a.row')).toHaveLength(3)
    expect(sections[0]!.querySelector('button[aria-label="Liste einklappen"]')).not.toBeNull()
  })

  it('marks each row with an anchor of its own block and remembers the one opened', () => {
    const transactions = { kind: 'transactions', tool: 'list_transactions', rows: [{ id: 2, booking_date: '2026-01-02', counterparty: 'Beispiel GmbH', amount: '-10.00' }] } as ResultBlock
    const el = mount([transactions, docs('get_document_summary', [2])], 5)
    const rows = [...el.querySelectorAll<HTMLElement>('a.row')]
    // The same id in two blocks of different kinds: two different anchors.
    expect(rows.map((r) => r.dataset.anchor)).toEqual(['transactions@m5-0:2', 'documents@m5-1:2'])
    rows[1]!.click()
    expect(JSON.parse(sessionStorage.getItem('list_anchor:assistent') ?? 'null')).toEqual({ kind: 'documents@m5-1', id: 2 })
  })

  it('gives the rows of an answer that is not stored yet no anchor', () => {
    const el = mount([docs('search_documents', [2])])
    const row = el.querySelector<HTMLElement>('a.row')!
    expect(row.dataset.anchor).toBeUndefined()
    row.click()
    expect(sessionStorage.getItem('list_anchor:assistent')).toBeNull()
  })
})

describe('AssistantMessage photos', () => {
  it('opens a photo in the gallery with the answer\'s photos as the grid', () => {
    const photos = { kind: 'photos', tool: 'search_photos', rows: [{ id: 3, filename: 'a.jpg' }, { id: 9, filename: 'b.jpg' }, { id: 27, filename: 'c.jpg' }] } as ResultBlock
    const el = mount([photos], 5)
    const links = [...el.querySelectorAll<HTMLElement>('a.photo')]
    expect(links).toHaveLength(3)
    expect(JSON.parse(links[1]!.dataset.to!)).toEqual({ name: 'fotos-gallery', query: { photoId: '9', ids: '3,9,27' } })
    expect(links[1]!.dataset.anchor).toBe('photos@m5-0:9')
  })
})

describe('AssistantMessage copy', () => {
  it('copies an answer as its text and as the rendered table', async () => {
    const written: Record<string, Blob>[] = []
    // jsdom's Blob has no text(); FileReader reads it.
    const read = (blob: Blob) => new Promise<string>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsText(blob)
    })
    class FakeItem {
      constructor(public parts: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeItem)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items: FakeItem[]) => {
          written.push(...items.map((i) => i.parts))
        },
        writeText: vi.fn(),
      },
    })
    const content = 'Stand:\n\n| Konto | Saldo |\n|---|---:|\n| Giro | 1,00 € |'
    const el = mount([], 5, content)
    await nextTick()
    const button = el.querySelector<HTMLButtonElement>('button[aria-label="Beitrag kopieren"]')
    expect(button).not.toBeNull()
    button!.click()
    await vi.waitFor(() => expect(written).toHaveLength(1))
    expect(await read(written[0]!['text/plain']!)).toBe(content)
    expect(await read(written[0]!['text/html']!)).toContain('<table')
    await nextTick()
    expect(el.querySelector('button[aria-label="Kopiert"]')).not.toBeNull()
    expect(el.querySelector('[role="status"]')?.textContent).toBe('Kopiert')
    vi.unstubAllGlobals()
  })

  it('copies the user\'s question as typed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp({ render: () => h(AssistantMessage, { role: 'user', content: 'Wie hoch war **das**?' }) }).use(PrimeVue).mount(el)
    el.querySelector<HTMLButtonElement>('button[aria-label="Beitrag kopieren"]')!.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('Wie hoch war **das**?'))
  })

  it('offers no copy while the answer is still arriving', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp({ render: () => h(AssistantMessage, { role: 'assistant', content: 'Halb', pending: true }) }).use(PrimeVue).mount(el)
    expect(el.querySelector('button[aria-label="Beitrag kopieren"]')).toBeNull()
  })

  it('says it is still thinking between two rounds, once every step is done', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp({ render: () => h(AssistantMessage, {
      role: 'assistant', content: '', pending: true,
      steps: [{ tool: 'search_photos', label: 'Fotos nach Inhalt suchen', done: true, rowCount: 12 }],
    }) }).use(PrimeVue).mount(el)
    expect(el.querySelector('.text--waiting')?.textContent).toContain('Denkt nach')
  })

  it('shows no waiting line while a step runs, the spinner on the step says it', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp({ render: () => h(AssistantMessage, {
      role: 'assistant', content: '', pending: true,
      steps: [{ tool: 'search_photos', label: 'Fotos nach Inhalt suchen', done: false }],
    }) }).use(PrimeVue).mount(el)
    expect(el.querySelector('.text--waiting')).toBeNull()
  })

  it('keeps the lists of the rounds in between back until the answer is there', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    createApp({ render: () => h(AssistantMessage, {
      role: 'assistant', content: '', pending: true, blocks: [docs('search_documents', [1, 2])],
      steps: [{ tool: 'search_documents', label: 'Dokumente durchsuchen', done: true, rowCount: 2 }],
    }) }).use(PrimeVue).component('RouterLink', RouterLink).mount(el)
    expect(el.querySelector('.blocks')).toBeNull()
    expect(mount([docs('search_documents', [1, 2])]).querySelector('.blocks')).not.toBeNull()
  })
})
