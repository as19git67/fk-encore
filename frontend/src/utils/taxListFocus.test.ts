import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeTaxListFocus,
  focusTaxListItem,
  rememberTaxListFocus,
  taxEntryKey,
} from './taxListFocus'

describe('tax list focus memory', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
  })

  it('restores an opened row exactly once', () => {
    rememberTaxListFocus('werbungskosten', 651)
    expect(consumeTaxListFocus()).toEqual({ section: 'werbungskosten', id: 651 })
    expect(consumeTaxListFocus()).toBeNull()
  })

  it('ignores invalid ids and empty sections', () => {
    rememberTaxListFocus('werbungskosten', -1)
    expect(consumeTaxListFocus()).toBeNull()
    rememberTaxListFocus('', 651)
    expect(consumeTaxListFocus()).toBeNull()
  })

  it('survives a corrupt storage entry', () => {
    sessionStorage.setItem('documents.taxListFocus', '{not json')
    expect(consumeTaxListFocus()).toBeNull()
  })

  it('does not share its anchor with the plain document list', () => {
    rememberTaxListFocus('werbungskosten', 651)
    expect(sessionStorage.getItem('documents.listFocus')).toBeNull()
  })

  it('scrolls the anchored row into view and focuses it', () => {
    document.body.innerHTML = `
      <div data-doc-id="650" data-tax-entry="${taxEntryKey('spenden', 650)}" tabindex="0">Andere</div>
      <div data-doc-id="651" data-tax-entry="${taxEntryKey('werbungskosten', 651)}" tabindex="0">Gesucht</div>
    `
    const card = document.querySelector<HTMLElement>('[data-doc-id="651"]')!
    card.scrollIntoView = vi.fn()

    expect(focusTaxListItem(document, { section: 'werbungskosten', id: 651 })).toBe(card)
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' })
    expect(document.activeElement).toBe(card)
  })

  it('falls back to another section when the document moved', () => {
    document.body.innerHTML = `
      <div data-doc-id="651" data-tax-entry="${taxEntryKey('spenden', 651)}" tabindex="0">Verschoben</div>
    `
    const card = document.querySelector<HTMLElement>('[data-doc-id="651"]')!
    card.scrollIntoView = vi.fn()

    expect(focusTaxListItem(document, { section: 'werbungskosten', id: 651 })).toBe(card)
  })

  it('reports a miss when the document is gone entirely', () => {
    document.body.innerHTML = '<div data-doc-id="650" tabindex="0">Andere</div>'
    expect(focusTaxListItem(document, { section: 'werbungskosten', id: 651 })).toBeNull()
  })
})
