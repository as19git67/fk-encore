import { describe, it, expect, beforeEach } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { allPermissions, rolePermissionsMap } from '../../../db/role-defaults'
import { landingPath, modules, type ModuleConfig, type ModuleMenuItem } from './modules'

/**
 * Each module role must open its module and everything the module offers it.
 * A user holding only "Dokumente User" and "Finance User" once landed on the
 * profile page with nothing to do, because the app's entry was hard-wired to
 * Fotos. These tests take the roles as the seed defines them, so a permission
 * renamed on one side shows up here instead of in front of a user.
 */

/** The module each role is meant to open. */
const MODULE_ROLES: Record<string, string> = {
  'Photo User': 'fotos',
  'Dokumente User': 'dokumente',
  'Finance User': 'finanzen',
  'Label User': 'label',
  'Zähler User': 'zaehler',
}

/** Every user holds the base role next to their module roles. */
function permissionsOf(...roleNames: string[]): Set<string> {
  return new Set(['User', ...roleNames].flatMap((name) => rolePermissionsMap[name] ?? []))
}

function allows(granted: Set<string>, permission: string | string[] | undefined): boolean {
  if (!permission) return true
  return (Array.isArray(permission) ? permission : [permission]).every((p) => granted.has(p))
}

function visibleModules(granted: Set<string>): ModuleConfig[] {
  return modules.filter((m) => allows(granted, m.permission))
}

function routeNamed(name: string): RouteRecordRaw | undefined {
  for (const mod of modules) {
    const route = mod.routes.find((r) => r.name === name)
    if (route) return route
  }
  return undefined
}

/** The route the module's bare path ends up on, following its redirect. */
function entryRoute(mod: ModuleConfig): RouteRecordRaw | undefined {
  const bare = mod.routes.find((r) => r.path === '')
  const redirect = bare?.redirect
  if (redirect && typeof redirect === 'object' && 'name' in redirect && typeof redirect.name === 'string') {
    return routeNamed(redirect.name)
  }
  return bare
}

/** Menu entries (with their submenu entries) the user gets to see. */
function visibleMenuItems(mod: ModuleConfig, granted: Set<string>): ModuleMenuItem[] {
  return mod.menuItems
    .filter((item) => allows(granted, item.permission))
    .flatMap((item) => [item, ...(item.children ?? []).filter((c) => allows(granted, c.permission))])
    .filter((item) => item.routeName)
}

describe('module user roles', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('grant only permissions the seed creates', () => {
    const known = new Set(allPermissions.map((p) => p.key))
    for (const [role, keys] of Object.entries(rolePermissionsMap)) {
      for (const key of keys) {
        expect(known.has(key), `${role}: ${key}`).toBe(true)
      }
    }
  })

  for (const [role, moduleId] of Object.entries(MODULE_ROLES)) {
    describe(role, () => {
      const granted = permissionsOf(role)
      const mod = modules.find((m) => m.id === moduleId)!

      it('shows its module in the main menu', () => {
        expect(mod, moduleId).toBeDefined()
        expect(visibleModules(granted).map((m) => m.id)).toContain(moduleId)
      })

      it('lands in its module, not on the profile', () => {
        expect(landingPath((p) => granted.has(p))).toBe(mod.basePath)
      })

      it('may open the page the module starts on', () => {
        const entry = entryRoute(mod)
        expect(entry, `${moduleId} has no entry route`).toBeDefined()
        expect(allows(granted, entry!.meta?.permission as string | string[] | undefined)).toBe(true)
      })

      it('shows menu entries, and each one opens without a redirect', () => {
        const items = visibleMenuItems(mod, granted)
        expect(items.length).toBeGreaterThan(0)
        for (const item of items) {
          const route = routeNamed(item.routeName!)
          expect(route, `${item.label}: no route ${item.routeName}`).toBeDefined()
          expect(
            allows(granted, route!.meta?.permission as string | string[] | undefined),
            `${role} sees "${item.label}" but may not open it`,
          ).toBe(true)
        }
      })
    })
  }

  it('give Dokumente and Finanzen together, landing in Dokumente', () => {
    const granted = permissionsOf('Dokumente User', 'Finance User')
    const visible = visibleModules(granted).map((m) => m.id)
    expect(visible).toEqual(expect.arrayContaining(['dokumente', 'finanzen']))
    expect(visible).not.toContain('fotos')
    expect(landingPath((p) => granted.has(p))).toBe('/dokumente')
  })

  it('grant the assistant only through its own role (#1648)', () => {
    for (const role of Object.keys(MODULE_ROLES)) {
      expect(permissionsOf(role).has('module.assistant'), role).toBe(false)
    }
    const granted = permissionsOf('Finance User', 'Assistent User')
    expect(visibleModules(granted).map((m) => m.id)).toEqual(expect.arrayContaining(['finanzen', 'assistent']))
    expect(landingPath((p) => granted.has(p))).toBe('/finanzen')
    const alone = permissionsOf('Assistent User')
    expect(landingPath((p) => alone.has(p))).toBe('/assistent')
  })

  it('leave a user without a module role on the profile', () => {
    const granted = permissionsOf()
    expect(visibleModules(granted)).toHaveLength(0)
    expect(landingPath((p) => granted.has(p))).toBe('/profile')
  })
})
