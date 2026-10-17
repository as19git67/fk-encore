import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import PrimeVue from 'primevue/config'
import AssistantMessage from './AssistantMessage.vue'
import type { ResultBlock } from '../../api/assistant'

vi.mock('../DocumentThumbnail.vue', () => ({ default: defineComponent({ render: () => h('span') }) }))

// A RouterLink that renders an anchor: the row's attributes and click land
// on it like on the real link.
const RouterLink = defineComponent({
  props: { to: { type: [String, Object], required: true } },
  setup: (_props, { slots, attrs }) => () => h('a', { href: '#', ...attrs }, slots.default?.()),
})

function docs(tool: string, ids: number[], subtitle?: string): ResultBlock {
  return {
    kind: 'documents', tool, subtitle,
    rows: ids.map((id) => ({ id, title: `Dokument ${id}`, doc_date: '2026-01-01', from: 'Beispiel GmbH' })),
  } as ResultBlock
}

function mount(blocks: ResultBlock[], messageId?: number): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({ render: () => h(AssistantMessage, { role: 'assistant', content: 'Antwort', blocks, messageId }) })
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
