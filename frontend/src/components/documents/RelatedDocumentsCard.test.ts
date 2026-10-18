import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../DocumentThumbnail.vue', () => ({ default: { render: () => null } }))
vi.mock('../collections/AddToCollectionDialog.vue', () => ({ default: { render: () => null } }))
vi.mock('../../api/documents', () => ({
  getRelatedDocuments: vi.fn(async () => ({
    groups: [
      {
        reason: 'same_folder',
        label: 'Versicherungen',
        collection_id: null,
        items: [
          { id: 2, title: 'Police', original_filename: 'a.pdf', doc_date: null, sender: null, correspondent_display: null, document_type: null, category_slug: null, status: 'ready' },
          { id: 3, title: 'Beitrag', original_filename: 'b.pdf', doc_date: null, sender: null, correspondent_display: null, document_type: null, category_slug: null, status: 'ready' },
        ],
      },
    ],
  })),
}))

import RelatedDocumentsCard from './RelatedDocumentsCard.vue'

let app: App | null = null
afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

async function mount(): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  app = createApp({ render: () => h(RelatedDocumentsCard, { documentId: 1 }) })
  app.use(createPinia()).use(PrimeVue).use(ConfirmationService).directive('tooltip', Tooltip).mount(el)
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await nextTick()
  }
  return el
}

describe('RelatedDocumentsCard', () => {
  it('starts folded, says how many there are, and opens on a click', async () => {
    const el = await mount()
    const toggle = el.querySelector<HTMLButtonElement>('.related-toggle')!
    const body = el.querySelector<HTMLElement>('#related-body')!

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body.style.display).toBe('none')
    expect(el.querySelector('.related-count')?.textContent).toBe('2')

    toggle.click()
    await nextTick()

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body.style.display).toBe('')
    expect(el.querySelectorAll('.related-item')).toHaveLength(2)
  })
})
