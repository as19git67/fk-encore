import { describe, it, expect, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { useDocumentFilter, type UseDocumentFilterReturn } from './useDocumentFilter'
import { useModuleBack } from './useModuleBack'
import { waitForPendingQueryUpdate } from '../utils/routeQueryUpdate'
import {
  consumeListFocus,
  rememberCollectionListFocus,
} from '../utils/documentListFocus'

/**
 * Jumping from the document list into a Sammelmappe and back has to land on
 * exactly the row that was left, with the filter and the scroll position
 * intact — the same guarantee opening a document already carries.
 *
 * Two mechanics have to hold together for that, and both are exercised here
 * against a real vue-router history rather than a stub: the folder detail's
 * back arrow must go through browser history (so the list's own restore runs)
 * instead of pushing a fresh entry, and the anchor identifying the row must
 * survive the round trip. The list's filter lives in the URL, so a history
 * entry written before a pending query update has landed silently loses it —
 * the openCollection() path awaits that update for exactly this reason.
 */

function mountComposable<T>(router: Router, setup: () => T): { exposed: T; unmount: () => void } {
  let exposed!: T
  const Comp = defineComponent({
    setup() {
      exposed = setup()
      return () => null
    },
  })
  const app = createApp(Comp)
  app.use(router)
  const el = document.createElement('div')
  app.mount(el)
  return { exposed, unmount: () => app.unmount() }
}

function makeRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/dokumente', name: 'dokumente-list', component: { render: () => null } },
      { path: '/dokumente/mappen', name: 'dokumente-mappen', component: { render: () => null } },
      { path: '/dokumente/mappen/:id', name: 'dokumente-mappe', component: { render: () => null } },
      { path: '/dokumente/:id', name: 'dokumente-detail', component: { render: () => null } },
      { path: '/finanzen', name: 'finance-home', component: { render: () => null } },
    ],
  })
}

/** Wait for a `router.back()` popstate round-trip to land. */
async function waitForRoute(router: Router, name: string, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (router.currentRoute.value.name !== name) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for route "${name}", still on "${String(router.currentRoute.value.name)}"`,
      )
    }
    await new Promise((r) => setTimeout(r, 10))
    await nextTick()
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('back from a Sammelmappe returns to the document list', () => {
  it('keeps the applied filter across the round trip', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    await router.isReady()

    const list = mountComposable<UseDocumentFilterReturn>(router, () => useDocumentFilter())
    list.exposed.draft.value.category = 'steuer'
    list.exposed.apply()
    // Worst case, and the one openCollection() guards against: the user taps a
    // folder row before the fire-and-forget URL write from apply() has landed.
    await waitForPendingQueryUpdate(router)
    await router.push({ name: 'dokumente-mappe', params: { id: '7' } })

    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-mappen'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-list')

    expect(router.currentRoute.value.query.category).toBe('steuer')
  })

  it('carries the row anchor through, so the list can scroll back to it', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    await router.isReady()

    rememberCollectionListFocus(7)
    await router.push({ name: 'dokumente-mappe', params: { id: '7' } })

    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-mappen'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-list')

    expect(consumeListFocus()).toEqual({ kind: 'collection', id: 7 })
  })

  it('returns to the folder list when the folder was opened from outside the module', async () => {
    // A deep link, a reload, or arriving from Finanzen: there is no document
    // list behind this entry, so back must not leave the module.
    const router = makeRouter()
    await router.push('/finanzen')
    await router.isReady()
    await router.push({ name: 'dokumente-mappe', params: { id: '7' } })

    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-mappen'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-mappen')

    expect(router.currentRoute.value.name).toBe('dokumente-mappen')
  })

  it('returns to the document detail when the folder was opened from there', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    await router.isReady()
    await router.push({ name: 'dokumente-detail', params: { id: '123' } })
    await router.push({ name: 'dokumente-mappe', params: { id: '7' } })

    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-mappen'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-detail')

    expect(router.currentRoute.value.params.id).toBe('123')
  })
})
