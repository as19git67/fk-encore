import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, defineComponent, nextTick, ref } from 'vue'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { useListSearch, useListToolbar, useListView } from './useListToolbar'
import { waitForPendingQueryUpdate } from '../utils/routeQueryUpdate'

/**
 * The toolbar contract's promise is that a list can be reproduced from its
 * URL alone (#1272, stage 3). These tests drive the real composables against
 * a real router history, the way a view does.
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
  app.mount(document.createElement('div'))
  return { exposed, unmount: () => app.unmount() }
}

function makeRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/dokumente', name: 'list', component: { render: () => null } },
      { path: '/dokumente/:id', name: 'detail', component: { render: () => null } },
    ],
  })
}

async function settle(router: Router) {
  // The URL write starts in a watcher, so let that run before awaiting it.
  await nextTick()
  await waitForPendingQueryUpdate(router)
  await nextTick()
}

describe('useListSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/dokumente')
  })

  it('writes the settled term to the URL after the debounce, not before', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen' }),
    )

    search.value.value = 'strom'
    await nextTick()
    expect(search.term.value).toBe('')
    expect(router.currentRoute.value.query.q).toBeUndefined()

    await vi.advanceTimersByTimeAsync(300)
    await settle(router)
    expect(search.term.value).toBe('strom')
    expect(router.currentRoute.value.query.q).toBe('strom')
  })

  it('keeps only the last term while the user is still typing', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen' }),
    )

    search.value.value = 'str'
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    search.value.value = 'strom'
    await nextTick()
    await vi.advanceTimersByTimeAsync(300)
    await settle(router)

    expect(search.term.value).toBe('strom')
    expect(router.currentRoute.value.query.q).toBe('strom')
  })

  it('starts from the term in the URL', async () => {
    const router = makeRouter()
    await router.push('/dokumente?q=rechnung')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen' }),
    )

    expect(search.value.value).toBe('rechnung')
    expect(search.term.value).toBe('rechnung')
  })

  it('adopts a term that arrives through back/forward', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen' }),
    )

    await router.push('/dokumente?q=police')
    await nextTick()
    expect(search.term.value).toBe('police')
    expect(search.value.value).toBe('police')
  })

  it('drops the term from the URL when cleared', async () => {
    const router = makeRouter()
    await router.push('/dokumente?q=police')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen' }),
    )

    search.clear()
    await settle(router)
    expect(search.term.value).toBe('')
    expect(router.currentRoute.value.query.q).toBeUndefined()
  })

  it('restores the last term when the list is entered without a query', async () => {
    sessionStorage.setItem('docs.search', 'versicherung')
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen', storageKey: 'docs.search' }),
    )

    expect(search.term.value).toBe('versicherung')
    await settle(router)
    // What the list shows and what the URL says must never diverge.
    expect(router.currentRoute.value.query.q).toBe('versicherung')
  })

  it('keeps the term when the user opens a row', async () => {
    const router = makeRouter()
    await router.push('/dokumente?q=police')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen', storageKey: 'docs.search' }),
    )

    // Opening a document leaves the list route; that is not "search cleared".
    await router.push('/dokumente/5')
    await nextTick()
    expect(search.term.value).toBe('police')
    expect(sessionStorage.getItem('docs.search')).toBe('police')
  })

  it('commits only on submit in manual mode', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: search } = mountComposable(router, () =>
      useListSearch({ placeholder: 'Suchen', manual: true }),
    )

    search.value.value = 'kirchen in münchen'
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(search.term.value).toBe('')

    search.submit()
    await settle(router)
    expect(search.term.value).toBe('kirchen in münchen')
    expect(router.currentRoute.value.query.q).toBe('kirchen in münchen')
  })
})

describe('useListView', () => {
  const options = [
    { value: 'list', label: 'Liste' },
    { value: 'grid', label: 'Kacheln' },
  ]

  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/dokumente')
  })

  it('keeps the default out of the URL', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: view } = mountComposable(router, () =>
      useListView({ options, defaultValue: 'list' }),
    )

    expect(view.value.value).toBe('list')
    view.value.value = 'grid'
    await settle(router)
    expect(router.currentRoute.value.query.view).toBe('grid')

    view.value.value = 'list'
    await settle(router)
    expect(router.currentRoute.value.query.view).toBeUndefined()
  })

  it('takes the view from the URL over the remembered one', async () => {
    localStorage.setItem('docs.view', 'grid')
    const router = makeRouter()
    await router.push('/dokumente?view=list')
    const { exposed: view } = mountComposable(router, () =>
      useListView({ options, defaultValue: 'list', storageKey: 'docs.view' }),
    )

    expect(view.value.value).toBe('list')
  })

  it('ignores a view the list does not have', async () => {
    const router = makeRouter()
    await router.push('/dokumente?view=hologram')
    const { exposed: view } = mountComposable(router, () =>
      useListView({ options, defaultValue: 'list' }),
    )

    expect(view.value.value).toBe('list')
  })
})

describe('useListToolbar', () => {
  it('accepts getters as well as refs for the counts', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const rows = ref(3)
    const { exposed: model } = mountComposable(router, () =>
      useListToolbar({
        result: { loaded: () => rows.value, total: () => 40, loading: () => false },
      }),
    )

    expect(model.result.loaded.value).toBe(3)
    expect(model.result.total.value).toBe(40)
    rows.value = 5
    expect(model.result.loaded.value).toBe(5)
  })

  it('follows a filter panel that stays open, and stays quiet without one', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const panelOpen = ref(false)
    const { exposed: model } = mountComposable(router, () =>
      useListToolbar({
        filter: {
          chips: () => [],
          activeCount: () => 0,
          open: () => { panelOpen.value = !panelOpen.value },
          expanded: panelOpen,
          clearAll: () => {},
        },
        result: { loaded: () => 1, loading: () => false },
      }),
    )

    expect(model.filter?.expanded?.value).toBe(false)
    panelOpen.value = true
    expect(model.filter?.expanded?.value).toBe(true)

    // A list whose filters open as a menu overlay says nothing about being
    // expanded — the overlay is its own signal.
    const { exposed: menuModel } = mountComposable(router, () =>
      useListToolbar({
        filter: { chips: () => [], activeCount: () => 0, open: () => {}, clearAll: () => {} },
        result: { loaded: () => 1, loading: () => false },
      }),
    )
    expect(menuModel.filter?.expanded).toBeUndefined()
  })

  it('reports an unknown total when none is given', async () => {
    const router = makeRouter()
    await router.push('/dokumente')
    const { exposed: model } = mountComposable(router, () =>
      useListToolbar({ result: { loaded: () => 1, loading: () => true } }),
    )

    expect(model.result.total.value).toBeUndefined()
    expect(model.result.loading.value).toBe(true)
  })
})
