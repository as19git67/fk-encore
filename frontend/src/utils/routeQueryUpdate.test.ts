import type { Router } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'
import { replaceQuerySlice, updateRouteQuery } from './routeQueryUpdate'

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
})
