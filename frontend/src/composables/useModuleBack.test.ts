import { describe, expect, it } from 'vitest'
import { isPathInsideModule, isReturnableOrigin } from './useModuleBack'

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

describe('isReturnableOrigin', () => {
  it('goes back in history from the own module, the assistant and the Sammelmappen', () => {
    expect(isReturnableOrigin('/dokumente?tags=steuer', '/dokumente')).toBe(true)
    expect(isReturnableOrigin('/assistent?c=12', '/dokumente')).toBe(true)
    expect(isReturnableOrigin('/sammelmappen/7', '/finanzen')).toBe(true)
  })

  it('falls back to the list from another module or a cold start', () => {
    expect(isReturnableOrigin('/finanzen/transaktionen/42', '/dokumente')).toBe(false)
    expect(isReturnableOrigin(undefined, '/dokumente')).toBe(false)
  })
})
