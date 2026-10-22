import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, RouterView, type Router } from 'vue-router'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import type { DocumentCollectionDetail, DocumentCollectionItem } from '../api/collections'

function item(document_id: number, position: number): DocumentCollectionItem {
  return {
    document_id,
    position,
    included: true,
    excluded_pages: [],
    redactions: [],
    title: `Dokument ${document_id}`,
    original_filename: `dokument-${document_id}.pdf`,
    mime_type: 'application/pdf',
    sender: null,
    doc_date: null,
    category_slug: null,
    status: 'ready',
    pages_total: 1,
    visibility: 'private',
    group_id: null,
    joined_by: 'user',
  }
}

const detail: DocumentCollectionDetail = {
  id: 5,
  title: 'Mappe',
  notes: null,
  summary: null,
  summary_stale: false,
  summary_error: null,
  summary_generated_at: null,
  include_cover: true,
  include_toc: true,
  include_summary: true,
  visibility: 'private',
  group_id: null,
  kind: 'manual',
  rule: null,
  sort_order: null,
  created_at: null,
  updated_at: null,
  item_count: 3,
  included_count: 3,
  can_administer: true,
  items: [item(11, 0), item(12, 1), item(13, 2)],
}

vi.mock('../api/collections', () => ({
  getCollection: vi.fn(async () => detail),
  getCollectionExport: vi.fn(async () => null),
  applyCollectionRule: vi.fn(),
  collectionPdfFilename: () => 'Mappe.pdf',
  fetchCollectionPdf: vi.fn(),
  startCollectionExport: vi.fn(),
  removeCollectionDocument: vi.fn(),
  reorderCollection: vi.fn(),
  updateCollection: vi.fn(),
  updateCollectionItem: vi.fn(),
}))
vi.mock('../api/documents', () => ({
  listCorrespondents: vi.fn(async () => ({ items: [] })),
  listGroups: vi.fn(async () => ({ items: [] })),
}))
vi.mock('../components/DocumentThumbnail.vue', () => ({ default: { render: () => null } }))

import DocumentCollectionDetailView from './DocumentCollectionDetailView.vue'
import { collectionAnchorKey, saveListAnchor, takeListAnchor } from '../utils/listAnchor'
import { markNavigation } from '../utils/scrollMemory'
import { STACK_TARGET_ID } from '../components/layout/pageLayout'

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dokumente', name: 'dokumente', component: { render: () => null } },
      { path: '/dokumente/mappen', name: 'dokumente-mappen', component: { render: () => null } },
      { path: '/dokumente/mappen/:id', name: 'dokumente-mappe', component: DocumentCollectionDetailView },
      { path: '/dokumente/:id', name: 'dokumente-detail', component: { render: () => null } },
    ],
  })
}

let apps: App[] = []

async function mount(router: Router): Promise<HTMLElement> {
  const app = createApp(defineComponent({ setup: () => () => h(RouterView) }))
  app.use(createPinia()).use(router).use(PrimeVue).use(ConfirmationService).directive('tooltip', Tooltip)
  await router.isReady()
  const el = document.createElement('div')
  document.body.appendChild(el)
  app.mount(el)
  apps.push(app)
  // getCollection, then the restore PageLayout runs once the page is ready.
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
  return el
}

beforeEach(() => {
  const stack = document.createElement('div')
  stack.id = STACK_TARGET_ID
  document.body.appendChild(stack)
  sessionStorage.clear()
  markNavigation(false)
  Element.prototype.scrollIntoView = vi.fn()
  // jsdom has none; PrimeVue and the page measure with it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  document.body.innerHTML = ''
})

describe('DocumentCollectionDetailView: back from a document', () => {
  it('remembers the row a document was opened from', async () => {
    const router = makeRouter()
    await router.push('/dokumente/mappen/5')
    const el = await mount(router)

    el.querySelector<HTMLButtonElement>('[data-anchor="document:12"] .cd-thumb')!.click()
    await nextTick()

    expect(takeListAnchor('dokumente-mappe-5')).toEqual({ kind: 'document', id: 12 })
  })

  it('returns to that row and focuses its thumbnail', async () => {
    const router = makeRouter()
    await router.push('/dokumente/mappen/5')
    saveListAnchor('dokumente-mappe-5', { kind: 'document', id: 12 })
    markNavigation(true)

    const el = await mount(router)

    const thumb = el.querySelector<HTMLElement>('[data-anchor="document:12"] .cd-thumb')
    expect(thumb).not.toBeNull()
    expect(document.activeElement).toBe(thumb)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('lands on the document last reached by stepping through the folder', async () => {
    // The document page moves the anchor along when it steps (prev/next in the
    // folder replaces the history entry, so Back skips straight to the folder).
    const router = makeRouter()
    await router.push('/dokumente/mappen/5')
    saveListAnchor(collectionAnchorKey(5), { kind: 'document', id: 11 })
    saveListAnchor(collectionAnchorKey(5), { kind: 'document', id: 13 })
    markNavigation(true)

    const el = await mount(router)

    expect(document.activeElement).toBe(el.querySelector('[data-anchor="document:13"] .cd-thumb'))
  })

  it('leaves another folder\'s anchor alone', async () => {
    const router = makeRouter()
    await router.push('/dokumente/mappen/5')
    saveListAnchor('dokumente-mappe-6', { kind: 'document', id: 12 })
    markNavigation(true)

    await mount(router)

    expect(document.activeElement).toBe(document.body)
    expect(takeListAnchor('dokumente-mappe-6')).toEqual({ kind: 'document', id: 12 })
  })
})
