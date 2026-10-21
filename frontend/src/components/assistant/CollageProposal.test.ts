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
vi.mock('../../api/photos', () => ({
  getPhotoUrl: (filename: string, width?: number) => `/file/${filename}?w=${width ?? ''}`,
}))

import { downloadResult, executeProposal } from '../../api/assistant'

const proposal: Proposal = {
  proposal_id: 21,
  tool: 'create_photo_collage',
  summary: 'Collage aus 3 Fotos (Spalten) mit dem Text „Sommer“ unten als neues Foto ablegen',
  count: 3,
  status: 'pending',
  result_summary: null,
  result_route: null,
  result_download: null,
  error: null,
  letter: null,
  text_document: null,
  collage: {
    photos: [
      { id: 1, filename: '2025/a.jpg', auto_crop: { x: 0.2, y: 0.3 } },
      { id: 2, filename: '2025/b.jpg', auto_crop: null },
      { id: 3, filename: '2025/c.jpg', auto_crop: null },
    ],
    layout: 'cols',
    text: 'Sommer',
    text_position: 'bottom',
    text_size: 'medium',
    text_color: '#ffffff',
    album_name: null,
    result: null,
  },
}

const RouterLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})

function mountCard(p: Proposal = proposal): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({ render: () => h(ProposalCard, { proposal: p }) })
    .use(PrimeVue)
    .directive('tooltip', {})
    .component('RouterLink', RouterLink)
    .mount(el)
  return el
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.includes(label) || x.getAttribute('aria-label') === label)
  if (!b) throw new Error(`no button ${label}`)
  return b
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.mocked(executeProposal).mockReset()
  vi.mocked(downloadResult).mockReset()
})

describe('collage proposal', () => {
  it('previews the photos in the layout with the caption at its place', () => {
    const el = mountCard()
    const cells = el.querySelectorAll('.collage-cell img')
    expect(cells).toHaveLength(3)
    expect(cells[0]!.getAttribute('src')).toBe('/file/2025/a.jpg?w=600')
    expect((cells[0] as HTMLElement).style.objectPosition).toBe('20.0% 30.0%')
    const caption = el.querySelector<HTMLElement>('.collage-caption')!
    expect(caption.textContent).toBe('Sommer')
    expect(caption.style.justifyContent).toBe('flex-end')
    expect(caption.style.alignItems).toBe('center')
    expect(button(el, 'Unten').getAttribute('aria-pressed')).toBe('true')
  })

  it('sends the layout and caption changed on the card with "Ausführen"', async () => {
    vi.mocked(executeProposal).mockResolvedValue({
      ...proposal,
      status: 'executed',
      result_summary: 'Collage aus 3 Fotos erstellt und als neues Foto abgelegt',
      result_route: '/fotos/galerie?photoId=500',
      collage: { ...proposal.collage!, layout: 'hero-left', text_position: 'top-left', result: { photo_id: 500, filename: '2025/collage.jpg' } },
    })
    const el = mountCard()

    button(el, 'Held links').click()
    button(el, 'Oben links').click()
    await flushPromises()
    expect(el.querySelector<HTMLElement>('.collage-caption')!.style.justifyContent).toBe('flex-start')

    button(el, 'Ausführen').click()
    await flushPromises()

    expect(executeProposal).toHaveBeenCalledWith(21, {
      collage: { layout: 'hero-left', text: 'Sommer', text_position: 'top-left', text_size: 'medium' },
    })
    const result = el.querySelector<HTMLImageElement>('.collage-result')!
    expect(result.getAttribute('src')).toBe('/file/2025/collage.jpg?w=1200')
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/fotos/galerie?photoId=500')

    button(el, 'Herunterladen').click()
    await flushPromises()
    expect(downloadResult).toHaveBeenCalledWith('/photos/file/2025/collage.jpg', 'collage.jpg')
  })

  it('needs a caption before its place and size can be chosen', async () => {
    const el = mountCard({ ...proposal, collage: { ...proposal.collage!, text: '' } })
    expect(el.querySelector('.collage-caption')).toBeNull()
    expect(button(el, 'Mitte').disabled).toBe(true)
  })
})
