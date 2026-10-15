import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import PrimeVue from 'primevue/config'
import ProposalCard from './ProposalCard.vue'
import type { Proposal } from '../../api/assistant'

vi.mock('../../api/assistant', () => ({
  executeProposal: vi.fn(),
  discardProposal: vi.fn(),
}))

import { discardProposal, executeProposal } from '../../api/assistant'

const pending: Proposal = {
  proposal_id: 7,
  tool: 'create_album',
  summary: 'Album „Sommer“ anlegen und 3 Fotos hinzufügen',
  count: 3,
  status: 'pending',
  result_summary: null,
  result_route: null,
  error: null,
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
})
