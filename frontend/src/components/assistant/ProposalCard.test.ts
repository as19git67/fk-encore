import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import PrimeVue from 'primevue/config'
import ProposalCard from './ProposalCard.vue'
import type { Proposal } from '../../api/assistant'

vi.mock('../../api/assistant', () => ({
  executeProposal: vi.fn(),
  discardProposal: vi.fn(),
  downloadResult: vi.fn(),
}))

vi.mock('../../api/documents', () => ({ searchDocuments: vi.fn() }))

import { discardProposal, downloadResult, executeProposal } from '../../api/assistant'
import { searchDocuments } from '../../api/documents'

const pending: Proposal = {
  proposal_id: 7,
  tool: 'create_album',
  summary: 'Album „Sommer“ anlegen und 3 Fotos hinzufügen',
  count: 3,
  status: 'pending',
  result_summary: null,
  result_route: null,
  result_download: null,
  error: null,
  letter: null,
  text_document: null,
}

const letter: Proposal = {
  ...pending,
  proposal_id: 9,
  tool: 'render_letter',
  summary: 'Brief „Ihre Rechnung RE-2026-0001“ an Musterfirma GmbH, 1 Anlage, 1 Lücke zum Ausfüllen',
  letter: {
    sender: 'Erika Beispiel\nBeispielweg 2\n12345 Musterstadt',
    recipient: 'Musterfirma GmbH\nBeispielstraße 1\n12345 Musterstadt',
    subject: 'Ihre Rechnung RE-2026-0001',
    body: 'Sehr geehrte Damen und Herren,\n\nbezahlt am [[Zahlungsdatum]].',
    attachments: [{ id: 101, title: 'Rechnung Heizungswartung' }],
    destinations: ['document'],
    gaps: ['Zahlungsdatum'],
  },
}

const RouterLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})

function mountCard(proposal: Proposal = pending): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({ render: () => h(ProposalCard, { proposal }) })
    .use(PrimeVue)
    .component('RouterLink', RouterLink)
    .mount(el)
  return el
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.includes(label))
  if (!b) throw new Error(`no button ${label}`)
  return b
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0))

// The letter's auto-resizing text areas watch their size; jsdom has no observer.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

beforeEach(() => {
  vi.mocked(executeProposal).mockReset()
  vi.mocked(discardProposal).mockReset()
})

