import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createRouter, createMemoryHistory, RouterView, type Router } from 'vue-router'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import Tooltip from 'primevue/tooltip'
import type { CollectionSummary } from '../api/collections'

function folder(id: number, over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id,
    name: `Mappe ${id}`,
    description: null,
    entity_type: 'document',
    kind: 'manual',
    visibility: 'private',
    group_id: null,
    archived_at: null,
    created_by: 'user',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    favourite: false,
    last_opened_at: null,
    counts: { document: 1 },
    total: 1,
    can_administer: true,
    rule: null,
    ...over,
  }
}

vi.mock('../api/collections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/collections')>()),
  listAllCollections: vi.fn(async () => ({
    items: [
      folder(1),
      folder(2),
      folder(3),
      // Not a folder for documents: photos only, and the basket.
      folder(4, { entity_type: 'photo', counts: { photo: 2 } }),
      folder(5, { kind: 'basket' }),
      // A mixed folder may hold documents and stays.
      folder(6, { entity_type: null }),
    ],
  })),
  markCollectionOpened: vi.fn(async () => undefined),
  createCollection: vi.fn(),
}))

import DocumentCollectionsView from './DocumentCollectionsView.vue'
import { saveListAnchor } from '../utils/listAnchor'
import { markNavigation } from '../utils/scrollMemory'
import { STACK_TARGET_ID } from '../components/layout/pageLayout'

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dokumente/mappen', name: 'dokumente-mappen', component: DocumentCollectionsView },
      { path: '/dokumente/mappen/:id', name: 'dokumente-mappe', component: { render: () => null } },
    ],
  })
}

let apps: App[] = []

beforeEach(() => {
  const stack = document.createElement('div')
  stack.id = STACK_TARGET_ID
  document.body.appendChild(stack)
  sessionStorage.clear()
  localStorage.clear()
  markNavigation(false)
  Element.prototype.scrollIntoView = vi.fn()
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
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
})

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  document.body.innerHTML = ''
})

describe('DocumentCollectionsView: back from a Sammelmappe', () => {
  it('returns to the folder it was opened from, once the list has loaded', async () => {
    const router = makeRouter()
    await router.push('/dokumente/mappen')
    saveListAnchor('dokumente-mappen', { kind: 'collection', id: 2 })
    markNavigation(true)

    const app = createApp(defineComponent({ setup: () => () => h(RouterView) }))
    app.use(createPinia()).use(router).use(PrimeVue).use(ConfirmationService).directive('tooltip', Tooltip)
    await router.isReady()
    const el = document.createElement('div')
    document.body.appendChild(el)
    app.mount(el)
    apps.push(app)
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
      await nextTick()
    }

    const row = el.querySelector('[data-anchor="collection:2"]')
    expect(row).not.toBeNull()
    expect(row!.contains(document.activeElement)).toBe(true)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('shows the folders that can hold documents as the shared tiles', async () => {
    const router = makeRouter()
    await router.push('/dokumente/mappen')
    const app = createApp(defineComponent({ setup: () => () => h(RouterView) }))
    app.use(createPinia()).use(router).use(PrimeVue).use(ConfirmationService).directive('tooltip', Tooltip)
    await router.isReady()
    const el = document.createElement('div')
    document.body.appendChild(el)
    app.mount(el)
    apps.push(app)
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
      await nextTick()
    }

    const ids = [...el.querySelectorAll('.collection-tile')].map((t) => t.getAttribute('data-anchor'))
    expect(ids).toEqual(['collection:1', 'collection:2', 'collection:3', 'collection:6'])
    // Star and menu, as on the Sammelmappen page.
    expect(el.querySelector('[aria-label="Als Favorit markieren: Mappe 1"]')).not.toBeNull()
    expect(el.querySelector('[aria-label="Weitere Aktionen: Mappe 1"]')).not.toBeNull()
  })
})
