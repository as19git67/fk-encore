import type { LocationQuery, LocationQueryRaw, Router } from 'vue-router'

type QueryUpdater = (current: LocationQuery) => LocationQueryRaw

const pendingByRouter = new WeakMap<Router, Promise<void>>()

/**
 * Serialize query-only navigations. Vue Router updates `currentRoute` only
 * after `replace()` resolves; concurrent filter/sort writes would otherwise
 * both derive from the same stale query and the last one could resurrect
 * values removed by the first.
 */
export function updateRouteQuery(router: Router, update: QueryUpdater): Promise<void> {
  const previous = pendingByRouter.get(router) ?? Promise.resolve()
  const next = previous
    .catch(() => { /* a failed older navigation must not block newer state */ })
    .then(async () => {
      const current = router.currentRoute.value.query
      const query = update(current)
      if (JSON.stringify(query) === JSON.stringify(current)) return
      await router.replace({ query })
    })
  pendingByRouter.set(router, next)
  const cleanup = () => {
    if (pendingByRouter.get(router) === next) pendingByRouter.delete(router)
  }
  void next.then(cleanup, cleanup)
  return next
}

export function replaceQuerySlice(
  current: LocationQuery,
  ownedKeys: readonly string[],
  values: Record<string, string>,
): LocationQueryRaw {
  const next: Record<string, unknown> = { ...current }
  for (const key of ownedKeys) delete next[key]
  return { ...next, ...values } as LocationQueryRaw
}
