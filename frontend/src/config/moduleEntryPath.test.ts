import { describe, it, expect, beforeEach } from 'vitest'
import { moduleEntryPath, MODULE_ROUTE_KEY_PREFIX, modules } from './modules'

const dokumente = modules.find((m) => m.id === 'dokumente')!
const fotos = modules.find((m) => m.id === 'fotos')!
const admin = modules.find((m) => m.id === 'admin')!

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

  it('forgets an admin page that has moved into another module', () => {
    // Pages like the taxonomy tools left Admin and only redirect from there.
    // Restoring such an entry threw the user into Dokumente every time they
    // picked Admin from the module menu.
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'admin', '/admin/tools')
    expect(moduleEntryPath(admin)).toBe(admin.basePath)
    expect(localStorage.getItem(MODULE_ROUTE_KEY_PREFIX + 'admin')).toBeNull()
  })

  it('still restores an admin page that redirects within Admin', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'admin', '/admin/daten')
    expect(moduleEntryPath(admin)).toBe('/admin/daten')
  })

  it('keeps a remembered admin page that is still an admin page', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'admin', '/admin/rollen')
    expect(moduleEntryPath(admin)).toBe('/admin/rollen')
  })

  it('ignores a query string when deciding where a path lands', () => {
    localStorage.setItem(MODULE_ROUTE_KEY_PREFIX + 'admin', '/admin/ki-modell?tab=1')
    expect(moduleEntryPath(admin)).toBe(admin.basePath)
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
    // The strip keeps the working views; rarely used entries
    // (Kategorie-Vorschläge, Hilfe, …) live behind the Einstellungen gear.
    expect(dokumente.menuItems.map((item) => item.label)).toEqual([
      'Alle Dokumente',
      'Arbeitskorb',
      'Später',
      'Sammelmappen',
      'Steuer',
      'Einstellungen',
    ])
    expect(dokumente.menuItems.at(-1)?.children?.map((item) => item.label)).toEqual([
      'Kategorie-Vorschläge',
      'Steuer-Hints',
      'Hint-Vorschläge',
      'Korrespondenten',
      'Bezugspersonen',
      'Gruppen',
      'Verarbeitung',
      'Taxonomie-Cockpit',
      'Taxonomie-Tools',
      'KI-Modell',
      'Hilfe',
    ])
  })

  it('puts the photo admin actions behind a settings gear', () => {
    const settings = fotos.menuItems.at(-1)
    expect(settings?.label).toBe('Einstellungen')
    expect(settings?.children?.map((item) => [item.label, item.permission])).toEqual([
      ['Scan-Queue', 'data.manage'],
      ['Wartung', 'data.manage'],
      ['Externe Bibliotheken', 'photos.libraries.manage'],
      ['OSM-Regionen', 'osm.admin'],
      ['Gefahrenzone', 'photos.purge'],
    ])
  })

  it('leaves the admin module with only cross-module entries', () => {
    const admin = modules.find((m) => m.id === 'admin')!
    expect(admin.menuItems.map((item) => item.label)).toEqual([
      'Benutzer',
      'Rollen',
      'Eingeplante Jobs',
      'Systemstatus',
    ])
    // No module-specific page is left behind, so none of them can be
    // reachable without the module's own permission.
    expect(admin.menuItems.some((item) => item.children)).toBe(false)
  })
})
