import { describe, it, expect, beforeEach } from 'vitest'
import {
  anchorKey,
  anchorSelector,
  clearListAnchor,
  focusListAnchor,
  saveListAnchor,
  takeListAnchor,
} from './listAnchor'

describe('listAnchor', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  it('gives a row back exactly once', () => {
    saveListAnchor('dokumente', { kind: 'document', id: 42 })
    expect(takeListAnchor('dokumente')).toEqual({ kind: 'document', id: 42 })
    // Entering the list again from a menu must start unanchored.
    expect(takeListAnchor('dokumente')).toBeNull()
  })

  it('keeps one anchor per list', () => {
    saveListAnchor('dokumente', { kind: 'document', id: 1 })
    saveListAnchor('fotos-alben', { kind: 'album', id: 7 })
    expect(takeListAnchor('fotos-alben')).toEqual({ kind: 'album', id: 7 })
    expect(takeListAnchor('dokumente')).toEqual({ kind: 'document', id: 1 })
  })

  it('replaces the anchor of the same list rather than adding one', () => {
    // Two kinds of row in one list: the user left from exactly one of them.
    saveListAnchor('dokumente', { kind: 'document', id: 1 })
    saveListAnchor('dokumente', { kind: 'collection', id: 5 })
    expect(takeListAnchor('dokumente')).toEqual({ kind: 'collection', id: 5 })
  })

  it('refuses ids and kinds it could not find again', () => {
    saveListAnchor('l', { kind: 'document', id: 0 })
    saveListAnchor('l', { kind: 'document', id: -3 })
    saveListAnchor('l', { kind: 'document', id: 1.5 })
    saveListAnchor('l', { kind: '', id: 3 })
    saveListAnchor('l', { kind: 'a:b', id: 3 })
    expect(takeListAnchor('l')).toBeNull()
  })

  it('survives a corrupted entry', () => {
    sessionStorage.setItem('list_anchor:l', '{oops')
    expect(takeListAnchor('l')).toBeNull()
  })

  it('reads the document list’s old keys once', () => {
    sessionStorage.setItem('documents.listFocus', JSON.stringify({ kind: 'collection', id: 9 }))
    expect(takeListAnchor('dokumente', 'documents')).toEqual({ kind: 'collection', id: 9 })
    expect(takeListAnchor('dokumente', 'documents')).toBeNull()

    sessionStorage.setItem('documents.listFocusId', '11')
    expect(takeListAnchor('dokumente', 'documents')).toEqual({ kind: 'document', id: 11 })
    expect(takeListAnchor('dokumente', 'documents')).toBeNull()
  })

  it('ignores the old keys for other lists', () => {
    sessionStorage.setItem('documents.listFocus', JSON.stringify({ kind: 'document', id: 9 }))
    expect(takeListAnchor('fotos-alben')).toBeNull()
  })

  it('can be dropped without being used', () => {
    saveListAnchor('l', { kind: 'document', id: 4 })
    clearListAnchor('l')
    expect(takeListAnchor('l')).toBeNull()
  })

  it('drops an older build\'s keys with it', () => {
    // A tab upgraded mid-session: those keys would otherwise sit and wait to
    // anchor a visit that entered the list from the menu.
    sessionStorage.setItem('documents.listFocus', JSON.stringify({ kind: 'document', id: 9 }))
    sessionStorage.setItem('documents.listFocusId', '11')
    clearListAnchor('dokumente', 'documents')
    expect(takeListAnchor('dokumente', 'documents')).toBeNull()
  })

  it('builds the marker a row carries', () => {
    expect(anchorKey('document', 42)).toBe('document:42')
    expect(anchorSelector({ kind: 'album', id: 7 })).toBe('[data-anchor="album:7"]')
  })

  it('focuses the row itself when the row can take focus', () => {
    document.body.innerHTML = '<button data-anchor="album:7" id="row">Album</button>'
    const row = focusListAnchor(document, { kind: 'album', id: 7 })
    expect(row?.id).toBe('row')
    expect(document.activeElement).toBe(row)
  })

  it('focuses what is inside when the row itself cannot', () => {
    document.body.innerHTML =
      '<div data-anchor="document:3"><span>meta</span><button id="title">Title</button></div>'
    const row = focusListAnchor(document, { kind: 'document', id: 3 })
    expect(row?.getAttribute('data-anchor')).toBe('document:3')
    expect((document.activeElement as HTMLElement).id).toBe('title')
  })

  it('reports a row that is not there, so the caller can fall back', () => {
    document.body.innerHTML = '<div data-anchor="document:1"></div>'
    expect(focusListAnchor(document, { kind: 'document', id: 2 })).toBeNull()
  })
})
