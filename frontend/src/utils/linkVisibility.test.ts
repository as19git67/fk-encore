// The tri-state setting as the UI reasons about it: what a link visitor sees,
// and what one click on the toggle should store.

import { describe, it, expect } from 'vitest'
import {
  isVisibleViaLink,
  nextLinkVisibility,
  linkVisibilityIcon,
  linkVisibilityTooltip,
} from './linkVisibility'

describe('isVisibleViaLink', () => {
  it('withholds a photo with a known face by default', () => {
    expect(isVisibleViaLink({ link_visibility: 'auto', has_known_face: true })).toBe(false)
  })

  it('shows a photo without a known face by default', () => {
    expect(isVisibleViaLink({ link_visibility: 'auto', has_known_face: false })).toBe(true)
  })

  it('treats a missing setting as the default', () => {
    expect(isVisibleViaLink({})).toBe(true)
    expect(isVisibleViaLink({ has_known_face: true })).toBe(false)
  })

  it('honours both explicit values over the face', () => {
    expect(isVisibleViaLink({ link_visibility: 'visible', has_known_face: true })).toBe(true)
    expect(isVisibleViaLink({ link_visibility: 'hidden', has_known_face: false })).toBe(false)
  })
})

describe('nextLinkVisibility', () => {
  it('releases a photo the default withholds', () => {
    expect(nextLinkVisibility({ link_visibility: 'auto', has_known_face: true })).toBe('visible')
  })

  it('returns a released photo to the default rather than pinning it shut', () => {
    expect(nextLinkVisibility({ link_visibility: 'visible', has_known_face: true })).toBe('auto')
  })

  it('withholds a shown photo explicitly when no face would do it', () => {
    expect(nextLinkVisibility({ link_visibility: 'auto', has_known_face: false })).toBe('hidden')
  })

  it('releases a photo that was withheld explicitly', () => {
    expect(nextLinkVisibility({ link_visibility: 'hidden', has_known_face: false })).toBe('visible')
  })

  it('round-trips in both directions', () => {
    const withFace = { link_visibility: 'auto' as const, has_known_face: true }
    const released = { ...withFace, link_visibility: nextLinkVisibility(withFace) }
    expect(released.link_visibility).toBe('visible')
    expect(nextLinkVisibility(released)).toBe('auto')

    const plain = { link_visibility: 'auto' as const, has_known_face: false }
    const withheld = { ...plain, link_visibility: nextLinkVisibility(plain) }
    expect(withheld.link_visibility).toBe('hidden')
    expect(nextLinkVisibility(withheld)).toBe('visible')
  })
})

describe('linkVisibilityIcon', () => {
  it('uses the plain link when a visitor sees the photo', () => {
    expect(linkVisibilityIcon({ link_visibility: 'visible', has_known_face: true })).toBe('pi pi-link')
  })

  it('uses the struck-out link when the photo is withheld', () => {
    expect(linkVisibilityIcon({ link_visibility: 'auto', has_known_face: true })).toBe('pi pi-link-slash')
    expect(linkVisibilityIcon({ link_visibility: 'hidden', has_known_face: false })).toBe('pi pi-link-slash')
  })
})

describe('linkVisibilityTooltip', () => {
  it('names the known face as the reason when it is the one withholding', () => {
    expect(linkVisibilityTooltip({ link_visibility: 'auto', has_known_face: true }))
      .toContain('Bekanntes Gesicht')
  })

  it('does not blame a face for an explicit opt-out', () => {
    expect(linkVisibilityTooltip({ link_visibility: 'hidden', has_known_face: false }))
      .not.toContain('Bekanntes Gesicht')
  })

  it('offers to take a released photo back out', () => {
    expect(linkVisibilityTooltip({ link_visibility: 'visible', has_known_face: true }))
      .toContain('wieder ausnehmen')
  })
})
