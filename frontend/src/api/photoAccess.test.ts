// `/photos/file/*` no longer serves anonymous callers, and an <img src>
// cannot carry an Authorization header. These pin which credential ends up
// on a photo URL — the wrong answer here either breaks every thumbnail in
// the app or hands a share link more than the one album it stands for.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setActiveShareToken, withPhotoAccessParams } from './client'

beforeEach(() => {
  localStorage.clear()
  setActiveShareToken(null)
})

afterEach(() => {
  localStorage.clear()
  setActiveShareToken(null)
})

describe('withPhotoAccessParams', () => {
  it('leaves the URL alone when the visitor has no credential', () => {
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe('/api/photos/file/a.jpg')
  })

  it('appends the session token for a signed-in user', () => {
    localStorage.setItem('auth_token', 'sess-123')
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe(
      '/api/photos/file/a.jpg?token=sess-123',
    )
  })

  it('appends the share token while a share link is being viewed', () => {
    setActiveShareToken('share-abc')
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe(
      '/api/photos/file/a.jpg?share=share-abc',
    )
  })

  it('sends both when a signed-in user opens a share link', () => {
    // The two are independent grants. An account with no photo rights — a
    // finance-only user — still has to be able to open a link sent to them,
    // so the session must not crowd out the token that authorizes the album.
    localStorage.setItem('auth_token', 'sess-123')
    setActiveShareToken('share-abc')
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe(
      '/api/photos/file/a.jpg?token=sess-123&share=share-abc',
    )
  })

  it('joins onto a URL that already carries query parameters', () => {
    setActiveShareToken('share-abc')
    expect(withPhotoAccessParams('/api/photos/file/a.jpg?w=400')).toBe(
      '/api/photos/file/a.jpg?w=400&share=share-abc',
    )
  })

  it('escapes a token so it cannot inject further parameters', () => {
    setActiveShareToken('a&b=c')
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe(
      '/api/photos/file/a.jpg?share=a%26b%3Dc',
    )
  })

  it('stops appending the share token once the view is left', () => {
    setActiveShareToken('share-abc')
    setActiveShareToken(null)
    expect(withPhotoAccessParams('/api/photos/file/a.jpg')).toBe('/api/photos/file/a.jpg')
  })
})
