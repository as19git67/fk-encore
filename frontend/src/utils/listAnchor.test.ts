import { describe, it, expect, beforeEach } from 'vitest'
import {
  anchorKey,
  anchorSaveMark,
  anchorSavedSince,
  anchorSelector,
  clearListAnchor,
  focusListAnchor,
  leavingAnchor,
  parseAnchorKey,
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

  it('reads a row marker back, kinds with a scope included', () => {
    expect(parseAnchorKey('document:42')).toEqual({ kind: 'document', id: 42 })
    expect(parseAnchorKey('photo@msg-3:9')).toEqual({ kind: 'photo@msg-3', id: 9 })
    expect(parseAnchorKey('document:0')).toBeNull()
    expect(parseAnchorKey(':5')).toBeNull()
    expect(parseAnchorKey(undefined)).toBeNull()
  })

  it('tells whether a list saved its own anchor since a mark', () => {
    const mark = anchorSaveMark()
    expect(anchorSavedSince('dokumente', mark)).toBe(false)
    saveListAnchor('dokumente', { kind: 'document', id: 3 })
    expect(anchorSavedSince('dokumente', mark)).toBe(true)
    expect(anchorSavedSince('zaehler', mark)).toBe(false)
    expect(anchorSavedSince('dokumente', anchorSaveMark())).toBe(false)
  })

  describe('leavingAnchor', () => {
    function list(): HTMLElement {
      document.body.innerHTML = `
        <div id="root">
          <div data-anchor="document:1"><button id="b1">Eins</button></div>
          <div data-anchor="document:2" aria-current="true"><button id="b2">Zwei</button></div>
          <div data-anchor="document:3"><button id="b3">Drei</button></div>
          <button id="pane">Öffnen</button>
        </div>
        <button id="outside">Menü</button>`
      return document.getElementById('root')!
    }

    it('prefers the row holding focus', () => {
      const root = list()
      document.getElementById('b3')!.focus()
      expect(leavingAnchor(root, 'document:1')).toEqual({ kind: 'document', id: 3 })
    })

    it('takes the current row when focus is elsewhere — the split pane', () => {
      const root = list()
      document.getElementById('pane')!.focus()
      expect(leavingAnchor(root, 'document:1')).toEqual({ kind: 'document', id: 2 })
    })

    it('falls back to the row last touched while it is still listed', () => {
      const root = list()
      root.querySelector('[aria-current]')!.removeAttribute('aria-current')
      document.getElementById('outside')!.focus()
      expect(leavingAnchor(root, 'document:1')).toEqual({ kind: 'document', id: 1 })
      expect(leavingAnchor(root, 'document:99')).toBeNull()
      expect(leavingAnchor(root, null)).toBeNull()
    })
  })
})
