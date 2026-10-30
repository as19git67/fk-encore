import { describe, expect, it } from 'vitest'
import { safeLoginRedirect } from './loginRedirect'

describe('safeLoginRedirect', () => {
  it('accepts in-app paths with params and query', () => {
    expect(safeLoginRedirect('/dokumente/42')).toBe('/dokumente/42')
    expect(safeLoginRedirect('/fotos/galerie?photoId=34')).toBe('/fotos/galerie?photoId=34')
    expect(safeLoginRedirect('/finanzen/portfolio/IE00B4L5Y983')).toBe('/finanzen/portfolio/IE00B4L5Y983')
  })

  it('rejects anything that is not a relative in-app path', () => {
    expect(safeLoginRedirect(undefined)).toBeNull()
    expect(safeLoginRedirect(42)).toBeNull()
    expect(safeLoginRedirect('')).toBeNull()
    expect(safeLoginRedirect('/')).toBeNull()
    expect(safeLoginRedirect('https://example.test/fotos')).toBeNull()
    expect(safeLoginRedirect('//example.test/fotos')).toBeNull()
    expect(safeLoginRedirect('/\\example.test')).toBeNull()
    expect(safeLoginRedirect('javascript:alert(1)')).toBeNull()
  })

  it('rejects the public auth pages so login never loops', () => {
    expect(safeLoginRedirect('/login')).toBeNull()
    expect(safeLoginRedirect('/login?redirect=%2Ffotos')).toBeNull()
    expect(safeLoginRedirect('/register/x')).toBeNull()
    expect(safeLoginRedirect('/forgot-password')).toBeNull()
    // Not an auth page, only shares the prefix letters.
    expect(safeLoginRedirect('/loginauswertung')).toBe('/loginauswertung')
  })
})
