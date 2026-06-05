import { describe, it, expect } from 'vitest'
import { detailPanelEditable } from './detailPanelEditable'

describe('detailPanelEditable', () => {
  it('owner can edit when not read-only (slideshow paused)', () => {
    expect(detailPanelEditable(true, false)).toBe(true)
    expect(detailPanelEditable(true, undefined)).toBe(true)
  })

  it('read-only blocks editing even for the owner (slideshow running)', () => {
    expect(detailPanelEditable(true, true)).toBe(false)
  })

  it('non-owners can never edit', () => {
    expect(detailPanelEditable(false, false)).toBe(false)
    expect(detailPanelEditable(false, true)).toBe(false)
  })
})
