import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeDocumentListFocus,
  focusDocumentListItem,
  rememberDocumentListFocus,
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
