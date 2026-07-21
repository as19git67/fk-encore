import type { Router } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'
import { replaceQuerySlice, updateRouteQuery, waitForPendingQueryUpdate } from './routeQueryUpdate'

describe('updateRouteQuery', () => {
  it('serializes filter removal before a following sort change', async () => {
    const currentRoute = { value: { query: { tags: 'privat,steuer', q: 'rechnung' } } }
    const router = {
      currentRoute,
      replace: vi.fn(async ({ query }) => {
        await Promise.resolve()
        currentRoute.value = { query }
      }),
    } as unknown as Router

    const removeTag = updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, ['tags'], { tags: 'steuer' }),
    )
    const changeSort = updateRouteQuery(router, (current) =>
      replaceQuerySlice(current, ['sortBy', 'sortDir'], { sortBy: 'title', sortDir: 'asc' }),
    )

    await Promise.all([removeTag, changeSort])

    expect(currentRoute.value.query).toEqual({
      tags: 'steuer',
      q: 'rechnung',
      sortBy: 'title',
      sortDir: 'asc',
    })
  })

  it('resolves immediately when nothing is pending', async () => {
    const router = { currentRoute: { value: { query: {} } } } as unknown as Router
    await expect(waitForPendingQueryUpdate(router)).resolves.toBeUndefined()
  })

  it('waits for an in-flight write — without it, a later replace() can clobber an unrelated navigation', async () => {
    const currentRoute = { value: { query: {} as Record<string, string> } }
    // A fake `replace` slow enough that a caller which doesn't await
    // updateRouteQuery's promise (e.g. a filter's fire-and-forget apply())
    // can still be in flight when something else pushes a different route.
    const router = {
      currentRoute,
      replace: vi.fn(async ({ query }) => {
        await new Promise((r) => setTimeout(r, 20))
        currentRoute.value = { query }
      }),
    } as unknown as Router

    // Mirrors filter.apply(): fired and NOT awaited by the caller.
    void updateRouteQuery(router, () => ({ category: 'steuer' }))

    // A caller that awaits waitForPendingQueryUpdate() before depending on
    // the query (e.g. DocumentsView.vue's openDocument()) sees the write
    // land before it proceeds.
    await waitForPendingQueryUpdate(router)
    expect(currentRoute.value.query).toEqual({ category: 'steuer' })
  })
})
