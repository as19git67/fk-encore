import { describe, it, expect, beforeEach } from 'vitest'
import { createApp, defineComponent, nextTick } from 'vue'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { useDocumentFilter, type UseDocumentFilterReturn } from './useDocumentFilter'
import { useModuleBack } from './useModuleBack'
import { waitForPendingQueryUpdate } from '../utils/routeQueryUpdate'

/**
 * Regression coverage for the report: "filter the document list, open a
 * document, hit the back arrow — the filter is gone and the list shows
 * everything again." Both DocumentsView.vue (filter) and
 * DocumentDetailView.vue's back arrow (useModuleBack) persist/restore state
 * purely through the URL query + browser history — no test previously
 * exercised the actual navigation sequence end to end, only the pure
 * `isPathInsideModule` helper (see useModuleBack.test.ts). This mounts real
 * components against a real vue-router history so the same
 * push/replace/back mechanics production hits are exercised, including the
 * case where the query-writing `router.replace()` (updateRouteQuery,
 * fire-and-forget) has not settled yet when the user clicks into a
 * document — without the `waitForPendingQueryUpdate()` guard in
 * `openDocument()`, a later-resolving replace() can silently clobber the
 * push to the detail route (see routeQueryUpdate.test.ts for the isolated
 * primitive-level reproduction).
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
      { path: '/dokumente/:id', name: 'dokumente-detail', component: { render: () => null } },
    ],
  })
}

/** Wait for a `router.back()` popstate round-trip to land. */
async function waitForRoute(router: Router, name: string, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (router.currentRoute.value.name !== name) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for route "${name}", still on "${String(router.currentRoute.value.name)}"`)
    }
    await new Promise((r) => setTimeout(r, 10))
    await nextTick()
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('document list filter survives the detail view back arrow', () => {
  it('restores the applied filter after opening a document and clicking back', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    await router.isReady()

    const list = mountComposable<UseDocumentFilterReturn>(router, () => useDocumentFilter())
    list.exposed.draft.value.category = 'steuer'
    list.exposed.apply()
    // The URL write inside apply() is async (updateRouteQuery -> router.replace);
    // let it fully settle here, mirroring a user who waits for the filtered
    // list to render before opening a document.
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(router.currentRoute.value.query.category).toBe('steuer')

    await router.push({ name: 'dokumente-detail', params: { id: '123' } })

    // Note: deliberately NOT unmounting `list` here. In the real SPA the
    // root app stays mounted for the whole session — only the routed child
    // component changes — so vue-router's "last installed app torn down"
    // teardown (which resets currentRoute to the empty START_LOCATION and
    // tears down the history listener, see vue-router's `install()`) never
    // fires. Unmounting every throwaway app in this test would trigger that
    // teardown as a test artifact and falsely "reset" the query.
    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-list'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-list')

    expect(router.currentRoute.value.query.category).toBe('steuer')
  })

  it('still restores the filter when the document is opened before the URL write settles (mirrors openDocument())', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    await router.isReady()

    const list = mountComposable<UseDocumentFilterReturn>(router, () => useDocumentFilter())
    list.exposed.draft.value.category = 'steuer'
    list.exposed.apply()
    // Worst case: the user clicks a result immediately, before the
    // fire-and-forget router.replace() from apply() has landed. Mirrors
    // DocumentsView.vue's openDocument(), which awaits this before pushing.
    await waitForPendingQueryUpdate(router)
    await router.push({ name: 'dokumente-detail', params: { id: '123' } })

    const detail = mountComposable(router, () => useModuleBack('/dokumente', 'dokumente-list'))
    detail.exposed.goBack()
    await waitForRoute(router, 'dokumente-list')

    expect(router.currentRoute.value.query.category).toBe('steuer')
  })
})
