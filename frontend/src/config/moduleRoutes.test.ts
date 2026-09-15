import { describe, it, expect } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { modules, type ModuleMenuItem } from './modules'

/**
 * The admin split moved every module-specific page into its module and left
 * redirects behind at the old /admin/* paths. Two things have to hold for
 * that to be safe: every menu entry still points at a route that exists, and
 * every old URL still lands somewhere.
 */
function buildRouter() {
  const routes: RouteRecordRaw[] = modules.map((mod) => ({
    path: mod.basePath,
    children: mod.routes,
  }))
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      ...routes,
      { path: '/data-management', redirect: '/admin/status' },
      { path: '/:pathMatch(.*)*', name: 'catch-all', component: { template: '<div />' } },
    ],
  })
}

function flatten(items: ModuleMenuItem[]): ModuleMenuItem[] {
  return items.flatMap((item) => [item, ...(item.children ?? [])])
}

describe('module routes', () => {
  const router = buildRouter()

  it('resolves every menu entry to a real route', () => {
    for (const mod of modules) {
      for (const item of flatten(mod.menuItems)) {
        if (!item.routeName) continue
        expect(
          router.hasRoute(item.routeName),
          `${mod.id} → ${item.label} (${item.routeName})`,
        ).toBe(true)
      }
    }
  })

  it.each([
    ['/admin/daten', '/admin/status'],
    ['/data-management', '/admin/status'],
    ['/admin/bibliotheken', '/fotos/einstellungen/bibliotheken'],
    ['/admin/tools', '/dokumente/taxonomie-tools'],
    ['/admin/taxonomie-cockpit', '/dokumente/taxonomie-cockpit'],
    ['/admin/ki-modell', '/dokumente/ki-modell'],
  ])('redirects the old URL %s to %s', async (from, to) => {
    await router.push(from)
    expect(router.currentRoute.value.path).toBe(to)
  })

  it('keeps the documents catch-all detail route last so siblings win', async () => {
    await router.push('/dokumente/verarbeitung')
    expect(router.currentRoute.value.name).toBe('dokumente-verarbeitung')
    await router.push('/dokumente/ki-modell')
    expect(router.currentRoute.value.name).toBe('dokumente-ki-modell')
    await router.push('/dokumente/42')
    expect(router.currentRoute.value.name).toBe('dokumente-detail')
  })
})
