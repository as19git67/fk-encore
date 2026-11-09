import { describe, expect, it } from 'vitest'
import { NAVBAR_SUBMENU_GAP, submenuFitsNavbar } from './navbarLayout'

describe('submenuFitsNavbar', () => {
  it('fits when the menu and both ends leave room for the gaps', () => {
    expect(submenuFitsNavbar({ navbar: 1500, start: 120, end: 200, content: 900 })).toBe(true)
  })

  it('fits exactly at the edge', () => {
    const content = 1000 - 100 - 100 - 2 * NAVBAR_SUBMENU_GAP
    expect(submenuFitsNavbar({ navbar: 1000, start: 100, end: 100, content })).toBe(true)
    expect(submenuFitsNavbar({ navbar: 1000, start: 100, end: 100, content: content + 1 })).toBe(false)
  })

  it('keeps a long menu on its own row', () => {
    expect(submenuFitsNavbar({ navbar: 1280, start: 120, end: 200, content: 1100 })).toBe(false)
  })

  it('never moves an unmeasured menu', () => {
    expect(submenuFitsNavbar({ navbar: 1500, start: 0, end: 0, content: 0 })).toBe(false)
    expect(submenuFitsNavbar({ navbar: 0, start: 0, end: 0, content: 100 })).toBe(false)
  })
})
