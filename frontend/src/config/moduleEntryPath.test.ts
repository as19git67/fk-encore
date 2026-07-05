import { describe, it, expect, beforeEach } from 'vitest'
import { moduleEntryPath, MODULE_ROUTE_KEY_PREFIX, modules } from './modules'

const dokumente = modules.find((m) => m.id === 'dokumente')!
const fotos = modules.find((m) => m.id === 'fotos')!

describe('moduleEntryPath', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to the module base path when nothing is stored', () => {
    expect(moduleEntryPath(dokumente)).toBe(dokumente.basePath)
  })

  it('restores the last route opened within the module', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'dokumente', '/dokumente/steuer')
    expect(moduleEntryPath(dokumente)).toBe('/dokumente/steuer')
  })

  it('restores a deep detail route within the module', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'dokumente', '/dokumente/42')
    expect(moduleEntryPath(dokumente)).toBe('/dokumente/42')
  })

  it('ignores a stored path that belongs to a different module', () => {
    // A stale entry pointing outside the module must not leak across.
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'dokumente', '/fotos/galerie')
    expect(moduleEntryPath(dokumente)).toBe(dokumente.basePath)
  })

  it('ignores non-app / public paths', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'fotos', '/login')
    expect(moduleEntryPath(fotos)).toBe(fotos.basePath)
  })

  it('keeps separate memory per module', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'dokumente', '/dokumente/gruppen')
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'fotos', '/fotos/alben')
    expect(moduleEntryPath(dokumente)).toBe('/dokumente/gruppen')
    expect(moduleEntryPath(fotos)).toBe('/fotos/alben')
  })

  it('exposes document navigation as the active-module submenu', () => {
    // The strip keeps the four working views; rarely used entries
    // (Kategorie-Vorschläge, Hilfe, …) live behind the Einstellungen gear.
    expect(dokumente.menuItems.map((item) => item.label)).toEqual([
      'Alle Dokumente',
      'Arbeitskorb',
      'Später',
      'Steuer',
      'Einstellungen',
    ])
    expect(dokumente.menuItems.at(-1)?.children?.map((item) => item.label)).toEqual([
      'Kategorie-Vorschläge',
      'Steuer-Hints',
      'Hint-Vorschläge',
      'Bezugspersonen',
      'Gruppen',
      'Hilfe',
    ])
  })
})
