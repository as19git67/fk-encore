import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeDocumentListFocus,
  consumeListFocus,
  focusDocumentListItem,
  focusListItem,
  rememberCollectionListFocus,
  rememberDocumentListFocus,
  rememberListFocus,
} from './documentListFocus'

describe('document list focus memory', () => {
  beforeEach(() => sessionStorage.clear())

  it('restores an opened document exactly once', () => {
    rememberDocumentListFocus(651)
    expect(consumeDocumentListFocus()).toBe(651)
    expect(consumeDocumentListFocus()).toBeNull()
  })

  it('ignores invalid document ids', () => {
    rememberDocumentListFocus(-1)
    expect(consumeDocumentListFocus()).toBeNull()
  })

  it('scrolls to the list card and restores keyboard focus to its title', () => {
    document.body.innerHTML = `
      <article data-doc-id="650"><button class="document-title">Andere</button></article>
      <article data-doc-id="651"><button class="document-title">Gesucht</button></article>
    `
    const card = document.querySelector<HTMLElement>('[data-doc-id="651"]')!
    card.scrollIntoView = vi.fn()

    expect(focusDocumentListItem(document, 651)).toBe(card)
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect(document.activeElement?.textContent).toBe('Gesucht')
  })

  it('focuses a keyboard-accessible grid card itself', () => {
    document.body.innerHTML = '<article data-doc-id="651" tabindex="0">Gesucht</article>'
    const card = document.querySelector<HTMLElement>('[data-doc-id="651"]')!
    card.scrollIntoView = vi.fn()

    focusDocumentListItem(document, 651)

    expect(document.activeElement).toBe(card)
  })
})

describe('Sammelmappen rows as a return anchor', () => {
  beforeEach(() => sessionStorage.clear())

  it('remembers an opened folder and reads it back once', () => {
    rememberCollectionListFocus(12)
    expect(consumeListFocus()).toEqual({ kind: 'collection', id: 12 })
    expect(consumeListFocus()).toBeNull()
  })

  it('keeps the two kinds apart', () => {
    // A folder anchor must not be mistaken for a document with the same id —
    // the two id spaces are unrelated, and the wrong row would be scrolled to.
    rememberCollectionListFocus(651)
    expect(consumeDocumentListFocus()).toBeNull()
  })

  it('holds one anchor, because the user left from one row', () => {
    rememberDocumentListFocus(651)
    rememberCollectionListFocus(12)
    expect(consumeListFocus()).toEqual({ kind: 'collection', id: 12 })
    expect(consumeListFocus()).toBeNull()
  })

  it('scrolls the folder row into view and focuses it', () => {
    document.body.innerHTML = `
      <button data-collection-id="11" class="collection-row">Andere Mappe</button>
      <button data-collection-id="12" class="collection-row">Steuer 2024</button>
    `
    const row = document.querySelector<HTMLElement>('[data-collection-id="12"]')!
    row.scrollIntoView = vi.fn()

    expect(focusListItem(document, { kind: 'collection', id: 12 })).toBe(row)
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect(document.activeElement).toBe(row)
  })

  it('reports the row as gone when it is no longer on screen', () => {
    // Deleted, filtered away, or on a page that has not been loaded back yet —
    // the caller then falls back to the plain scroll offset.
    document.body.innerHTML = '<button data-collection-id="11" class="collection-row">Andere</button>'
    expect(focusListItem(document, { kind: 'collection', id: 12 })).toBeNull()
  })

  it('rejects a folder id that cannot be one', () => {
    rememberListFocus('collection', 0)
    expect(consumeListFocus()).toBeNull()
  })
})

describe('anchor stored by an older tab', () => {
  beforeEach(() => sessionStorage.clear())

  it('still returns to the document it named', () => {
    // A tab open across the deploy carries the pre-kind key; dropping it would
    // send that user back to the top of the list for no visible reason.
    sessionStorage.setItem('documents.listFocusId', '651')
    expect(consumeListFocus()).toEqual({ kind: 'document', id: 651 })
    expect(consumeListFocus()).toBeNull()
  })

  it('ignores an unusable legacy value', () => {
    sessionStorage.setItem('documents.listFocusId', 'nope')
    expect(consumeListFocus()).toBeNull()
  })
})