describe('ProposalCard', () => {
  it('runs the proposal only on "Ausführen" and links to the result', async () => {
    vi.mocked(executeProposal).mockResolvedValue({
      ...pending, count: null, status: 'executed', result_summary: 'Album „Sommer“ mit 3 Fotos angelegt', result_route: '/fotos/alben/4',
    })
    const el = mountCard()
    expect(el.textContent).toContain('Wartet auf Bestätigung')
    expect(executeProposal).not.toHaveBeenCalled()

    button(el, 'Ausführen').click()
    await flushPromises()

    expect(executeProposal).toHaveBeenCalledWith(7)
    expect(el.textContent).toContain('Ausgeführt')
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/fotos/alben/4')
    expect(el.querySelectorAll('button')).toHaveLength(0)
  })

  it('discards without running', async () => {
    vi.mocked(discardProposal).mockResolvedValue({ ...pending, status: 'discarded' })
    const el = mountCard()
    button(el, 'Verwerfen').click()
    await flushPromises()
    expect(discardProposal).toHaveBeenCalledWith(7)
    expect(executeProposal).not.toHaveBeenCalled()
    expect(el.textContent).toContain('Verworfen')
  })

  it('shows a failure and offers to try again', async () => {
    vi.mocked(executeProposal).mockResolvedValue({ ...pending, error: 'album name already in use' })
    const el = mountCard()
    button(el, 'Ausführen').click()
    await flushPromises()
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('album name already in use')
    expect(button(el, 'Erneut ausführen')).toBeTruthy()
  })

  it('offers the PDF of an executed report', async () => {
    vi.mocked(downloadResult).mockResolvedValue()
    const el = mountCard({
      ...pending, status: 'executed', result_summary: 'Bericht gespeichert', result_download: '/finance/reports/grouped/4/pdf',
    })
    button(el, 'PDF herunterladen').click()
    await flushPromises()
    expect(downloadResult).toHaveBeenCalledWith('/finance/reports/grouped/4/pdf')
  })

  it('lets a letter be edited, and sends it only once every gap is filled', async () => {
    vi.mocked(executeProposal).mockResolvedValue({
      ...letter, status: 'executed', result_summary: 'Brief erstellt', result_download: '/assistant/letters/3/pdf',
    })
    const el = mountCard(letter)
    expect(el.textContent).toContain('Noch auszufüllen:')
    expect(button(el, 'Ausführen').disabled).toBe(true)
    // The foot says why, and leads to the gap with its brackets selected.
    expect(el.querySelector('.proposal-wait')?.textContent).toContain('Erst die Lücke ausfüllen')
    expect(button(el, 'Ausführen').getAttribute('aria-describedby')).toBe('proposal-9-wait')
    button(el, 'Zur Lücke').click()
    await flushPromises()
    const field = el.querySelector<HTMLTextAreaElement>('#letter-9-body')!
    expect(document.activeElement).toBe(field)
    expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe('[[Zahlungsdatum]]')

    const body = el.querySelector<HTMLTextAreaElement>('#letter-9-body')!
    body.value = 'Sehr geehrte Damen und Herren,\n\nbezahlt am 20.03.2026.'
    body.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(el.textContent).not.toContain('Noch auszufüllen')
    expect(el.querySelector('.proposal-wait')).toBeNull()
    const collection = el.querySelector<HTMLInputElement>('#letter-9-dest-collection')!
    collection.click()
    await flushPromises()

    button(el, 'Ausführen').click()
    await flushPromises()
    expect(executeProposal).toHaveBeenCalledWith(9, {
      sender: letter.letter!.sender,
      recipient: letter.letter!.recipient,
      subject: 'Ihre Rechnung RE-2026-0001',
      body: 'Sehr geehrte Damen und Herren,\n\nbezahlt am 20.03.2026.',
      destinations: ['document', 'collection'],
      attachment_ids: [101],
    })
    // Afterwards: the PDF, and the text as an e-mail draft.
    expect(button(el, 'PDF herunterladen')).toBeTruthy()
    const mail = [...el.querySelectorAll('a')].find((a) => a.getAttribute('href')?.startsWith('mailto:'))
    expect(decodeURIComponent(mail!.getAttribute('href')!)).toContain('subject=Ihre Rechnung RE-2026-0001')
  })

  it('encloses a document searched on the card, also when the assistant proposed none', async () => {
    vi.mocked(searchDocuments).mockResolvedValue({
      mode: 'hybrid', query: 'Vertrag',
      items: [{ id: 205, title: 'Mitgliedsvertrag', original_filename: 'vertrag.pdf' }],
    } as unknown as Awaited<ReturnType<typeof searchDocuments>>)
    vi.mocked(executeProposal).mockResolvedValue({ ...letter, status: 'executed', result_summary: 'Brief erstellt' })
    const bare: Proposal = {
      ...letter,
      letter: { ...letter.letter!, body: 'Sehr geehrte Damen und Herren,\n\nich kündige.', attachments: [], gaps: [] },
    }
    const el = mountCard(bare)
    expect(el.textContent).toContain('Keine Anlagen.')
    expect(el.textContent).toContain('Als Dokument ablegen')
    expect(el.textContent).not.toContain('verknüpft mit den Anlagen')

    const input = el.querySelector<HTMLInputElement>('#letter-9-add-attachment')!
    input.value = 'Vertrag'
    input.dispatchEvent(new Event('input'))
    await new Promise((r) => setTimeout(r, 400))
    await flushPromises()
    expect(searchDocuments).toHaveBeenCalledWith('Vertrag', 'hybrid', 10)
    const option = [...document.querySelectorAll('li[role="option"]')].find((o) => o.textContent?.includes('Mitgliedsvertrag'))
    ;(option as HTMLElement).click()
    await flushPromises()
    expect(el.querySelector<HTMLInputElement>('#letter-9-att-205')?.checked).toBe(true)
    expect(el.textContent).toContain('verknüpft mit den Anlagen')

    button(el, 'Ausführen').click()
    await flushPromises()
    expect(vi.mocked(executeProposal).mock.calls[0]![1]!.attachment_ids).toEqual([205])
  })
})
