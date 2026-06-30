import { describe, expect, it } from 'vitest'
import { isPathInsideModule } from './useModuleBack'

describe('isPathInsideModule', () => {
  it('accepts document list, details and queries', () => {
    expect(isPathInsideModule('/dokumente', '/dokumente')).toBe(true)
    expect(isPathInsideModule('/dokumente/42', '/dokumente')).toBe(true)
    expect(isPathInsideModule('/dokumente?tags=steuer', '/dokumente')).toBe(true)
  })

  it('rejects history entries from finance and similarly prefixed paths', () => {
    expect(isPathInsideModule('/finanzen/transaktionen/42', '/dokumente')).toBe(false)
    expect(isPathInsideModule('/dokumente-alt', '/dokumente')).toBe(false)
  })
})
