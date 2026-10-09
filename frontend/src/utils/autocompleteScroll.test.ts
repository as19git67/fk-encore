import { describe, expect, it, vi } from 'vitest'
import { scrollSelectedOptionIntoView } from './autocompleteScroll'

function overlayWith(selectedIndex: number | null) {
  const overlay = document.createElement('div')
  const list = document.createElement('ul')
  overlay.appendChild(list)
  const items = ['a', 'b', 'c'].map((label, i) => {
    const li = document.createElement('li')
    li.textContent = label
    if (i === selectedIndex) li.setAttribute('data-p-selected', 'true')
    li.scrollIntoView = vi.fn()
    list.appendChild(li)
    return li
  })
  return { overlay, items }
}

describe('scrollSelectedOptionIntoView', () => {
  it('scrolls the selected list entry to the centre', () => {
    const { overlay, items } = overlayWith(2)
    scrollSelectedOptionIntoView({ overlay })
    expect(items[2]!.scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(items[0]!.scrollIntoView).not.toHaveBeenCalled()
  })

  it('does nothing without a selection, without an overlay or without an instance', () => {
    const { overlay, items } = overlayWith(null)
    scrollSelectedOptionIntoView({ overlay })
    for (const li of items) expect(li.scrollIntoView).not.toHaveBeenCalled()
    expect(() => scrollSelectedOptionIntoView({ overlay: null })).not.toThrow()
    expect(() => scrollSelectedOptionIntoView(null)).not.toThrow()
    expect(() => scrollSelectedOptionIntoView(undefined)).not.toThrow()
  })
})
